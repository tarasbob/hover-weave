/**
 * Headless autopilot tiers shared by the test suites (and one-off calibration
 * harnesses). Three skill rungs, boost-free by design (walls must measure
 * track scaling, not economy skill — see the roadmap decision log):
 *
 * - greedy:      single-band nearest-workable-gap chaser (~1.35 s of track).
 * - lookahead:   live lane×slice reachability DP (~2.4 s), never commits to a
 *                corridor that dead-ends.
 * - superhuman:  TAS-style rollout search over the exact steering dynamics —
 *                only dies when *no* input stream survives its horizon.
 */
import { CRAFT, STEER, TRACK } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { quantizeAxis } from "../src/game/core/replay";
import { Motion, type ObstacleSpec } from "../src/game/core/types";
import type { SimWorld } from "../src/game/core/world";
import { blockedRanges } from "../src/game/track/validator";

export function specOf(o: SimWorld["obstacles"][number]): ObstacleSpec {
  return {
    kind: o.kind, s: o.s, x: o.x, y: o.y, hx: o.hx, hy: o.hy, hs: o.hs,
    yaw: o.yaw, motion: o.motion, m0: o.m0, m1: o.m1, m2: o.m2,
    inner: o.inner, collidable: o.collidable,
  };
}

export interface PilotOpts {
  /** Hold boost whenever the tank allows it. */
  boost?: boolean;
}

/** Lateral gaps between worst-case obstacle envelopes inside an s-band. */
export function scanGaps(
  world: SimWorld,
  bandStart: number,
  bandEnd: number,
): [number, number][] {
  const blocked: [number, number][] = [];
  for (const o of world.obstacles) {
    if (!o.active || !o.collidable) continue;
    const sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx + 2;
    if (o.cs + sExt < bandStart || o.cs - sExt > bandEnd) continue;
    const restY = o.motion === Motion.FallY ? o.m1 : o.cy;
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    for (const r of blockedRanges(specOf(o))) blocked.push(r);
  }
  blocked.sort((a, b) => a[0] - b[0]);

  const gaps: [number, number][] = [];
  let cursor = -TRACK.X_LIMIT;
  for (const [b0, b1] of blocked) {
    if (b0 > cursor + 2) gaps.push([cursor, b0]);
    cursor = Math.max(cursor, b1);
  }
  if (cursor < TRACK.X_LIMIT - 2) gaps.push([cursor, TRACK.X_LIMIT]);
  return gaps;
}

export function steerToward(world: SimWorld, input: InputState, targetX: number): void {
  const err = targetX - world.x;
  const maxLat = Math.max(10, world.speed) * STEER.RATIO;
  const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
  input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
}

/** Best single-band gap target (shared by greedy and fallbacks). */
export function greedyTargetX(world: SimWorld): number {
  const craftS = world.distance;
  const gaps = scanGaps(world, craftS + 2, craftS + 10 + Math.max(world.speed, 20) * 1.35);
  let targetX = world.x;
  let bestCost = Infinity;
  for (const [g0, g1] of gaps) {
    const gx = Math.min(Math.max(world.x, g0 + 1.2), g1 - 1.2);
    const width = g1 - g0;
    const cost = Math.abs(gx - world.x) - Math.min(width, 10) * 0.4;
    if (cost < bestCost) {
      bestCost = cost;
      targetX = gx;
    }
  }
  return targetX;
}

/** Tier 1 "greedy": single-band nearest-workable-gap chaser. */
export function autopilot(world: SimWorld, input: InputState, opts: PilotOpts = {}): void {
  steerToward(world, input, greedyTargetX(world));
  input.boost = opts.boost ? (world.boosting ? true : world.energy > 14) : false;
}

/**
 * Tier 2 "lookahead": a live reachability planner. Rasterizes worst-case
 * obstacle envelopes into lane × slice cells over several speed-scaled bands
 * ahead, runs a forward/backward connectivity DP (like the validator, but on
 * the live field), and steers toward the surviving corridor — so it never
 * commits to a near gap that dead-ends, which is exactly how greedy dies.
 */
export function lookaheadPilot(
  world: SimWorld,
  input: InputState,
  mem: { targetX: number } = { targetX: 0 },
): void {
  const craftS = world.distance;
  const speed = Math.max(world.speed, 20);
  const DS = 4;
  const LANE = 0.5;
  const LANES = Math.round((TRACK.X_LIMIT * 2) / LANE) + 1;
  const laneX = (l: number) => -TRACK.X_LIMIT + l * LANE;
  // Plan ~2.4 s ahead (greedy reads ~1.35 s and cannot see dead-ends).
  const horizon = 10 + speed * 2.4;
  const slices = Math.min(80, Math.ceil(horizon / DS));

  const blocked: Uint8Array[] = [];
  for (let k = 0; k < slices; k++) blocked.push(new Uint8Array(LANES));
  const band0 = craftS + 2;
  for (const o of world.obstacles) {
    if (!o.active || !o.collidable) continue;
    const sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx + 2;
    if (o.cs + sExt < band0 || o.cs - sExt > band0 + slices * DS) continue;
    const restY = o.motion === Motion.FallY ? o.m1 : o.cy;
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    const k0 = Math.max(0, Math.floor((o.cs - sExt - band0) / DS));
    const k1 = Math.min(slices - 1, Math.floor((o.cs + sExt - band0) / DS));
    if (k1 < k0) continue;
    for (const [x0, x1] of blockedRanges(specOf(o))) {
      const l0 = Math.max(0, Math.floor((x0 + TRACK.X_LIMIT) / LANE));
      const l1 = Math.min(LANES - 1, Math.ceil((x1 + TRACK.X_LIMIT) / LANE));
      for (let k = k0; k <= k1; k++) {
        const row = blocked[k];
        for (let l = l0; l <= l1; l++) row[l] = 1;
      }
    }
  }

  // Forward reachability from the craft (sustainable lateral slope ~0.4).
  const reachLanes = Math.max(1, Math.round((DS * 0.4) / LANE));
  const cl = Math.round((world.x + TRACK.X_LIMIT) / LANE);
  const fwd: Uint8Array[] = [];
  const start = new Uint8Array(LANES);
  for (let l = Math.max(0, cl - 2); l <= Math.min(LANES - 1, cl + 2); l++) {
    if (!blocked[0][l]) start[l] = 1;
  }
  if (!start.some((v) => v)) start[Math.max(0, Math.min(LANES - 1, cl))] = 1;
  fwd.push(start);
  for (let k = 1; k < slices; k++) {
    const prev = fwd[k - 1];
    const cur = new Uint8Array(LANES);
    for (let l = 0; l < LANES; l++) {
      if (blocked[k][l]) continue;
      const lo = Math.max(0, l - reachLanes);
      const hi = Math.min(LANES - 1, l + reachLanes);
      for (let p = lo; p <= hi; p++) {
        if (prev[p]) {
          cur[l] = 1;
          break;
        }
      }
    }
    fwd.push(cur);
  }

  // Deepest reachable slice, then walk one greedy step back toward the craft
  // picking centered-in-corridor lanes — the near-term steering target is the
  // path cell a few slices ahead, so commitment always leads somewhere.
  let deepest = 0;
  for (let k = slices - 1; k >= 0; k--) {
    let any = false;
    for (let l = 0; l < LANES; l++) {
      if (fwd[k][l]) {
        any = true;
        break;
      }
    }
    if (any) {
      deepest = k;
      break;
    }
  }
  // Backward pass: lanes that still lead to the deepest slice.
  const alive: Uint8Array[] = new Array(deepest + 1);
  alive[deepest] = fwd[deepest];
  for (let k = deepest - 1; k >= 0; k--) {
    const next = alive[k + 1];
    const cur = new Uint8Array(LANES);
    for (let l = 0; l < LANES; l++) {
      if (!fwd[k][l]) continue;
      const lo = Math.max(0, l - reachLanes);
      const hi = Math.min(LANES - 1, l + reachLanes);
      for (let n = lo; n <= hi; n++) {
        if (next[n]) {
          cur[l] = 1;
          break;
        }
      }
    }
    alive[k] = cur;
  }

  // Steering target: on the slice ~10 m out, the surviving lane whose local
  // corridor is widest — tie-broken toward the craft and (hysteresis) toward
  // the previous frame's choice so the pilot never dithers between corridors.
  const kTarget = Math.min(deepest, Math.max(2, Math.round(10 / DS)));
  let targetX = world.x;
  {
    const row = alive[kTarget];
    let bestScore = -Infinity;
    let runStart = -1;
    for (let l = 0; l <= LANES; l++) {
      const on = l < LANES && row[l];
      if (on && runStart === -1) runStart = l;
      if (!on && runStart !== -1) {
        const x0 = laneX(runStart);
        const x1 = laneX(l - 1);
        const width = x1 - x0;
        const cx = width > 2.4
          ? Math.min(Math.max(world.x, x0 + 1.2), x1 - 1.2)
          : (x0 + x1) / 2;
        const score =
          Math.min(width, 10) * 0.55 -
          Math.abs(cx - world.x) * 0.5 -
          Math.abs(cx - mem.targetX) * 0.3;
        if (score > bestScore) {
          bestScore = score;
          targetX = cx;
        }
        runStart = -1;
      }
    }
  }

  mem.targetX = targetX;
  steerToward(world, input, targetX);
  input.boost = false;
}

interface Envelope {
  s0: number;
  s1: number;
  x0: number;
  x1: number;
}

const ROLL_DT = 1 / 60;
// Candidates pre-quantized so rollout dynamics match what the sim executes
// (the world consumes a 1/127-step axis since input recording landed).
const ROLL_PHASE1 = [-1, -0.55, -0.22, 0, 0.22, 0.55, 1].map(quantizeAxis);
const ROLL_PHASE2 = [-1, -0.4, 0, 0.4, 1].map(quantizeAxis);
const envScratch: Envelope[] = [];

function gatherEnvelopes(world: SimWorld, out: Envelope[], sEnd: number): void {
  out.length = 0;
  const s0 = world.distance - 4;
  for (const o of world.obstacles) {
    if (!o.active || !o.collidable) continue;
    // Along-track worst-case extent (mirrors the validator's sHalfExtent).
    let sExt: number;
    if (o.motion === Motion.RotateYaw) sExt = Math.hypot(o.hx, o.hs);
    else if (o.motion === Motion.OrbitXZ) sExt = Math.abs(o.m0) + Math.max(o.hx, o.hs);
    else {
      sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
    }
    if (o.s + sExt < s0 || o.s - sExt > sEnd) continue;
    const restY = o.motion === Motion.FallY ? o.m1 : o.cy;
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    // Tight slack: the search shaves far closer than the validator plans.
    for (const [x0, x1] of blockedRanges(specOf(o), 0.06)) {
      out.push({ s0: o.s - sExt - 1, s1: o.s + sExt + 1, x0, x1 });
    }
  }
  out.sort((a, b) => a.s0 - b.s0);
}

/** Roll the exact lateral dynamics forward; survival steps + min clearance. */
function rollout(
  envs: Envelope[],
  sStart: number,
  xStart: number,
  vStart: number,
  speed: number,
  a1: number,
  a2: number,
  steps: number,
): { survived: number; clearance: number } {
  let s = sStart;
  let x = xStart;
  let v = vStart;
  const maxLat = Math.max(10, speed) * STEER.RATIO;
  let clearance = Infinity;
  for (let i = 0; i < steps; i++) {
    const axis = i < steps / 2 ? a1 : a2;
    v += axis * Math.max(10, speed) * STEER.ACCEL_K * ROLL_DT;
    const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
    v *= Math.exp(-drag * ROLL_DT);
    if (v > maxLat) v = maxLat;
    else if (v < -maxLat) v = -maxLat;
    x += v * ROLL_DT;
    if (x < -TRACK.X_LIMIT) {
      x = -TRACK.X_LIMIT;
      v = Math.max(0, v) * 0.4;
    } else if (x > TRACK.X_LIMIT) {
      x = TRACK.X_LIMIT;
      v = Math.min(0, v) * 0.4;
    }
    s += speed * ROLL_DT;
    for (const e of envs) {
      if (e.s0 > s) break;
      if (e.s1 < s) continue;
      if (x > e.x0 && x < e.x1) return { survived: i, clearance: 0 };
      const c = Math.min(Math.abs(x - e.x0), Math.abs(x - e.x1));
      if (c < clearance) clearance = c;
    }
  }
  return { survived: steps, clearance };
}

/**
 * Tier 3 "superhuman": TAS-style forward rollout search. Every control tick
 * it simulates the craft's exact lateral dynamics through a family of
 * two-phase input candidates against worst-case obstacle envelopes and picks
 * the sequence that survives longest (ties: clearance). No plan, no model
 * mismatch — it only dies when *no* input stream survives its horizon, which
 * is precisely the overdrive wall Phase 2 is supposed to build.
 */
export function superhumanPilot(world: SimWorld, input: InputState): void {
  const speed = Math.max(world.speed, 10);
  const horizonS = 1.9;
  const steps = Math.round(horizonS / ROLL_DT);
  gatherEnvelopes(world, envScratch, world.distance + speed * horizonS + 12);

  let bestAxis = 0;
  let bestSurvived = -1;
  let bestClearance = -1;
  for (const a1 of ROLL_PHASE1) {
    for (const a2 of ROLL_PHASE2) {
      const r = rollout(
        envScratch, world.distance, world.x, world.latVel, speed, a1, a2, steps,
      );
      const better =
        r.survived > bestSurvived ||
        (r.survived === bestSurvived && r.clearance > bestClearance);
      if (better) {
        bestSurvived = r.survived;
        bestClearance = r.clearance;
        bestAxis = a1;
      }
    }
  }
  input.axis = bestAxis;
  input.boost = false;
}
