/**
 * Headless sim smoke test: a conservative band-scan autopilot (avoids the
 * full worst-case envelope of every mover, like the validator plans with)
 * plus determinism, pool-pressure, and risk-economy acceptance checks.
 *
 * Fairness itself is enforced at generation time — every accepted chunk is
 * proven passable by the reachability solver (see gentest.ts). Bot deaths
 * here reflect bot skill (it cannot time gaps through movers like a human);
 * the metric that matters is that distances stay reasonable and nothing
 * degenerates (all runs dying instantly = broken generation).
 *
 * Run: npx tsx scripts/simtest.ts
 */
import assert from "node:assert/strict";
import {
  GRADE_MIN_INTENSITY,
  SimWorld,
  gradeSection,
  obstacleTrailingEdge,
  precisionRewardAt,
} from "../src/game/core/world";
import { GhostDriver } from "../src/game/core/ghost";
import {
  packInput,
  quantizeAxis,
  resimulate,
  unpackAxis,
  unpackBoost,
} from "../src/game/core/replay";
import type { InputState } from "../src/game/core/input";
import {
  CRAFT,
  ENERGY,
  FIXED_DT,
  POOL_SIZES,
  STEER,
  THREAD,
  TRACK,
} from "../src/game/core/constants";
import { blockedRanges } from "../src/game/track/validator";
import { Motion, type ObstacleSpec } from "../src/game/core/types";

function specOf(o: SimWorld["obstacles"][number]): ObstacleSpec {
  return {
    kind: o.kind, s: o.s, x: o.x, y: o.y, hx: o.hx, hy: o.hy, hs: o.hs,
    yaw: o.yaw, motion: o.motion, m0: o.m0, m1: o.m1, m2: o.m2,
    inner: o.inner, collidable: o.collidable,
  };
}

interface PilotOpts {
  /** Hold boost whenever the tank allows it. */
  boost?: boolean;
}

/** Lateral gaps between worst-case obstacle envelopes inside an s-band. */
function scanGaps(world: SimWorld, bandStart: number, bandEnd: number): [number, number][] {
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

function steerToward(world: SimWorld, input: InputState, targetX: number): void {
  const err = targetX - world.x;
  const maxLat = Math.max(10, world.speed) * STEER.RATIO;
  const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
  input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
}

/** Best single-band gap target (shared by greedy and fallbacks). */
function greedyTargetX(world: SimWorld): number {
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
function autopilot(world: SimWorld, input: InputState, opts: PilotOpts = {}): void {
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
function lookaheadPilot(
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
function superhumanPilot(world: SimWorld, input: InputState): void {
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

// --- Conservative-bot survival + pool pressure + first-2km economy gate ----

// Pre-Phase-1 baselines (conservative bot, no boost). The risk-economy
// rebalance must keep the novice-proxy line within ±10% on average.
const BASELINE_800: Record<string, number> = {
  "test-0": 3615, "test-1": 3041, "test-2": 3473, "test-3": 3375,
  "test-4": 3571, "test-5": 3227, "test-6": 2627, "test-7": 3232,
};
const BASELINE_2KM: Record<string, number> = {
  "test-3": 4706, "test-5": 4890, "test-6": 4041,
};

let totalDeaths = 0;
let totalDist = 0;
let peakActive = 0;
let minDist = Infinity;
const peakByKind = new Map<string, number>();
let peakShards = 0;
let peakShields = 0;
const score800: Record<string, number> = {};
const score2km: Record<string, number> = {};
const runs = 8;
for (let r = 0; r < runs; r++) {
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const seed = `test-${r}`;
  world.start(seed, false);
  let killer = "";
  world.events.on("death", () => {
    let best = Infinity;
    for (const o of world.obstacles) {
      if (!o.active || !o.collidable) continue;
      const d2 = (o.cx - world.x) ** 2 + (o.cs - world.distance) ** 2;
      if (d2 < best) {
        best = d2;
        killer = `${o.kind} motion=${o.motion} at s=${o.cs.toFixed(0)}`;
      }
    }
  });

  const targetTime = 180;
  let steps = 0;
  let runPeak = 0;
  const maxSteps = Math.floor(targetTime / FIXED_DT);
  while (world.status === "running" && steps < maxSteps) {
    autopilot(world, input);
    world.update(FIXED_DT, input);
    if (score800[seed] === undefined && world.distance >= 800) {
      score800[seed] = Math.floor(world.score);
    }
    if (score2km[seed] === undefined && world.distance >= 2000) {
      score2km[seed] = Math.floor(world.score);
    }
    if (steps % 60 === 0) {
      const active = world.obstacles.filter((o) => o.active).length;
      if (active > runPeak) runPeak = active;
      const byKind = new Map<string, number>();
      for (const obstacle of world.obstacles) {
        if (obstacle.active) byKind.set(obstacle.kind, (byKind.get(obstacle.kind) ?? 0) + 1);
      }
      for (const [kind, count] of byKind) {
        peakByKind.set(kind, Math.max(peakByKind.get(kind) ?? 0, count));
      }
      peakShards = Math.max(
        peakShards,
        world.pickups.filter((pickup) => pickup.active && pickup.type === "shard").length,
      );
      peakShields = Math.max(
        peakShields,
        world.pickups.filter((pickup) => pickup.active && pickup.type === "shield").length,
      );
    }
    steps++;
  }
  peakActive = Math.max(peakActive, runPeak);
  if (world.status === "dead") totalDeaths++;
  totalDist += world.distance;
  minDist = Math.min(minDist, world.distance);
  assert.equal(world.stats.obstacleDrops, 0, `${seed} exhausted the obstacle pool`);
  assert.equal(world.stats.pickupDrops, 0, `${seed} exhausted the pickup pool`);
  console.log(
    `run ${r}: ${world.status.padEnd(7)} dist=${world.distance.toFixed(0).padStart(6)}m ` +
    `score=${Math.floor(world.score).toString().padStart(7)} speed=${world.speed.toFixed(1)} ` +
    `nearMiss=${world.stats.nearMisses} shards=${world.stats.shards} ` +
    `peakActive=${runPeak}` +
    (killer ? ` killer: ${killer}` : ""),
  );
}
console.log(
  `\ndeaths: ${totalDeaths}/${runs}, avg dist=${Math.round(totalDist / runs)}m, ` +
  `peak active obstacles=${peakActive} (render pools: box ${POOL_SIZES.box} / ` +
  `pillar ${POOL_SIZES.pillar} / crystal ${POOL_SIZES.crystal})`,
);
const avgDist = totalDist / runs;
assert.ok(minDist > 450, `opening is too punishing for the conservative bot (${minDist.toFixed(0)}m)`);
assert.ok(avgDist > 900, `average survival collapsed to ${avgDist.toFixed(0)}m`);
assert.ok(avgDist < 9000, `challenge curve is too gentle (${avgDist.toFixed(0)}m average)`);
assert.ok(peakActive < 500, `active obstacle pressure is unexpectedly high (${peakActive})`);
for (const kind of ["box", "pillar", "crystal", "sphere", "ring"] as const) {
  assert.ok(
    (peakByKind.get(kind) ?? 0) < POOL_SIZES[kind],
    `${kind} render pool lacks headroom (${peakByKind.get(kind)}/${POOL_SIZES[kind]})`,
  );
}
assert.ok(peakShards < POOL_SIZES.shard, `shard render pool lacks headroom (${peakShards})`);
assert.ok(peakShields < POOL_SIZES.shield, `shield render pool lacks headroom (${peakShields})`);

// Floor check (roadmap Phase 1): the conservative line through the opening
// must score like it did before the risk economy landed.
{
  const drifts: number[] = [];
  for (const [seed, base] of Object.entries(BASELINE_800)) {
    const now = score800[seed];
    assert.ok(now !== undefined, `${seed} no longer reaches 800m`);
    const drift = now / base - 1;
    drifts.push(drift);
    assert.ok(
      Math.abs(drift) < 0.15,
      `${seed} first-800m score drifted ${(drift * 100).toFixed(1)}% (${base} -> ${now})`,
    );
  }
  for (const [seed, base] of Object.entries(BASELINE_2KM)) {
    const now = score2km[seed];
    assert.ok(now !== undefined, `${seed} no longer reaches 2km`);
    const drift = now / base - 1;
    drifts.push(drift);
    assert.ok(
      Math.abs(drift) < 0.15,
      `${seed} first-2km score drifted ${(drift * 100).toFixed(1)}% (${base} -> ${now})`,
    );
  }
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  assert.ok(
    Math.abs(avgDrift) < 0.1,
    `novice-proxy scoring drifted ${(avgDrift * 100).toFixed(1)}% on average`,
  );
  console.log(`first-2km economy gate: PASS (avg drift ${(avgDrift * 100).toFixed(1)}%)`);
}

// --- Boost uptime: the risk loop must reward grazing, not shard-hoarding ---
// Hard-pattern gauntlet: narrowGates-style rows every 28m, each with a tight
// needle gap (thread + double razor for a committed line) and a wide safe
// lane (no precision income). The economy must let the tight line sustain
// near-perpetual boost while the safe lane cannot.
{
  const TIGHT_X = -10;
  const TIGHT_HALF = 1.3; // hull clearance 0.55 -> razor on both sides
  const SAFE_X = 21;
  const buildGauntlet = (world: SimWorld): void => {
    world.clearField();
    // Stop the procedural generator from streaming real chunks over the course.
    (world as unknown as { generator: null }).generator = null;
    let idx = 0;
    const wall = (s: number, x0: number, x1: number) => {
      const hx = (x1 - x0) / 2;
      const x = (x0 + x1) / 2;
      Object.assign(world.obstacles[idx++], {
        active: true, kind: "box",
        s, x, y: 2, hx, hy: 3, hs: 1, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0,
        collidable: true,
        cx: x, cy: 2, cs: s, cyaw: 0,
        state: 0, landed: false,
        nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
        patternId: "gauntlet",
      });
    };
    for (let r = 0; r < 220; r++) {
      const s = 60 + r * 28;
      wall(s, -TRACK.X_PATTERN, TIGHT_X - TIGHT_HALF);
      wall(s, TIGHT_X + TIGHT_HALF, SAFE_X - 5);
      wall(s, SAFE_X + 5, TRACK.X_PATTERN);
    }
  };

  const gauntletRun = (targetX: number, seconds: number) => {
    const world = new SimWorld();
    world.start("gauntlet", false);
    buildGauntlet(world);
    const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
    const maxSteps = Math.floor(seconds / FIXED_DT);
    for (let i = 0; i < maxSteps && world.status === "running"; i++) {
      const err = targetX - world.x;
      const maxLat = Math.max(10, world.speed) * STEER.RATIO;
      const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
      input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
      input.boost = world.boosting ? true : world.energy > 14;
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running", "gauntlet line must not crash");
    return world;
  };

  const tight = gauntletRun(TIGHT_X, 75);
  const tightUptime = tight.stats.boostTime / tight.stats.duration;
  console.log(
    `gauntlet tight line: uptime=${(tightUptime * 100).toFixed(0)}% ` +
    `dist=${tight.distance.toFixed(0)}m score=${Math.floor(tight.score)} ` +
    `nearMiss=${tight.stats.nearMisses} threads=${tight.stats.threads} ` +
    `razor=${tight.stats.razorPasses}`,
  );
  assert.ok(
    tightUptime > 0.8,
    `tight line cannot sustain boost through hard patterns (${(tightUptime * 100).toFixed(0)}%, want >80%)`,
  );
  assert.ok(tight.stats.threads > 40, `tight line should thread every gate (${tight.stats.threads})`);

  const safe = gauntletRun(SAFE_X, 75);
  const safeUptime = safe.stats.boostTime / safe.stats.duration;
  console.log(
    `gauntlet safe line:  uptime=${(safeUptime * 100).toFixed(0)}% ` +
    `dist=${safe.distance.toFixed(0)}m score=${Math.floor(safe.score)} ` +
    `nearMiss=${safe.stats.nearMisses}`,
  );
  assert.ok(
    tight.score > safe.score * 8,
    `the tight line must dwarf the safe line (${Math.floor(tight.score)} vs ${Math.floor(safe.score)})`,
  );
  assert.ok(
    safeUptime < 0.15,
    `safe lane must not sustain boost through hard patterns (${(safeUptime * 100).toFixed(0)}%)`,
  );
  assert.equal(safe.stats.nearMisses, 0, "safe lane must not graze");

  // On real seeds, a center-line shard-collecting bot stays a visitor to
  // boost, not a resident.
  const safeRuns: number[] = [];
  for (let r = 0; r < 4; r++) {
    const world = new SimWorld();
    const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
    world.start(`test-${r}`, false);
    const maxSteps = Math.floor(150 / FIXED_DT);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      autopilot(world, input, { boost: true });
      world.update(FIXED_DT, input);
      steps++;
    }
    safeRuns.push(world.stats.boostTime / Math.max(1e-6, world.stats.duration));
  }
  const safeAvg = safeRuns.reduce((a, b) => a + b, 0) / safeRuns.length;
  console.log(`real-track safe bot: avg uptime=${(safeAvg * 100).toFixed(0)}%`);
  assert.ok(
    safeAvg < 0.35,
    `real-track center-line play sustains boost too easily (${(safeAvg * 100).toFixed(0)}%)`,
  );
  console.log("boost economy gate: PASS");
}

// Determinism check.
{
  const a = new SimWorld();
  const b = new SimWorld();
  const eventsA: unknown[] = [];
  const eventsB: unknown[] = [];
  const wire = (world: SimWorld, out: unknown[]) => {
    world.events.on("nearMiss", (event) => out.push(["nearMiss", event]));
    world.events.on("thread", (event) => out.push(["thread", event]));
    world.events.on("shard", (event) => out.push(["shard", event]));
    world.events.on("flowTier", (event) => out.push(["flowTier", event]));
    world.events.on("biome", (event) => out.push(["biome", event]));
    world.events.on("sectionGrade", (event) => out.push(["sectionGrade", event]));
    world.events.on("death", (event) => out.push(["death", event]));
  };
  wire(a, eventsA);
  wire(b, eventsB);
  const input: InputState = { axis: 0.3, boost: false, restart: false, pause: false };
  a.start("determinism", false);
  b.start("determinism", false);
  for (let i = 0; i < 12000; i++) {
    input.axis = Math.sin(i * 0.01) * 0.8;
    input.boost = i % 900 < 300;
    a.update(FIXED_DT, input);
    b.update(FIXED_DT, input);
  }
  assert.equal(a.distance, b.distance);
  assert.equal(a.score, b.score);
  assert.equal(a.x, b.x);
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(eventsA, eventsB);
  console.log(`determinism: PASS (dist=${a.distance.toFixed(2)} vs ${b.distance.toFixed(2)})`);
}

// --- Phase 3: input recording + replay (roadmap 3.1) -------------------------
// A recorded run must re-simulate bit-exactly: same stats, same score, same
// death — the roadmap's determinism metric ("replay re-simulation reproduces
// recorded stats exactly").
{
  // Quantization round-trips: replaying a recording re-quantizes the axis,
  // so quantizeAxis must be idempotent and packing lossless.
  for (const axis of [-1, -0.73, -1 / 3, 0, 0.05, 0.4999, 0.999, 1]) {
    const q = quantizeAxis(axis);
    assert.equal(quantizeAxis(q), q, `quantizeAxis must be idempotent (${axis})`);
    for (const boost of [false, true]) {
      const packed = packInput(axis, boost);
      assert.equal(unpackAxis(packed), q, `axis pack round-trip (${axis})`);
      assert.equal(unpackBoost(packed), boost, `boost pack round-trip (${axis})`);
    }
  }

  // Record a full bot run to death (boost on: exercises the energy loop and
  // the boost bit; the bot's continuous axis exercises quantization).
  const live = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  live.start("replay-exact", false);
  const liveEvents: unknown[] = [];
  live.events.on("nearMiss", (e) => liveEvents.push(["nearMiss", e]));
  live.events.on("thread", (e) => liveEvents.push(["thread", e]));
  live.events.on("sectionGrade", (e) => liveEvents.push(["sectionGrade", e]));
  live.events.on("death", (e) => liveEvents.push(["death", e]));
  const maxSteps = Math.floor(240 / FIXED_DT);
  for (let i = 0; i < maxSteps && live.status === "running"; i++) {
    autopilot(live, input, { boost: true });
    live.update(FIXED_DT, input);
  }
  assert.equal(live.status, "dead", "replay probe run must end at a wall");
  const rec = live.getRecording();
  assert.ok(rec, "a finished run must produce a recording");
  assert.ok(rec.complete, "probe recording must fit the RLE cap");
  assert.equal(rec.seed, "replay-exact");
  assert.equal(rec.score, live.stats.score);
  let rleSteps = 0;
  for (let i = 1; i < rec.data.length; i += 2) rleSteps += rec.data[i];
  assert.equal(rleSteps, rec.steps, "RLE run lengths must sum to the step count");

  const replayed = new SimWorld();
  const replayEvents: unknown[] = [];
  replayed.events.on("nearMiss", (e) => replayEvents.push(["nearMiss", e]));
  replayed.events.on("thread", (e) => replayEvents.push(["thread", e]));
  replayed.events.on("sectionGrade", (e) => replayEvents.push(["sectionGrade", e]));
  replayed.events.on("death", (e) => replayEvents.push(["death", e]));
  resimulate(rec, replayed);
  assert.equal(replayed.status, "dead", "replay must reproduce the death");
  assert.equal(replayed.distance, live.distance, "replay distance must be exact");
  assert.equal(replayed.score, live.score, "replay score must be exact");
  assert.equal(replayed.x, live.x, "replay lateral position must be exact");
  assert.deepEqual(replayed.stats, live.stats, "replay stats must be identical");
  assert.deepEqual(replayEvents, liveEvents, "replay event stream must be identical");
  assert.equal(replayed.getRecording(), null, "replay worlds must not re-record");

  // Size: human-style input (held keys, sparse changes) stays a few KB.
  const keyed = new SimWorld();
  keyed.start("replay-size", false);
  const keyInput: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const keySteps = Math.floor(180 / FIXED_DT); // 3-minute run
  for (let i = 0; i < keySteps && keyed.status === "running"; i++) {
    // Direction changes every ~0.4 s, boost toggles every ~2 s — a busy human.
    const phase = Math.floor(i / 48) % 3;
    keyInput.axis = phase === 0 ? -1 : phase === 1 ? 1 : 0;
    keyInput.boost = i % 240 < 90;
    keyed.update(FIXED_DT, keyInput);
  }
  const keyRec = keyed.getRecording();
  assert.ok(keyRec && keyRec.complete);
  const keyBytes = JSON.stringify(keyRec).length;
  assert.ok(
    keyBytes < 32_000,
    `keyboard-style recording must stay a few KB (${(keyBytes / 1024).toFixed(1)} KB)`,
  );
  // Continuous analog input (bot stream) is the worst case — bounded, not tiny.
  const botBytes = JSON.stringify(rec).length;
  assert.ok(
    botBytes < 1_500_000,
    `continuous recording must stay bounded (${(botBytes / 1024).toFixed(0)} KB)`,
  );
  console.log(
    `replay gate: PASS (exact re-sim at ${live.distance.toFixed(0)}m; ` +
    `keyboard rec ${(keyBytes / 1024).toFixed(1)} KB, bot rec ${(botBytes / 1024).toFixed(0)} KB)`,
  );

  // Ghost lockstep (roadmap 3.2): a GhostDriver synced in ragged render-frame
  // slices must land exactly where the straight re-sim landed.
  const ghost = new GhostDriver();
  ghost.arm(rec);
  assert.ok(ghost.active, "ghost must arm from a complete recording");
  const totalTime = rec.steps * FIXED_DT;
  let clock = 0;
  let frame = 0;
  while (clock < totalTime + 0.1) {
    clock += 1 / 60 + (frame % 7) * 0.003; // deliberately uneven frames
    ghost.sync(clock);
    frame++;
  }
  assert.ok(ghost.finished, "ghost must exhaust the recording");
  assert.equal(ghost.world?.status, "dead", "ghost must die where the run died");
  assert.equal(ghost.world?.distance, replayed.distance, "ghost distance must be exact");
  assert.equal(ghost.world?.stats.score, replayed.stats.score, "ghost score must be exact");
  assert.equal(ghost.deltaTo(replayed.distance), 0, "ghost delta must close to zero");
  console.log("ghost lockstep gate: PASS");
}

// --- Phase 3: section grades (roadmap 3.4) -----------------------------------
{
  // Unit calibration: an elite line through a hard chunk grades S, an
  // edge-hugging cruise grades C, and grades are monotone in engagement.
  const elite = gradeSection({
    intensity: 4,
    events: 14, // ~threaded every gate across 120 m
    traversed: 120,
    flowUptime: 0.95,
    avgSpeed: 120,
    baseSpeed: 85,
  });
  assert.equal(elite.grade, "S", `elite line must grade S (${elite.composite.toFixed(2)})`);

  const hug = gradeSection({
    intensity: 4,
    events: 0,
    traversed: 120,
    flowUptime: 0,
    avgSpeed: 82,
    baseSpeed: 85,
  });
  assert.equal(hug.grade, "C", `edge-hugging must grade C (${hug.composite.toFixed(2)})`);

  const cautious = gradeSection({
    intensity: 3,
    events: 3,
    traversed: 120,
    flowUptime: 0.4,
    avgSpeed: 86,
    baseSpeed: 85,
  });
  assert.ok(
    cautious.composite > hug.composite && cautious.composite < elite.composite,
    "grades must be monotone in line quality",
  );
  // Same play against a harder chunk must never grade higher.
  const sameLineHarder = gradeSection({
    intensity: 5,
    events: 3,
    traversed: 120,
    flowUptime: 0.4,
    avgSpeed: 86,
    baseSpeed: 85,
  });
  assert.ok(sameLineHarder.composite <= cautious.composite, "intensity must raise the bar");

  // Integration: a real bot run produces ordered, sane sections and — since
  // it dies — an aggregate line rating.
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  world.start("test-0", false);
  const emitted: { patternId: string; grade: string }[] = [];
  world.events.on("sectionGrade", (e) => emitted.push(e));
  const maxSteps = Math.floor(180 / FIXED_DT);
  for (let i = 0; i < maxSteps && world.status === "running"; i++) {
    autopilot(world, input);
    world.update(FIXED_DT, input);
  }
  assert.equal(world.status, "dead");
  const sections = world.stats.sections;
  assert.ok(sections.length >= 3, `bot run must traverse sections (${sections.length})`);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    assert.ok(["S", "A", "B", "C"].includes(s.grade));
    assert.ok(s.composite >= 0 && s.composite <= 1, "composite must be normalized");
    assert.ok(s.s1 > s.s0);
    if (i > 0) assert.ok(s.s0 >= sections[i - 1].s0, "sections must be in track order");
  }
  const graded = sections.filter((s) => s.intensity >= GRADE_MIN_INTENSITY);
  assert.equal(
    emitted.length,
    graded.length,
    "every graded section must emit exactly one event",
  );
  if (graded.length > 0) {
    assert.ok(world.stats.lineRating !== null, "a run with graded sections gets a line rating");
  }
  console.log(
    `section grade gate: PASS (${sections.length} sections, ` +
    `${graded.length} graded, line rating ${world.stats.lineRating ?? "n/a"})`,
  );

  // Forensics snapshot (roadmap 3.3): the kill-cam data is complete.
  const f = world.buildForensics();
  assert.ok(f, "a dead world must produce forensics");
  assert.ok(f.trace.length > 10, "forensics must include the flown line");
  const lastSample = f.trace[f.trace.length - 1];
  assert.ok(
    Math.abs(lastSample.s - f.deathS) < 2,
    `the trace must end at the impact (${lastSample.s.toFixed(1)} vs ${f.deathS.toFixed(1)})`,
  );
  for (let i = 1; i < f.trace.length; i++) {
    assert.ok(f.trace[i].s >= f.trace[i - 1].s, "trace must be chronological");
  }
  assert.ok(f.obstacles.length > 0, "forensics must include the killing geometry");
  assert.ok(
    f.obstacles.some((o) => Math.abs(o.s - f.deathS) < 30),
    "forensics obstacles must cover the impact zone",
  );
  assert.ok(f.path.length > 0, "forensics must include the validator's solved path");
  assert.ok(f.deathSpeed > 0, "death speed must be captured before crash deceleration");
  const alive = new SimWorld();
  alive.start("forensics-alive", false);
  assert.equal(alive.buildForensics(), null, "forensics only exist after death");
  console.log(
    `forensics gate: PASS (trace ${f.trace.length} samples, ` +
    `${f.obstacles.length} obstacles, ${f.path.length} path segments)`,
  );
}

// Focused mastery-economy checks.
{
  const perfect = precisionRewardAt(0.1);
  const razor = precisionRewardAt(0.45);
  const close = precisionRewardAt(1);
  assert.equal(perfect.grade, "perfect");
  assert.equal(razor.grade, "razor");
  assert.equal(close.grade, "close");
  assert.ok(perfect.baseScore > razor.baseScore && razor.baseScore > close.baseScore);
  assert.ok(perfect.flowPoints > razor.flowPoints && razor.flowPoints > close.flowPoints);

  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  world.start("combo-economy", false);
  const shards = world.pickups.filter((pickup) => pickup.active && pickup.type === "shard");
  assert.ok(shards.length >= 2, "fixed combo seed did not generate enough shards");
  const startEnergy = world.energy;
  for (const shard of shards.slice(0, 2)) {
    shard.s = world.distance;
    shard.x = world.x;
    world.update(FIXED_DT, input);
  }
  assert.equal(world.shardCombo, 2);
  assert.equal(world.stats.bestShardCombo, 2);
  assert.ok(world.energy > startEnergy + 10, "shard combo did not add bonus energy");
  assert.ok(world.flowDecayGrace < 3, "Flow grace should remain bounded");
}

// Uncapped Flow: gains push past the old cap; superlinear decay pulls back.
{
  const decayRateAt = (points: number): number => {
    const world = new SimWorld();
    world.start("flow-uncap", false);
    world.clearField();
    const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
    world.flowPoints = points;
    world.update(FIXED_DT, input); // Settle flowTier for this level.
    world.flowPoints = points;
    world.flowTimer = 100; // Deep past the grace window.
    const before = world.flowPoints;
    world.update(FIXED_DT, input);
    return (before - world.flowPoints) / FIXED_DT;
  };

  const over = decayRateAt(40);
  const under = decayRateAt(20);
  assert.ok(under > 0, "flow must decay below the soft cap too");
  assert.ok(
    over > under * 4,
    `overcap decay should be superlinear (${over.toFixed(2)}/s vs ${under.toFixed(2)}/s)`,
  );

  // Flow points are genuinely uncapped now: a long graze chain pushes past 28.
  const world = new SimWorld();
  world.start("flow-uncap-gain", false);
  world.clearField();
  world.flowPoints = 27.9;
  world.flowTimer = 0;
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  world.update(FIXED_DT, input);
  const probe = world.obstacles[0];
  Object.assign(probe, {
    active: true, kind: "box",
    s: world.distance + 6, x: -1.2 - 3, hx: 3, hs: 0.5, y: 1, hy: 2, yaw: 0,
    motion: Motion.None, collidable: true,
    cx: -1.2 - 3, cy: 1, cs: world.distance + 6, cyaw: 0,
    state: 0, landed: false,
    nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
    patternId: "flowUncap",
  });
  for (let i = 0; i < 240 && world.stats.nearMisses === 0; i++) {
    world.update(FIXED_DT, input);
  }
  assert.equal(world.stats.nearMisses, 1);
  assert.ok(
    world.stats.maxFlowPoints > 28.5,
    `flow should exceed the old cap (peaked at ${world.stats.maxFlowPoints.toFixed(1)})`,
  );
}

console.log("simulation assertions: PASS");

// --- Thread the needle -------------------------------------------------------
// Synthetic gates driven through with a straight line: threads must fire on
// opposite-side pairs inside the window and never on single edges or
// same-side chains.
{
  const runProbe = (
    obstacles: Partial<SimWorld["obstacles"][number]>[],
  ): { world: SimWorld; threads: number; threadEvents: { scoreAward: number; tightness: number }[] } => {
    const world = new SimWorld();
    world.start("thread-probe", false);
    world.clearField();
    obstacles.forEach((spec, i) => {
      Object.assign(world.obstacles[i], {
        active: true,
        kind: "box",
        y: 1, hy: 2,
        yaw: 0,
        motion: Motion.None,
        collidable: true,
        cyaw: 0,
        state: 0, landed: false,
        nearMissed: false,
        nearMissClearance: Infinity,
        nearMissSide: 0,
        patternId: "threadProbe",
        ...spec,
        cx: spec.x, cy: 1, cs: spec.s,
      });
    });
    const threadEvents: { scoreAward: number; tightness: number }[] = [];
    world.events.on("thread", (e) => threadEvents.push(e));
    const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
    for (let i = 0; i < 600 && world.status === "running"; i++) {
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running", "thread probe must not crash");
    return { world, threads: world.stats.threads, threadEvents };
  };

  // Hull edges at ±1.55 -> clearance 0.8 per side: double graze -> thread.
  const gate = (s: number, gapHalf: number, side: 1 | -1 | 0 = 0) => {
    const walls: Partial<SimWorld["obstacles"][number]>[] = [];
    if (side <= 0) walls.push({ s, x: -gapHalf - 3, hx: 3, hs: 1 });
    if (side >= 0) walls.push({ s, x: gapHalf + 3, hx: 3, hs: 1 });
    return walls;
  };

  const needle = runProbe(gate(30, 1.55));
  assert.equal(needle.threads, 1, "narrow gate must pay exactly one thread");
  assert.equal(needle.world.stats.nearMisses, 2, "both walls of the needle graze");
  assert.ok(needle.threadEvents[0].scoreAward > 0);
  assert.ok(needle.threadEvents[0].tightness > 0.5);

  // Wider gate: no grazes (clearance ~1.85 > near-miss), still a thread.
  const pressed = runProbe(gate(30, 2.6));
  assert.equal(pressed.threads, 1, "pressed pass pair must still thread");
  assert.equal(pressed.world.stats.nearMisses, 0, "pressed passes are not grazes");
  assert.ok(
    pressed.threadEvents[0].scoreAward < needle.threadEvents[0].scoreAward,
    "looser needles pay less",
  );

  // Single edge: a graze on one side only — never a thread.
  const single = runProbe(gate(30, 1.55, -1));
  assert.equal(single.threads, 0, "single-edge graze must never thread");
  assert.equal(single.world.stats.nearMisses, 1);

  // Same-side staggered pair: two grazes, no thread.
  const sameSide = runProbe([
    { s: 30, x: -1.55 - 3, hx: 3, hs: 1 },
    { s: 38, x: -1.55 - 3, hx: 3, hs: 1 },
  ]);
  assert.equal(sameSide.threads, 0, "same-side chain must never thread");
  assert.equal(sameSide.world.stats.nearMisses, 2);

  // Opposite sides but too far apart along-track: no thread.
  const farApart = runProbe([
    { s: 30, x: -1.55 - 3, hx: 3, hs: 1 },
    { s: 30 + THREAD.WINDOW + 8, x: 1.55 + 3, hx: 3, hs: 1 },
  ]);
  assert.equal(farApart.threads, 0, "window must bound thread pairing");
  assert.equal(farApart.world.stats.nearMisses, 2);

  // Wide-open pass (clearance beyond THREAD.CLEARANCE): nothing at all.
  const wide = runProbe(gate(30, 4.2));
  assert.equal(wide.threads, 0);
  assert.equal(wide.world.stats.nearMisses, 0);

  console.log("thread assertions: PASS");
}

// Grazes fund boost: a razor pass pays energy (and more of it while boosting).
{
  const grazeEnergy = (boosting: boolean): number => {
    const world = new SimWorld();
    world.start("graze-energy", false);
    world.clearField();
    Object.assign(world.obstacles[0], {
      active: true, kind: "box",
      s: 30, x: -1.2 - 3, hx: 3, hs: 1, y: 1, hy: 2, yaw: 0,
      motion: Motion.None, collidable: true,
      cx: -1.2 - 3, cy: 1, cs: 30, cyaw: 0,
      state: 0, landed: false,
      nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
      patternId: "grazeEnergy",
    });
    const input: InputState = { axis: 0, boost: boosting, restart: false, pause: false };
    let award = 0;
    world.events.on("nearMiss", (e) => {
      award = e.energyAward;
      assert.equal(world.boosting, boosting, "probe must pay out in the intended boost state");
    });
    for (let i = 0; i < 600 && world.status === "running"; i++) {
      world.energy = Math.max(world.energy, 60); // Keep the tank from running dry.
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running");
    assert.equal(world.stats.nearMisses, 1, "graze-energy probe must graze exactly once");
    return award;
  };
  const idleAward = grazeEnergy(false);
  const boostAward = grazeEnergy(true);
  assert.ok(Math.abs(idleAward - ENERGY.GRAZE_RAZOR) < 1e-9, `razor graze pays energy (${idleAward})`);
  assert.ok(
    Math.abs(boostAward - ENERGY.GRAZE_RAZOR * ENERGY.BOOST_REFUND) < 1e-9,
    `boosting refund multiplies graze energy (${boostAward})`,
  );
}

// Fixed-step partitioning must not grant slow motion at low render FPS.
{
  const smooth = new SimWorld();
  const chunky = new SimWorld();
  const input: InputState = { axis: 0.2, boost: false, restart: false, pause: false };
  smooth.start("frame-partition", false);
  chunky.start("frame-partition", false);
  for (let i = 0; i < 120; i++) smooth.update(FIXED_DT, input);
  for (let i = 0; i < 10; i++) chunky.update(0.1, input);
  assert.equal(chunky.time, smooth.time);
  assert.equal(chunky.distance, smooth.distance);
  assert.equal(chunky.x, smooth.x);
}

// A fatal collision freezes score/resources and cannot also collect a shard.
{
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const makeDeathProbe = (seed: string) => {
    const world = new SimWorld();
    world.start(seed, false);
    world.clearField();
    Object.assign(world.obstacles[0], {
      active: true,
      kind: "box",
      s: 0,
      x: 0,
      y: 1,
      hx: 2,
      hy: 2,
      hs: 2,
      yaw: 0,
      motion: Motion.None,
      collidable: true,
      cx: 0,
      cy: 1,
      cs: 0,
      cyaw: 0,
      nearMissed: false,
      nearMissClearance: Infinity,
      nearMissSide: 0,
      patternId: "deathFreeze",
    });
    Object.assign(world.pickups[0], {
      active: true,
      type: "shard",
      s: 0,
      x: 0,
      y: 1.3,
      seeking: false,
      magnetic: true,
    });
    world.score = 100;
    return world;
  };

  const world = makeDeathProbe("death-freeze");
  let deaths = 0;
  let shards = 0;
  world.events.on("death", () => deaths++);
  world.events.on("shard", () => shards++);
  world.update(FIXED_DT, input);
  assert.equal(world.status, "dead");
  assert.equal(world.score, 100);
  assert.equal(world.stats.score, 100);
  assert.equal(world.stats.shards, 0);
  assert.equal(deaths, 1);
  assert.equal(shards, 0);
  assert.equal(world.pickups[0].active, true);

  const fixedDeath = makeDeathProbe("death-partition");
  const chunkyDeath = makeDeathProbe("death-partition");
  for (let i = 0; i < 12; i++) fixedDeath.update(FIXED_DT, input);
  chunkyDeath.update(0.1, input);
  assert.ok(Math.abs(chunkyDeath.time - fixedDeath.time) < 1e-12);
  assert.ok(Math.abs(chunkyDeath.deathTimer - fixedDeath.deathTimer) < 1e-12);
  assert.ok(Math.abs(chunkyDeath.speed - fixedDeath.speed) < 1e-12);
}

// Moving geometry must be fully behind before a precision pass can settle.
{
  const probe = new SimWorld().obstacles[0];
  Object.assign(probe, {
    cs: 100,
    s: 100,
    hx: 8,
    hs: 0.5,
    cyaw: 0,
    motion: Motion.RotateYaw,
    m0: 2,
  });
  assert.ok(obstacleTrailingEdge(probe) > probe.cs + probe.hs + 7);
  probe.motion = Motion.OrbitXZ;
  probe.m0 = 9;
  assert.equal(obstacleTrailingEdge(probe), 117);
}

console.log("edge-case assertions: PASS");

// --- Phase 2 wall calibration ------------------------------------------------
// The treadmill must never stop: every bot tier has to die (no immortal
// line), and better play has to buy meaningfully more distance — stable,
// distinct walls per tier. Greedy reads one band, lookahead plans across
// two, superhuman tracks the validator's solved path and is limited only by
// steering bandwidth against overdrive speed/density.
{
  type Tier = "greedy" | "lookahead" | "superhuman";
  const TIER_CAP_S: Record<Tier, number> = {
    greedy: 400,
    lookahead: 700,
    superhuman: 1600,
  };

  // Deep-overdrive pool pressure: the wall runs are where the speed-scaled
  // horizon maxes out, so render-pool headroom must be measured here, not
  // just on the 720 m-horizon conservative runs.
  const wallPeakByKind = new Map<string, number>();
  let wallPeakShards = 0;

  const runTier = (tier: Tier, seed: string): number => {
    const world = new SimWorld();
    world.start(seed, false);
    const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
    const laneMem = { targetX: 0 };
    const maxSteps = Math.floor(TIER_CAP_S[tier] / FIXED_DT);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      if (tier === "greedy") autopilot(world, input);
      else if (tier === "lookahead") lookaheadPilot(world, input, laneMem);
      else superhumanPilot(world, input);
      world.update(FIXED_DT, input);
      if (steps % 120 === 0) {
        const byKind = new Map<string, number>();
        for (const o of world.obstacles) {
          if (o.active) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
        }
        for (const [kind, count] of byKind) {
          wallPeakByKind.set(kind, Math.max(wallPeakByKind.get(kind) ?? 0, count));
        }
        wallPeakShards = Math.max(
          wallPeakShards,
          world.pickups.filter((p) => p.active && p.type === "shard").length,
        );
      }
      steps++;
    }
    assert.equal(
      world.status,
      "dead",
      `${tier}/${seed} must hit a wall before ${TIER_CAP_S[tier]}s of sim ` +
      `(still alive at ${world.distance.toFixed(0)}m — the treadmill capped out)`,
    );
    assert.equal(world.stats.obstacleDrops, 0, `${tier}/${seed} exhausted the obstacle pool`);
    assert.equal(world.stats.pickupDrops, 0, `${tier}/${seed} exhausted the pickup pool`);
    return world.distance;
  };

  const seeds = ["wall-0", "wall-1", "wall-2", "wall-3", "wall-4", "wall-5"];
  // Calibrated 2026-07 (Phase 2 landing; superhuman recalibrated at Phase 3
  // when input quantization landed — the sim consumes a 1/127-step axis now,
  // which nudged the chaotic rollout searcher into a new equilibrium). The
  // sim is deterministic, so these reproduce exactly until tuning constants
  // move — the loose band catches real difficulty regressions either way.
  const WALL_BASELINE: Record<Tier, number> = {
    greedy: 1133,
    lookahead: 2686,
    superhuman: 31547,
  };
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length / 2;
    return s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
  };
  /** Robust stability measure: spread of the seeds left after trimming the
   *  single best and worst run (bots are noisy; the band is the wall). */
  const trimmedSpread = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b).slice(1, -1);
    return s[s.length - 1] / s[0];
  };

  const walls: Record<Tier, number[]> = { greedy: [], lookahead: [], superhuman: [] };
  for (const tier of ["greedy", "lookahead", "superhuman"] as Tier[]) {
    for (const seed of seeds) walls[tier].push(runTier(tier, seed));
    const sorted = [...walls[tier]].sort((a, b) => a - b);
    console.log(
      `wall ${tier.padEnd(10)} ${sorted.map((d) => d.toFixed(0).padStart(6)).join(" ")}  ` +
      `median=${median(walls[tier]).toFixed(0)}m`,
    );
  }

  // Walls are medians over fixed seeds — fully deterministic, so the bands
  // are exactly reproducible; per-seed spread for the heuristic tiers is
  // track luck, bounded loosely to catch degenerate regressions.
  const g = median(walls.greedy);
  const l = median(walls.lookahead);
  const s = median(walls.superhuman);
  assert.ok(
    l > g * 1.5,
    `lookahead wall (${l.toFixed(0)}m) must clear greedy (${g.toFixed(0)}m) by ≥1.5×`,
  );
  assert.ok(
    s > l * 1.5,
    `superhuman wall (${s.toFixed(0)}m) must clear lookahead (${l.toFixed(0)}m) by ≥1.5×`,
  );
  assert.ok(
    s > 8000,
    `superhuman wall (${s.toFixed(0)}m) should die in overdrive territory (>8km) — ` +
    "otherwise Phase 2 scaling is never exercised",
  );
  for (const tier of ["greedy", "lookahead", "superhuman"] as Tier[]) {
    assert.ok(
      trimmedSpread(walls[tier]) < 4.5,
      `${tier} wall is unstable across seeds (trimmed spread ×${trimmedSpread(walls[tier]).toFixed(2)})`,
    );
    const drift = median(walls[tier]) / WALL_BASELINE[tier];
    assert.ok(
      drift > 0.55 && drift < 1.8,
      `${tier} wall drifted ×${drift.toFixed(2)} from its calibrated band ` +
      `(${median(walls[tier]).toFixed(0)}m vs ${WALL_BASELINE[tier]}m)`,
    );
  }

  const wallPools = [...wallPeakByKind.entries()]
    .map(([kind, count]) => `${kind} ${count}/${POOL_SIZES[kind as keyof typeof POOL_SIZES]}`)
    .join(", ");
  console.log(`deep-overdrive render pool peaks: ${wallPools}, shards ${wallPeakShards}`);
  for (const kind of ["box", "pillar", "crystal", "sphere", "ring"] as const) {
    assert.ok(
      (wallPeakByKind.get(kind) ?? 0) < POOL_SIZES[kind],
      `${kind} render pool lacks headroom at max horizon ` +
      `(${wallPeakByKind.get(kind)}/${POOL_SIZES[kind]})`,
    );
  }
  assert.ok(
    wallPeakShards < POOL_SIZES.shard,
    `shard render pool lacks headroom at max horizon (${wallPeakShards})`,
  );
  console.log("wall calibration gate: PASS");
}
