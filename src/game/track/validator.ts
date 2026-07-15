import { CRAFT, overdriveAt, SERPENT, STEER, TRACK } from "../core/constants";
import { clamp } from "../core/mathUtils";
import { Motion, type ObstacleSpec } from "../core/types";

export const LANE_W = 0.5;
export const LANE_COUNT = Math.round((TRACK.X_LIMIT * 2) / LANE_W) + 1; // 121
/** Along-track slice size for the reachability DP (meters). */
const DS = 4;
/**
 * Baseline path slope in lateral meters per forward meter. Steering is
 * speed-proportional (RATIO 0.58), so the craft's true achievable slope is
 * ~0.5 after acceleration lag. Early play uses this conservative 0.25 plan;
 * expert chunks may use the bounded late profile below.
 */
export const PATH_SLOPE = 0.25;
const EARLY_REACH_LANES = 2;
const LATE_REACH_LANES = 3;

/** Late patterns may demand more of the craft while retaining a human margin. */
export function reachLanesAt(difficulty: number): number {
  return difficulty >= 0.64 ? LATE_REACH_LANES : EARLY_REACH_LANES;
}

export function pathSlopeAt(difficulty: number): number {
  return (reachLanesAt(difficulty) * LANE_W) / DS;
}

// The hardest planned slope must stay below 65% of physical steering.
const PHYSICAL_SLOPE = STEER.RATIO;
if (pathSlopeAt(1) > PHYSICAL_SLOPE * 0.65) {
  throw new Error("Validator late-game reach too aggressive for craft steering");
}

export const laneToX = (lane: number) => -TRACK.X_LIMIT + lane * LANE_W;
export const xToLane = (x: number) =>
  clamp(Math.round((x + TRACK.X_LIMIT) / LANE_W), 0, LANE_COUNT - 1);

export interface ValidationResult {
  ok: boolean;
  /** Reachable lane mask at the pattern exit. */
  exitLanes: Uint8Array;
  /** Representative safe path as [s, x] pairs (for shard placement / debug). */
  path: [number, number][];
  /** Debug: per-slice blocked masks. */
  slices?: { s: number; blocked: Uint8Array }[];
}

/**
 * Safety slack added around the craft radius when rasterizing blocked lanes.
 * The minimum passable corridor is ~2·(CRAFT.RADIUS + slack) + one lane, so
 * this is the "min-corridor" dial: overdrive tightens it from the baseline
 * toward a hard floor (~2.5 m gaps — razor-grade but honestly dodgeable).
 */
export const BASE_MARGIN_SLACK = 0.42;
export const MIN_MARGIN_SLACK = 0.24;

export function marginSlackAt(s: number): number {
  return Math.max(MIN_MARGIN_SLACK, BASE_MARGIN_SLACK - overdriveAt(s) * 0.06);
}

/**
 * Worst-case lateral extents an obstacle can block, independent of time.
 * Conservative: motion sweeps use their full envelope, so a validated chunk
 * is passable no matter the phase of any mover.
 */
export function blockedRanges(
  o: ObstacleSpec,
  slack: number = BASE_MARGIN_SLACK,
): [number, number][] {
  if (o.collidable === false || o.noValidate) return [];

  // Vertical: does it intersect the craft band? FallY uses its resting y,
  // pendulums the bottom of their swing, serpents their deepest dip, rings
  // their full disc.
  let restY = o.y;
  if (o.motion === Motion.FallY) restY = o.m1 ?? o.y;
  if (o.motion === Motion.Pendulum) restY = o.y - (o.m0 ?? 0);
  if (o.motion === Motion.Serpent) restY = o.y - (o.m2 ?? 0);
  const vHalf = o.kind === "ring" ? o.hx : o.hy;
  if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) return [];

  const margin = CRAFT.RADIUS + slack;

  if (o.kind === "ring") {
    const inner = o.inner ?? 2.5;
    const outer = o.hx;
    const sweep = o.motion === Motion.SweepX ? Math.abs(o.m2 ?? 0) : 0;
    return [
      [o.x - sweep - outer - margin, o.x + sweep - inner + margin],
      [o.x - sweep + inner - margin, o.x + sweep + outer + margin],
    ];
  }

  // Yawed boxes cover a wider lateral band.
  const yaw = o.yaw ?? 0;
  const effHx = Math.abs(Math.cos(yaw)) * o.hx + Math.abs(Math.sin(yaw)) * o.hs;

  let x0 = o.x - effHx;
  let x1 = o.x + effHx;
  switch (o.motion) {
    case Motion.SweepX: {
      const amp = Math.abs(o.m2 ?? 0);
      x0 -= amp;
      x1 += amp;
      break;
    }
    case Motion.Pendulum: {
      const reach = Math.sin(Math.abs(o.m1 ?? 0)) * (o.m0 ?? 0);
      x0 -= reach;
      x1 += reach;
      break;
    }
    case Motion.RotateYaw: {
      const r = Math.hypot(o.hx, o.hs);
      x0 = o.x - r;
      x1 = o.x + r;
      break;
    }
    case Motion.OrbitXZ: {
      const r = (o.m0 ?? 0) + Math.max(o.hx, o.hs);
      x0 = o.x - r;
      x1 = o.x + r;
      break;
    }
    case Motion.CloseIn: {
      const tx = o.m0 ?? o.x;
      x0 = Math.min(o.x, tx) - effHx;
      x1 = Math.max(o.x, tx) + effHx;
      break;
    }
    case Motion.Piston: {
      const amp = Math.abs(o.m2 ?? 0);
      x0 -= amp;
      x1 += amp;
      break;
    }
    case Motion.Serpent: {
      x0 -= SERPENT.WOBBLE;
      x1 += SERPENT.WOBBLE;
      break;
    }
  }

  if (o.vx0 !== undefined && o.vx1 !== undefined) {
    x0 = o.vx0;
    x1 = o.vx1;
  }
  return [[x0 - margin, x1 + margin]];
}

/** Along-track half-footprint (inflated for movers/yaw). */
function sHalfExtent(o: ObstacleSpec): number {
  if (o.motion === Motion.RotateYaw) return Math.hypot(o.hx, o.hs);
  if (o.motion === Motion.OrbitXZ) return (o.m0 ?? 0) + Math.max(o.hx, o.hs);
  const yaw = o.yaw ?? 0;
  if (yaw) return Math.abs(Math.cos(yaw)) * o.hs + Math.abs(Math.sin(yaw)) * o.hx;
  return o.hs;
}

/** Binary dilation of a lane mask by `lanes` on both sides. */
export function dilateLanes(mask: Uint8Array, lanes: number): Uint8Array {
  if (lanes <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let l = 0; l < mask.length; l++) {
    if (!mask[l]) continue;
    const lo = Math.max(0, l - lanes);
    const hi = Math.min(mask.length - 1, l + lanes);
    for (let m = lo; m <= hi; m++) out[m] = 1;
  }
  return out;
}

/**
 * Discretized reachability solver over lanes (0.5 m) and track slices (4 m).
 *
 * Guarantees on success:
 *  - EVERY lane of the entry corridor has a collision-free line to the exit,
 *    steering no harder than the selected difficulty reach profile,
 *    assuming worst-case envelopes for all moving obstacles.
 *
 * `runway` is extra obstacle-free distance before slice 0 (inter-chunk seam);
 * the entry mask is dilated by the lateral distance coverable across it.
 */
export function validatePattern(
  obstacles: ObstacleSpec[],
  s0: number,
  length: number,
  entryLanes: Uint8Array,
  runway = 0,
  collectDebug = false,
  difficulty = 0,
  /** Extra slack reduction (Narrow Gaps heat); floored at the hard minimum. */
  slackBias = 0,
): ValidationResult {
  const steps = Math.max(2, Math.ceil(length / DS));
  const reachLanes = reachLanesAt(difficulty);
  const runwayLanes = Math.floor((pathSlopeAt(difficulty) * Math.max(0, runway)) / LANE_W);
  const entry = dilateLanes(entryLanes, runwayLanes);
  // Overdrive (and heat) tightens the guaranteed corridor toward its floor.
  const slack = Math.max(MIN_MARGIN_SLACK, marginSlackAt(s0) - slackBias);

  // Rasterize blocked masks.
  const blocked: Uint8Array[] = [];
  for (let k = 0; k <= steps; k++) blocked.push(new Uint8Array(LANE_COUNT));
  for (const o of obstacles) {
    const ranges = blockedRanges(o, slack);
    if (ranges.length === 0) continue;
    const hs = sHalfExtent(o);
    const k0 = clamp(Math.floor((o.s - hs - s0) / DS), 0, steps);
    const k1 = clamp(Math.ceil((o.s + hs - s0) / DS), 0, steps);
    for (const [x0, x1] of ranges) {
      if (x1 < -TRACK.X_LIMIT || x0 > TRACK.X_LIMIT) continue;
      const l0 = clamp(Math.floor((x0 + TRACK.X_LIMIT) / LANE_W), 0, LANE_COUNT - 1);
      const l1 = clamp(Math.ceil((x1 + TRACK.X_LIMIT) / LANE_W), 0, LANE_COUNT - 1);
      for (let k = k0; k <= k1; k++) {
        const row = blocked[k];
        for (let l = l0; l <= l1; l++) row[l] = 1;
      }
    }
  }

  // Forward reachability.
  const fwd: Uint8Array[] = [new Uint8Array(LANE_COUNT)];
  for (let l = 0; l < LANE_COUNT; l++) {
    fwd[0][l] = entry[l] && !blocked[0][l] ? 1 : 0;
  }
  for (let k = 1; k <= steps; k++) {
    const prev = fwd[k - 1];
    const cur = new Uint8Array(LANE_COUNT);
    for (let l = 0; l < LANE_COUNT; l++) {
      if (blocked[k][l]) continue;
      const lo = Math.max(0, l - reachLanes);
      const hi = Math.min(LANE_COUNT - 1, l + reachLanes);
      for (let p = lo; p <= hi; p++) {
        if (prev[p]) {
          cur[l] = 1;
          break;
        }
      }
    }
    fwd.push(cur);
  }

  const exitLanes = fwd[steps];
  let anyExit = false;
  for (let l = 0; l < LANE_COUNT; l++) if (exitLanes[l]) anyExit = true;
  if (!anyExit) return { ok: false, exitLanes, path: [] };

  // Backward pass: which cells can still reach the exit.
  const bwd: Uint8Array[] = new Array(steps + 1);
  bwd[steps] = exitLanes;
  for (let k = steps - 1; k >= 0; k--) {
    const next = bwd[k + 1];
    const cur = new Uint8Array(LANE_COUNT);
    for (let l = 0; l < LANE_COUNT; l++) {
      if (blocked[k][l] || !fwd[k][l]) continue;
      const lo = Math.max(0, l - reachLanes);
      const hi = Math.min(LANE_COUNT - 1, l + reachLanes);
      for (let n = lo; n <= hi; n++) {
        if (next[n]) {
          cur[l] = 1;
          break;
        }
      }
    }
    bwd[k] = cur;
  }

  // Fairness: every original entry lane must be able to reach a surviving
  // cell within the runway slack.
  for (let l = 0; l < LANE_COUNT; l++) {
    if (!entryLanes[l]) continue;
    let ok = false;
    const lo = Math.max(0, l - runwayLanes);
    const hi = Math.min(LANE_COUNT - 1, l + runwayLanes);
    for (let m = lo; m <= hi; m++) {
      if (bwd[0][m]) {
        ok = true;
        break;
      }
    }
    if (!ok) return { ok: false, exitLanes, path: [] };
  }

  // Representative path: greedy centered walk through the safe set.
  const path: [number, number][] = [];
  let lane = -1;
  {
    let best = -1;
    let bestScore = Infinity;
    for (let l = 0; l < LANE_COUNT; l++) {
      if (bwd[0][l]) {
        const score = Math.abs(l - (LANE_COUNT - 1) / 2);
        if (score < bestScore) {
          bestScore = score;
          best = l;
        }
      }
    }
    lane = best;
  }
  for (let k = 0; k <= steps; k++) {
    const safe = bwd[k];
    let best = -1;
    let bestScore = Infinity;
    const lo = k === 0 ? lane : Math.max(0, lane - reachLanes);
    const hi = k === 0 ? lane : Math.min(LANE_COUNT - 1, lane + reachLanes);
    for (let l = lo; l <= hi; l++) {
      if (!safe[l]) continue;
      const score = Math.abs(l - lane) + Math.abs(l - (LANE_COUNT - 1) / 2) * 0.08;
      if (score < bestScore) {
        bestScore = score;
        best = l;
      }
    }
    if (best === -1) break;
    lane = best;
    path.push([s0 + k * DS, laneToX(lane)]);
  }

  const result: ValidationResult = { ok: true, exitLanes, path };
  if (collectDebug) {
    result.slices = blocked.map((b, k) => ({ s: s0 + k * DS, blocked: b }));
  }
  return result;
}

/** Full-open lane mask (used at run start). */
export function openLanes(marginMeters = 1): Uint8Array {
  const lanes = new Uint8Array(LANE_COUNT);
  const m = Math.round(marginMeters / LANE_W);
  for (let l = m; l < LANE_COUNT - m; l++) lanes[l] = 1;
  return lanes;
}

/** Lane mask from a corridor center/half-width. */
export function corridorLanes(x: number, half: number): Uint8Array {
  const lanes = new Uint8Array(LANE_COUNT);
  const l0 = xToLane(x - half);
  const l1 = xToLane(x + half);
  for (let l = l0; l <= l1; l++) lanes[l] = 1;
  return lanes;
}

/** Widest contiguous run in a lane mask -> corridor center/half. */
export function widestCorridor(lanes: Uint8Array): { x: number; half: number } {
  let bestStart = 0, bestLen = 0, curStart = -1, curLen = 0;
  for (let l = 0; l <= lanes.length; l++) {
    if (l < lanes.length && lanes[l]) {
      if (curStart === -1) curStart = l;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen === 0) return { x: 0, half: 4 };
  const x0 = laneToX(bestStart);
  const x1 = laneToX(bestStart + bestLen - 1);
  return { x: (x0 + x1) / 2, half: Math.max(1, (x1 - x0) / 2) };
}
