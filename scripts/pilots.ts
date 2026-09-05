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
import { CRAFT, FIXED_DT, STEER, TRACK } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import type { RunConfig } from "../src/game/core/modes";
import { quantizeAxis } from "../src/game/core/replay";
import { createRng, type Rng } from "../src/game/core/rng";
import { Motion, type ObstacleKind, type ObstacleSpec, type RunStatus } from "../src/game/core/types";
import { SimWorld } from "../src/game/core/world";
import { blockedRanges } from "../src/game/track/validator";

export function specOf(o: SimWorld["obstacles"][number]): ObstacleSpec {
  return {
    kind: o.kind, s: o.s, x: o.x, y: o.y, hx: o.hx, hy: o.hy, hs: o.hs,
    yaw: o.yaw, motion: o.motion, m0: o.m0, m1: o.m1, m2: o.m2,
    inner: o.inner, collidable: o.collidable,
    // Skyhook air rings are collidable-but-noValidate: without this flag the
    // pilots would dodge phantom ground blocks under geometry that only
    // exists at altitude.
    noValidate: o.kind === "ring" && o.y - o.hy > CRAFT.Y_MAX ? true : undefined,
  };
}

export interface PilotOpts {
  /** Hold boost whenever the tank allows it. */
  boost?: boolean;
}

/** Worst-case resting height (mirrors the validator's vertical logic). */
function pilotRestY(o: SimWorld["obstacles"][number]): number {
  if (o.motion === Motion.FallY) return o.m1;
  if (o.motion === Motion.Serpent) return o.y - o.m2;
  return o.cy;
}

/** Lateral gaps between worst-case obstacle envelopes inside an s-band. */
export function scanGaps(
  world: SimWorld,
  bandStart: number,
  bandEnd: number,
): [number, number][] {
  const blocked: [number, number][] = [];
  const off = world.courseOffsetAt((bandStart + bandEnd) / 2);
  for (const o of world.obstacles) {
    if (!o.active || !o.collidable) continue;
    const sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx + 2;
    if (o.cs + sExt < bandStart || o.cs - sExt > bandEnd) continue;
    const restY = pilotRestY(o);
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    // Read lateral gaps in the road's local frame. Broad bends otherwise
    // make successive rows look like overlapping walls in absolute x.
    const bend = off - world.courseOffsetAt(o.s);
    for (const [left, right] of blockedRanges(specOf(o))) {
      const lo = Math.max(off - TRACK.X_LIMIT, left + bend);
      const hi = Math.min(off + TRACK.X_LIMIT, right + bend);
      if (lo < hi) blocked.push([lo, hi]);
    }
  }
  blocked.sort((a, b) => a[0] - b[0]);

  // The playable band follows the winding course edges.
  const gaps: [number, number][] = [];
  let cursor = off - TRACK.X_LIMIT;
  for (const [b0, b1] of blocked) {
    if (b0 > cursor + 2) gaps.push([cursor, b0]);
    cursor = Math.max(cursor, b1);
  }
  if (cursor < off + TRACK.X_LIMIT - 2) gaps.push([cursor, off + TRACK.X_LIMIT]);
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
  // Frame widened by the course amplitude so a drifting corridor still fits.
  const FRAME_HALF = TRACK.X_LIMIT + 18;
  const LANES = Math.round((FRAME_HALF * 2) / LANE) + 1;
  const frame0 = world.courseOffsetAt(craftS) - FRAME_HALF;
  const laneX = (l: number) => frame0 + l * LANE;
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
    const restY = pilotRestY(o);
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    const k0 = Math.max(0, Math.floor((o.cs - sExt - band0) / DS));
    const k1 = Math.min(slices - 1, Math.floor((o.cs + sExt - band0) / DS));
    if (k1 < k0) continue;
    for (const [x0, x1] of blockedRanges(specOf(o))) {
      const l0 = Math.max(0, Math.floor((x0 - frame0) / LANE));
      const l1 = Math.min(LANES - 1, Math.ceil((x1 - frame0) / LANE));
      for (let k = k0; k <= k1; k++) {
        const row = blocked[k];
        for (let l = l0; l <= l1; l++) row[l] = 1;
      }
    }
  }
  // Rasterize the course edges: lanes outside offset ± X_LIMIT at each
  // slice are unreachable in the sim.
  for (let k = 0; k < slices; k++) {
    const off = world.courseOffsetAt(band0 + k * DS);
    const lo = Math.floor((off - TRACK.X_LIMIT - frame0) / LANE);
    const hi = Math.ceil((off + TRACK.X_LIMIT - frame0) / LANE);
    const row = blocked[k];
    for (let l = 0; l < LANES; l++) {
      if (l < lo || l > hi) row[l] = 1;
    }
  }

  // Forward reachability from the craft (sustainable lateral slope ~0.4).
  const reachLanes = Math.max(1, Math.round((DS * 0.4) / LANE));
  const cl = Math.round((world.x - frame0) / LANE);
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

// The sim's exact fixed step: rollout dynamics must integrate identically,
// or the accumulated lateral error dwarfs the razor margins the search shaves.
const ROLL_DT = 1 / 120;
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
    const restY = pilotRestY(o);
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    // Tight slack: the search shaves far closer than the validator plans.
    // (0.06 pre-course; the winding drift adds real model error over the
    // rollout horizon, so the margin carries a little more.)
    for (const [x0, x1] of blockedRanges(specOf(o), 0.12)) {
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
  offsetAt: (s: number) => number,
  switchFrac = 0.5,
): { survived: number; clearance: number } {
  let s = sStart;
  let x = xStart;
  let v = vStart;
  const maxLat = Math.max(10, speed) * STEER.RATIO;
  let clearance = Infinity;
  const switchAt = steps * switchFrac;
  for (let i = 0; i < steps; i++) {
    const axis = i < switchAt ? a1 : a2;
    v += axis * Math.max(10, speed) * STEER.ACCEL_K * ROLL_DT;
    const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
    v *= Math.exp(-drag * ROLL_DT);
    if (v > maxLat) v = maxLat;
    else if (v < -maxLat) v = -maxLat;
    x += v * ROLL_DT;
    s += speed * ROLL_DT;
    // Leaving either course edge is fatal; never plan on a barrier rebound.
    const off = offsetAt(s);
    const edgeClearance = TRACK.X_LIMIT - Math.abs(x - off);
    if (edgeClearance <= 0) return { survived: i, clearance: 0 };
    clearance = Math.min(clearance, edgeClearance);
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
export function superhumanPilot(
  world: SimWorld,
  input: InputState,
  options: { horizonSeconds?: number; switchFractions?: readonly number[] } = {},
): void {
  // Decide at 60 Hz (hold the axis on odd sim steps): exact-step rollouts at
  // a deeper horizon doubled the search cost — this claws the budget back.
  if (Math.round(world.time / (1 / 120)) % 2 === 1) return;
  const speed = Math.max(world.speed, 10);
  // 2.4 s: the winding course + denser pattern pool punish the old 1.9 s
  // commitment window (the TAS could get walled after a forced retreat).
  const horizonS = options.horizonSeconds ?? 2.4;
  const steps = Math.round(horizonS / ROLL_DT);
  gatherEnvelopes(world, envScratch, world.distance + speed * horizonS + 12);
  const offsetAt = (s: number) => world.courseOffsetAt(s);

  let bestAxis = 0;
  let bestScore = -Infinity;
  let bestSurvived = -1;
  const search = (switchFrac: number) => {
    for (const a1 of ROLL_PHASE1) {
      for (const a2 of ROLL_PHASE2) {
        const r = rollout(
          envScratch, world.distance, world.x, world.latVel, speed, a1, a2, steps, offsetAt,
          switchFrac,
        );
        // Clearance is worth a few virtual steps: prefer lines with real
        // margin over razor shaves when both survive the horizon.
        const score = r.survived + Math.min(r.clearance, 2.5) * 4;
        if (score > bestScore) {
          bestScore = score;
          bestSurvived = r.survived;
          bestAxis = a1;
        }
      }
    }
  };
  // Classic half-split first; if nothing fully survives, widen the search
  // with an early-jink shape — the winding course + denser pattern pool
  // produce funnel entries the single-shape search could not thread.
  for (const fraction of options.switchFractions ?? [0.5, 0.25]) {
    search(fraction);
    if (bestSurvived >= steps) break;
  }
  input.axis = bestAxis;
  input.boost = false;
}

// --- Restricted-observation synthetic pilots --------------------------------

/**
 * An ordered stress-model configuration, not a claim about a human population.
 * Every decision is made from a noisy snapshot of currently evaluated geometry
 * inside `observationHorizonSeconds`; generator metadata and solved paths are
 * deliberately absent.
 */
export interface SyntheticPilotProfile {
  id: string;
  observationHorizonSeconds: number;
  decisionHz: number;
  latencySeconds: number;
  observationNoiseMeters: number;
  motorNoiseAxis: number;
  /** Number of evenly spaced axis values, including -1 and +1. */
  axisLevels: number;
  planningSlices: number;
  laneWidth: number;
  safetyMargin: number;
  /** Fraction of the physical lateral-speed envelope assumed reachable. */
  reachFraction: number;
  /** Seconds ahead on the selected path used as the immediate steering aim. */
  targetLeadSeconds: number;
  steeringGain: number;
  targetSmoothing: number;
}

function validateSyntheticProfile(profile: SyntheticPilotProfile): SyntheticPilotProfile {
  const positive: [keyof SyntheticPilotProfile, number][] = [
    ["observationHorizonSeconds", profile.observationHorizonSeconds],
    ["decisionHz", profile.decisionHz],
    ["axisLevels", profile.axisLevels],
    ["planningSlices", profile.planningSlices],
    ["laneWidth", profile.laneWidth],
    ["reachFraction", profile.reachFraction],
    ["targetLeadSeconds", profile.targetLeadSeconds],
    ["steeringGain", profile.steeringGain],
  ];
  for (const [name, value] of positive) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`synthetic profile ${profile.id}: ${name} must be positive`);
    }
  }
  if (!Number.isInteger(profile.axisLevels) || profile.axisLevels < 2) {
    throw new RangeError(`synthetic profile ${profile.id}: axisLevels must be an integer >= 2`);
  }
  if (!Number.isInteger(profile.planningSlices) || profile.planningSlices < 2) {
    throw new RangeError(`synthetic profile ${profile.id}: planningSlices must be an integer >= 2`);
  }
  for (const [name, value] of [
    ["latencySeconds", profile.latencySeconds],
    ["observationNoiseMeters", profile.observationNoiseMeters],
    ["motorNoiseAxis", profile.motorNoiseAxis],
    ["safetyMargin", profile.safetyMargin],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`synthetic profile ${profile.id}: ${name} must be non-negative`);
    }
  }
  if (
    !Number.isFinite(profile.targetSmoothing) ||
    profile.targetSmoothing < 0 ||
    profile.targetSmoothing >= 1
  ) {
    throw new RangeError(`synthetic profile ${profile.id}: targetSmoothing must be in [0, 1)`);
  }
  return Object.freeze({ ...profile });
}

/** Define a checked profile or derive one from an existing stress model. */
export function defineSyntheticPilotProfile(
  profile: SyntheticPilotProfile,
  overrides: Partial<SyntheticPilotProfile> = {},
): SyntheticPilotProfile {
  return validateSyntheticProfile({ ...profile, ...overrides });
}

const SYNTHETIC_PROFILE_BASE: SyntheticPilotProfile = {
  id: "synthetic-base",
  observationHorizonSeconds: 1,
  decisionHz: 8,
  latencySeconds: 0.12,
  observationNoiseMeters: 0.3,
  motorNoiseAxis: 0.08,
  axisLevels: 5,
  planningSlices: 6,
  laneWidth: 2,
  safetyMargin: 0.9,
  reachFraction: 0.55,
  targetLeadSeconds: 0.3,
  steeringGain: 0.26,
  targetSmoothing: 0.3,
};

export const MODELED_NOVICE_PROFILE = defineSyntheticPilotProfile(SYNTHETIC_PROFILE_BASE, {
  id: "modeled-novice",
  observationHorizonSeconds: 0.7,
  decisionHz: 5,
  latencySeconds: 0.18,
  observationNoiseMeters: 0.55,
  motorNoiseAxis: 0.14,
  axisLevels: 3,
  planningSlices: 4,
  laneWidth: 2.5,
  safetyMargin: 1.25,
  reachFraction: 0.4,
  targetLeadSeconds: 0.22,
  steeringGain: 0.2,
  targetSmoothing: 0.52,
});

export const MODELED_REACTIVE_PROFILE = defineSyntheticPilotProfile(SYNTHETIC_PROFILE_BASE, {
  id: "modeled-reactive",
  observationHorizonSeconds: 1.3,
  decisionHz: 10,
  latencySeconds: 0.1,
  observationNoiseMeters: 0.24,
  motorNoiseAxis: 0.065,
  axisLevels: 7,
  planningSlices: 7,
  laneWidth: 1.5,
  safetyMargin: 0.9,
  reachFraction: 0.62,
  targetLeadSeconds: 0.34,
  steeringGain: 0.26,
  targetSmoothing: 0.3,
});

export const MODELED_INTERMEDIATE_PROFILE = defineSyntheticPilotProfile(SYNTHETIC_PROFILE_BASE, {
  id: "modeled-intermediate",
  observationHorizonSeconds: 2.1,
  decisionHz: 15,
  latencySeconds: 0.05,
  observationNoiseMeters: 0.08,
  motorNoiseAxis: 0.025,
  axisLevels: 17,
  planningSlices: 11,
  laneWidth: 1,
  safetyMargin: 0.65,
  reachFraction: 0.78,
  targetLeadSeconds: 0.48,
  steeringGain: 0.3,
  targetSmoothing: 0.16,
});

export const MODELED_SYNTHETIC_PROFILES = Object.freeze({
  novice: MODELED_NOVICE_PROFILE,
  reactive: MODELED_REACTIVE_PROFILE,
  intermediate: MODELED_INTERMEDIATE_PROFILE,
});

export interface SyntheticObstacleObservation {
  id: number;
  kind: ObstacleKind;
  x: number;
  s: number;
  y: number;
  hx: number;
  hy: number;
  hs: number;
  yaw: number;
  inner: number;
}

export interface SyntheticObservation {
  time: number;
  x: number;
  latVel: number;
  distance: number;
  speed: number;
  horizonMeters: number;
  obstacles: SyntheticObstacleObservation[];
  /** Visible course centers sampled at each planning slice. */
  courseOffsets: number[];
}

const symmetricNoise = (rng: Rng, amplitude: number): number =>
  amplitude === 0 ? 0 : rng.range(-amplitude, amplitude);

/**
 * Build the only state exposed to a synthetic policy. It contains live,
 * render-equivalent transforms in a bounded forward window. It never reads
 * chunk paths, validator ranges, generator state, future RNG, or authored
 * motion parameters.
 */
export function observeSyntheticWorld(
  world: SimWorld,
  profile: SyntheticPilotProfile,
  rng: Rng,
): SyntheticObservation {
  const speed = Math.max(20, world.speed);
  const horizonMeters = 8 + speed * profile.observationHorizonSeconds;
  const distance = world.distance + symmetricNoise(rng, profile.observationNoiseMeters * 0.15);
  const obstacles: SyntheticObstacleObservation[] = [];
  for (const obstacle of world.obstacles) {
    if (!obstacle.active || !obstacle.collidable || obstacle.kind === "decor") continue;
    const cos = Math.abs(Math.cos(obstacle.cyaw));
    const sin = Math.abs(Math.sin(obstacle.cyaw));
    const sHalf = cos * obstacle.hs + sin * obstacle.hx;
    if (obstacle.cs + sHalf < distance - 2 || obstacle.cs - sHalf > distance + horizonMeters) {
      continue;
    }
    const vHalf = obstacle.kind === "ring" ? obstacle.hx : obstacle.hy;
    if (obstacle.cy - vHalf > CRAFT.Y_MAX || obstacle.cy + vHalf < CRAFT.Y_MIN) continue;
    obstacles.push({
      id: obstacle.id,
      kind: obstacle.kind,
      x: obstacle.cx + symmetricNoise(rng, profile.observationNoiseMeters),
      s: obstacle.cs + symmetricNoise(rng, profile.observationNoiseMeters),
      y: obstacle.cy + symmetricNoise(rng, profile.observationNoiseMeters * 0.25),
      hx: obstacle.hx,
      hy: obstacle.hy,
      hs: obstacle.hs,
      yaw: obstacle.cyaw,
      inner: obstacle.inner,
    });
  }
  obstacles.sort((a, b) => a.s - b.s || a.id - b.id);

  const courseOffsets: number[] = [];
  for (let slice = 0; slice < profile.planningSlices; slice++) {
    const frac = (slice + 0.5) / profile.planningSlices;
    courseOffsets.push(world.courseOffsetAt(distance + horizonMeters * frac));
  }
  return {
    time: world.time,
    x: world.x + symmetricNoise(rng, profile.observationNoiseMeters * 0.35),
    latVel: world.latVel + symmetricNoise(rng, profile.observationNoiseMeters * 0.8),
    distance,
    speed,
    horizonMeters,
    obstacles,
    courseOffsets,
  };
}

function observedBlockedRanges(
  obstacle: SyntheticObstacleObservation,
  profile: SyntheticPilotProfile,
): [number, number][] {
  const margin = CRAFT.RADIUS + profile.safetyMargin;
  if (obstacle.kind === "ring") {
    const dy = Math.abs(CRAFT.HOVER_HEIGHT - obstacle.y);
    const innerRadius = Math.max(0, obstacle.inner - CRAFT.RADIUS * 0.4 - profile.safetyMargin);
    const openingHalf = dy < innerRadius
      ? Math.sqrt(Math.max(0, innerRadius * innerRadius - dy * dy))
      : 0;
    const outerHalf = obstacle.hx + margin;
    return [
      [obstacle.x - outerHalf, obstacle.x - openingHalf],
      [obstacle.x + openingHalf, obstacle.x + outerHalf],
    ];
  }
  const cos = Math.abs(Math.cos(obstacle.yaw));
  const sin = Math.abs(Math.sin(obstacle.yaw));
  const lateralHalf = cos * obstacle.hx + sin * obstacle.hs + margin;
  return [[obstacle.x - lateralHalf, obstacle.x + lateralHalf]];
}

function corridorClearance(row: Uint8Array, lane: number): number {
  let cells = 0;
  for (let d = 1; d < row.length; d++) {
    if (lane - d < 0 || lane + d >= row.length || row[lane - d] || row[lane + d]) break;
    cells++;
  }
  return cells;
}

/** Axis quantization owned by the stress model, followed by replay quantization. */
export function quantizeSyntheticAxis(axis: number, levels: number): number {
  if (!Number.isInteger(levels) || levels < 2) {
    throw new RangeError("axis levels must be an integer >= 2");
  }
  const clamped = Math.max(-1, Math.min(1, axis));
  const bucket = Math.round(((clamped + 1) * (levels - 1)) / 2);
  const modeled = (bucket * 2) / (levels - 1) - 1;
  return quantizeAxis(modeled);
}

function planSyntheticTarget(
  observation: SyntheticObservation,
  profile: SyntheticPilotProfile,
): number {
  const slices = profile.planningSlices;
  const sliceMeters = observation.horizonMeters / slices;
  const sliceSeconds = sliceMeters / observation.speed;
  const frameCenter = observation.courseOffsets[0] ?? 0;
  const frameHalf = TRACK.X_LIMIT + 18;
  const frame0 = frameCenter - frameHalf;
  const lanes = Math.floor((frameHalf * 2) / profile.laneWidth) + 1;
  const laneX = (lane: number): number => frame0 + lane * profile.laneWidth;
  const blocked: Uint8Array[] = Array.from({ length: slices }, () => new Uint8Array(lanes));

  for (let slice = 0; slice < slices; slice++) {
    const center = observation.courseOffsets[slice];
    const lo = center - TRACK.X_LIMIT;
    const hi = center + TRACK.X_LIMIT;
    const row = blocked[slice];
    for (let lane = 0; lane < lanes; lane++) {
      const x = laneX(lane);
      if (x < lo || x > hi) row[lane] = 1;
    }
  }

  for (const obstacle of observation.obstacles) {
    const cos = Math.abs(Math.cos(obstacle.yaw));
    const sin = Math.abs(Math.sin(obstacle.yaw));
    const sHalf = cos * obstacle.hs + sin * obstacle.hx + CRAFT.RADIUS;
    for (let slice = 0; slice < slices; slice++) {
      const rowS = observation.distance + sliceMeters * (slice + 0.5);
      if (Math.abs(obstacle.s - rowS) > sHalf + sliceMeters * 0.5) continue;
      for (const [x0, x1] of observedBlockedRanges(obstacle, profile)) {
        const lane0 = Math.max(0, Math.floor((x0 - frame0) / profile.laneWidth));
        const lane1 = Math.min(lanes - 1, Math.ceil((x1 - frame0) / profile.laneWidth));
        for (let lane = lane0; lane <= lane1; lane++) blocked[slice][lane] = 1;
      }
    }
  }

  const maxLat = observation.speed * STEER.RATIO;
  const reachPerSlice = Math.max(
    1,
    Math.ceil((maxLat * sliceSeconds * profile.reachFraction) / profile.laneWidth),
  );
  const startLane = Math.max(0, Math.min(lanes - 1, Math.round((observation.x - frame0) / profile.laneWidth)));
  const costs: Float64Array[] = Array.from(
    { length: slices },
    () => new Float64Array(lanes).fill(-Infinity),
  );
  const parents: Int16Array[] = Array.from(
    { length: slices },
    () => new Int16Array(lanes).fill(-1),
  );

  const firstReach = Math.max(1, Math.ceil(reachPerSlice * 0.5));
  for (
    let lane = Math.max(0, startLane - firstReach);
    lane <= Math.min(lanes - 1, startLane + firstReach);
    lane++
  ) {
    if (blocked[0][lane]) continue;
    costs[0][lane] =
      corridorClearance(blocked[0], lane) * 0.55 -
      Math.abs(lane - startLane) * 0.45;
  }
  if (!costs[0].some(Number.isFinite)) {
    let nearest = -1;
    for (let delta = 0; delta < lanes && nearest < 0; delta++) {
      for (const lane of [startLane - delta, startLane + delta]) {
        if (lane >= 0 && lane < lanes && !blocked[0][lane]) {
          nearest = lane;
          break;
        }
      }
    }
    if (nearest >= 0) costs[0][nearest] = 0;
  }

  let deepest = 0;
  for (let slice = 1; slice < slices; slice++) {
    const prev = costs[slice - 1];
    const cur = costs[slice];
    for (let lane = 0; lane < lanes; lane++) {
      if (blocked[slice][lane]) continue;
      let best = -Infinity;
      let bestParent = -1;
      const lo = Math.max(0, lane - reachPerSlice);
      const hi = Math.min(lanes - 1, lane + reachPerSlice);
      for (let parent = lo; parent <= hi; parent++) {
        const candidate = prev[parent] - Math.abs(lane - parent) * 0.35;
        if (candidate > best) {
          best = candidate;
          bestParent = parent;
        }
      }
      if (bestParent >= 0 && Number.isFinite(best)) {
        cur[lane] = best + Math.min(6, corridorClearance(blocked[slice], lane)) * 0.55;
        parents[slice][lane] = bestParent;
      }
    }
    if (cur.some(Number.isFinite)) deepest = slice;
    else break;
  }

  let bestLane = startLane;
  let bestCost = -Infinity;
  for (let lane = 0; lane < lanes; lane++) {
    const cost = costs[deepest][lane] - Math.abs(lane - startLane) * 0.025;
    if (cost > bestCost) {
      bestCost = cost;
      bestLane = lane;
    }
  }
  if (!Number.isFinite(bestCost)) return observation.courseOffsets[0] ?? observation.x;

  const targetSlice = Math.min(
    deepest,
    Math.max(0, Math.round(profile.targetLeadSeconds / Math.max(FIXED_DT, sliceSeconds)) - 1),
  );
  for (let slice = deepest; slice > targetSlice; slice--) {
    const parent = parents[slice][bestLane];
    if (parent < 0) break;
    bestLane = parent;
  }
  return laneX(bestLane);
}

export interface SyntheticPilotController {
  readonly profile: SyntheticPilotProfile;
  readonly decisions: number;
  step(world: SimWorld, input: InputState): void;
}

class RestrictedSyntheticPilot implements SyntheticPilotController {
  readonly profile: SyntheticPilotProfile;
  private readonly rng: Rng;
  private nextDecisionAt = 0;
  private targetX = 0;
  private appliedAxis = 0;
  private decisionCount = 0;
  private pending: { applyAt: number; axis: number }[] = [];

  constructor(profile: SyntheticPilotProfile, seed: string) {
    this.profile = validateSyntheticProfile(profile);
    this.rng = createRng(seed);
  }

  get decisions(): number {
    return this.decisionCount;
  }

  step(world: SimWorld, input: InputState): void {
    if (world.time + 1e-9 >= this.nextDecisionAt) {
      const observation = observeSyntheticWorld(world, this.profile, this.rng);
      const plannedTarget = planSyntheticTarget(observation, this.profile);
      this.targetX =
        this.targetX * this.profile.targetSmoothing +
        plannedTarget * (1 - this.profile.targetSmoothing);
      const error = this.targetX - observation.x;
      const desiredVel =
        Math.sign(error) *
        Math.min(Math.abs(error) * 4, observation.speed * STEER.RATIO * this.profile.reachFraction);
      const rawAxis =
        (desiredVel - observation.latVel) * this.profile.steeringGain +
        symmetricNoise(this.rng, this.profile.motorNoiseAxis);
      this.pending.push({
        applyAt: world.time + this.profile.latencySeconds,
        axis: quantizeSyntheticAxis(rawAxis, this.profile.axisLevels),
      });
      this.decisionCount++;
      this.nextDecisionAt = world.time + 1 / this.profile.decisionHz;
    }

    while (this.pending.length > 0 && this.pending[0].applyAt <= world.time + 1e-9) {
      this.appliedAxis = this.pending.shift()!.axis;
    }
    input.axis = this.appliedAxis;
    input.boost = false;
    input.dash = false;
  }
}

/** Create one deterministic restricted-observation policy instance. */
export function createSyntheticPilot(
  profile: SyntheticPilotProfile,
  noiseSeed: string,
): SyntheticPilotController {
  return new RestrictedSyntheticPilot(profile, noiseSeed);
}

export interface PilotCohortRun {
  cohortId: string;
  seed: string;
  status: RunStatus;
  capped: boolean;
  distance: number;
  score: number;
  duration: number;
  steps: number;
  decisions: number | null;
  obstacleDrops: number;
  pickupDrops: number;
}

export interface PilotCohortAggregate {
  runs: number;
  meanDistance: number;
  medianDistance: number;
  minDistance: number;
  maxDistance: number;
  spreadRatio: number;
  trimmedSpreadRatio: number;
  cappedRuns: number;
}

export interface PilotCohortReport {
  cohortId: string;
  runs: PilotCohortRun[];
  aggregate: PilotCohortAggregate;
}

export interface PilotCohortController {
  step(world: SimWorld, input: InputState): void;
  readonly decisions?: number;
}

export interface PilotCohortOptions {
  cohortId: string;
  seeds: readonly string[];
  maxSeconds: number;
  createController: (seed: string) => PilotCohortController;
  configForSeed?: (seed: string) => RunConfig;
}

function medianValue(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function spreadRatio(values: readonly number[], trim: boolean): number {
  let sorted = [...values].sort((a, b) => a - b);
  if (trim && sorted.length >= 5) sorted = sorted.slice(1, -1);
  return sorted[0] > 0 ? sorted[sorted.length - 1] / sorted[0] : Infinity;
}

export function aggregatePilotCohort(runs: readonly PilotCohortRun[]): PilotCohortAggregate {
  if (runs.length === 0) throw new RangeError("a pilot cohort needs at least one run");
  const distances = runs.map((run) => run.distance);
  return {
    runs: runs.length,
    meanDistance: distances.reduce((sum, distance) => sum + distance, 0) / distances.length,
    medianDistance: medianValue(distances),
    minDistance: Math.min(...distances),
    maxDistance: Math.max(...distances),
    spreadRatio: spreadRatio(distances, false),
    trimmedSpreadRatio: spreadRatio(distances, true),
    cappedRuns: runs.filter((run) => run.capped).length,
  };
}

/** Run any deterministic policy factory across identical track seeds. */
export function runPilotCohort(options: PilotCohortOptions): PilotCohortReport {
  if (options.seeds.length === 0) throw new RangeError("a pilot cohort needs at least one seed");
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0) {
    throw new RangeError("maxSeconds must be positive");
  }
  const runs: PilotCohortRun[] = [];
  const maxSteps = Math.ceil(options.maxSeconds / FIXED_DT);
  for (const seed of options.seeds) {
    const world = new SimWorld();
    world.recordInputs = false;
    world.start(options.configForSeed?.(seed) ?? { mode: "endless", seed });
    const input: InputState = {
      axis: 0,
      boost: false,
      dash: false,
      restart: false,
      pause: false,
    };
    const controller = options.createController(seed);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      controller.step(world, input);
      world.update(FIXED_DT, input);
      steps++;
    }
    runs.push({
      cohortId: options.cohortId,
      seed,
      status: world.status,
      capped: world.status === "running",
      distance: world.distance,
      score: world.score,
      duration: world.stats.duration,
      steps,
      decisions: controller.decisions ?? null,
      obstacleDrops: world.stats.obstacleDrops,
      pickupDrops: world.stats.pickupDrops,
    });
  }
  return {
    cohortId: options.cohortId,
    runs,
    aggregate: aggregatePilotCohort(runs),
  };
}

/** Run one parameterized restricted-observation profile across a seed cohort. */
export function runSyntheticCohort(
  profile: SyntheticPilotProfile,
  seeds: readonly string[],
  maxSeconds: number,
): PilotCohortReport {
  return runPilotCohort({
    cohortId: profile.id,
    seeds,
    maxSeconds,
    createController: (seed) => createSyntheticPilot(profile, `${profile.id}|${seed}|noise`),
  });
}
