/**
 * Pilot Rating (roadmap 4.4). No backend exists, so serious rating comes from
 * fixed-seed trials normalized by their automated reference distances. The
 * legacy wall-anchor function remains useful for synthetic frontier reports.
 *
 * - Performance is piecewise-linear in log2(distance) through the anchors —
 *   distance is the skill axis the walls measure (score is economy-skill and
 *   heat-inflatable; distance is the honest survival metric).
 * - Provisional phase: early runs move the needle fast, veterans settle.
 *   One great run can't spoof a rating; ten can earn it.
 * - Random-seed endless, daily periods, heat, and sprint never move rating.
 */

import { clamp } from "./mathUtils";

/**
 * (distance m, rating) anchors — bot walls from the simtest calibration.
 * Re-baked 2026-07-16 with the skyhook mainline (fun-frontier 6.1).
 */
const ANCHORS: readonly [number, number][] = [
  [150, 400], // barely off the launch ramp
  [2370, 1200], // greedy band-scan wall
  [3449, 1700], // lookahead planner wall
  [8000, 2200], // overdrive threshold — beyond every heuristic tier
  [30306, 3000], // TAS rollout searcher wall
];

export const RATING = {
  FLOOR: 100,
  CEIL: 3600,
  START: 400,
  /** Runs before the provisional K decays to the settled K. */
  PROVISIONAL_RUNS: 12,
  K_PROVISIONAL: 0.3,
  K_SETTLED: 0.1,
} as const;

/** Rating-equivalent performance of a single run's distance. */
export function runPerformance(distance: number): number {
  const d = Math.max(1, distance);
  const lg = Math.log2(d);
  const first = ANCHORS[0];
  const last = ANCHORS[ANCHORS.length - 1];
  let lo = first;
  let hi = last;
  if (d <= first[0]) {
    // Below the first anchor: scale down proportionally in log space.
    return clamp((lg / Math.log2(first[0])) * first[1], RATING.FLOOR, RATING.CEIL);
  }
  for (let i = 1; i < ANCHORS.length; i++) {
    if (d <= ANCHORS[i][0]) {
      lo = ANCHORS[i - 1];
      hi = ANCHORS[i];
      break;
    }
    lo = ANCHORS[i - 1];
    hi = ANCHORS[i];
  }
  // Interpolate (or extrapolate past the last anchor) in log2 space.
  const t = (lg - Math.log2(lo[0])) / (Math.log2(hi[0]) - Math.log2(lo[0]));
  return clamp(lo[1] + t * (hi[1] - lo[1]), RATING.FLOOR, RATING.CEIL);
}

/** One Elo-ish update; `ratedRuns` is the count BEFORE this run. */
export function updateRating(rating: number, ratedRuns: number, distance: number): number {
  return updateRatingFromPerformance(rating, ratedRuns, runPerformance(distance));
}

/**
 * Performance on a fixed-seed trial, normalized by its deepest automated
 * reference distance. This removes random endless-seed luck from the serious
 * offline rating signal.
 */
export function referencePerformance(distance: number, reference: number): number {
  const ratio = Math.max(0, distance / Math.max(1, reference));
  const anchors: readonly [number, number][] = [
    [0, RATING.FLOOR],
    [0.08, 400],
    [0.2, 850],
    [0.4, 1400],
    [0.6, 1900],
    [0.8, 2450],
    [1, 3000],
    [1.15, RATING.CEIL],
  ];
  for (let i = 1; i < anchors.length; i++) {
    if (ratio <= anchors[i][0]) {
      const lo = anchors[i - 1];
      const hi = anchors[i];
      const t = (ratio - lo[0]) / (hi[0] - lo[0]);
      return clamp(lo[1] + (hi[1] - lo[1]) * t, RATING.FLOOR, RATING.CEIL);
    }
  }
  return RATING.CEIL;
}

/** Elo-style smoothing toward an already normalized performance value. */
export function updateRatingFromPerformance(
  rating: number,
  ratedRuns: number,
  perf: number,
): number {
  const k = ratedRuns < RATING.PROVISIONAL_RUNS ? RATING.K_PROVISIONAL : RATING.K_SETTLED;
  return clamp(Math.round(rating + k * (perf - rating)), RATING.FLOOR, RATING.CEIL);
}

export interface RatingTier {
  name: string;
  min: number;
}

/** Display bands, lowest first. */
export const RATING_TIERS: readonly RatingTier[] = [
  { name: "DRIFTER", min: 0 },
  { name: "PILOT", min: 700 },
  { name: "ACE", min: 1100 },
  { name: "RAZOR", min: 1500 },
  { name: "PHANTOM", min: 1900 },
  { name: "SPECTRE", min: 2300 },
  { name: "WEAVER", min: 2700 },
];

export function ratingTier(rating: number): RatingTier {
  let tier = RATING_TIERS[0];
  for (const t of RATING_TIERS) {
    if (rating >= t.min) tier = t;
  }
  return tier;
}
