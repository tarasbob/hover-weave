/**
 * Trials mode (roadmap 4.1): one authored pattern looped at escalating speed
 * until death. Each trial has a fixed seed (comparable PBs + a true spatial
 * PB ghost — this is the practice room), distance medals, and its own curves:
 *
 * - difficulty ramps from the pattern's authored minimum to 1 over TRIAL.RAMP,
 * - speed grows linearly without bound (reaction time shrinks — the wall is
 *   guaranteed even though STEER.RATIO keeps the geometry dodgeable),
 * - a synthetic pressure channel (the trial's own "overdrive") shrinks seams
 *   and heats mutators far earlier than the endless 8 km threshold.
 *
 * Medals are calibrated against the sim-test autopilot tiers: Bronze is a
 * warm-up, Silver ≈ the greedy bot's wall, Gold ≈ the lookahead planner's
 * wall, Author is beyond both — see the calibration gates in simtest.ts.
 */

import { SPEED } from "../core/constants";
import { clamp01, lerp } from "../core/mathUtils";
import type { PatternDef, PatternSkill } from "../core/types";
import { FIELD_PATTERNS, NORMAL_PATTERNS } from "./patterns";

export type Medal = "bronze" | "silver" | "gold" | "author";
export const MEDAL_ORDER: readonly Medal[] = ["bronze", "silver", "gold", "author"];

export const TRIAL = {
  /** Distance over which difficulty ramps from the pattern floor to 1. */
  RAMP: 1400,
  /** Speed starts near cruise and climbs linearly: +26 m/s per km. */
  SPEED_START: 36,
  SPEED_SLOPE: 0.026,
  /** Synthetic overdrive: 0 → PRESSURE_MAX across PRESSURE_RAMP × MAX meters. */
  PRESSURE_RAMP: 900,
  PRESSURE_MAX: 4,
} as const;

/** Trial target speed at distance s (before boost/flow modifiers). */
export function trialSpeedAt(s: number): number {
  return Math.max(SPEED.BASE, TRIAL.SPEED_START + s * TRIAL.SPEED_SLOPE);
}

/** Trial pressure channel (drop-in for `overdriveAt` in the generator). */
export function trialPressureAt(s: number): number {
  return Math.min(TRIAL.PRESSURE_MAX, s / TRIAL.PRESSURE_RAMP);
}

export interface TrialDef {
  /** Roster id (doubles as the pattern id today). */
  id: string;
  name: string;
  desc: string;
  pattern: PatternDef;
  skills: PatternSkill[];
  /** Distance thresholds (m), strictly increasing. */
  medals: Record<Medal, number>;
  /**
   * The reference line (fun-frontier 4.1): the deepest *proven* line on this
   * trial's exact seed — max of the TAS rollout wall, the lookahead planner
   * wall, and 1.2 × the author medal — from `scripts/refcal.ts`.
   * Deterministic; it only moves when tuning moves. The death screen reports
   * a run as a percentage of this line; nobody is expected to reach 100%.
   */
  reference: number;
  difficultyAt(s: number): number;
  speedAt(s: number): number;
  pressureAt(s: number): number;
}

export function trialSeed(id: string): string {
  return `cubefield-trial-${id}`;
}

const PATTERN_POOL = [...NORMAL_PATTERNS, ...FIELD_PATTERNS];

function defineTrial(
  patternId: string,
  name: string,
  desc: string,
  medals: Record<Medal, number>,
  reference: number,
): TrialDef {
  const pattern = PATTERN_POOL.find((p) => p.id === patternId);
  if (!pattern) throw new Error(`Trial pattern missing from registry: ${patternId}`);
  if (pattern.biomes) throw new Error(`Trial patterns must be biome-free: ${patternId}`);
  const floor = pattern.minDifficulty;
  return {
    id: patternId,
    name,
    desc,
    pattern,
    skills: pattern.skills ?? [],
    medals,
    reference,
    difficultyAt: (s) => lerp(floor, 1, clamp01(s / TRIAL.RAMP)),
    speedAt: trialSpeedAt,
    pressureAt: trialPressureAt,
  };
}

/**
 * Roster: every skill tag covered, ordered as a rough learning ladder.
 *
 * Medal distances calibrated 2026-07 on the deterministic trial seeds via
 * `scripts/trialcal.ts` (greedy / lookahead walls per trial). Gold sits near
 * the better bot's wall — above it for mover patterns bots cannot time
 * (humans can), below it for the raw-speed patterns where a target-chaser
 * out-reacts humans. Bronze ≈ a few clean pattern reps; Author is a
 * statement (~1.5× gold, trial speed 130+ m/s). Drift alarms in simtest.
 *
 * Reference lines from `scripts/refcal.ts` — the deepest proven line per
 * seed: max(TAS rollout wall, lookahead wall, 1.2 × author). The authored
 * floor covers mover-heavy trials where every bot under-times what humans
 * can. Re-baked 2026-07-15 with the resonance-mainline track.
 */
export const TRIALS: TrialDef[] = [
  defineTrial(
    "slalomGates", "Slalom", "Wide gates, honest rhythm. Learn to carry speed.",
    { bronze: 400, silver: 800, gold: 1400, author: 2200 },
    3148,
  ),
  defineTrial(
    "sCurveCanyon", "Canyon Weave", "Commit early — the canyon does not wait.",
    { bronze: 700, silver: 1800, gold: 3600, author: 5400 },
    6480,
  ),
  defineTrial(
    "narrowGates", "Needle Row", "Tight gates. Thread them or bleed speed wide.",
    { bronze: 400, silver: 800, gold: 1400, author: 2200 },
    4484,
  ),
  defineTrial(
    "combTeeth", "Comb Teeth", "Staggered teeth. Read two rows ahead.",
    { bronze: 400, silver: 850, gold: 1500, author: 2300 },
    7078,
  ),
  defineTrial(
    "pendulumAlley", "Pendulums", "Swinging wrecking balls. Time the gaps, not the bobs.",
    { bronze: 500, silver: 1200, gold: 2200, author: 3400 },
    9608,
  ),
  defineTrial(
    "pistonCorridor", "Crusher Lane", "Pistons slam on a beat. Find it and stay on it.",
    { bronze: 700, silver: 2000, gold: 4000, author: 6000 },
    7200,
  ),
  defineTrial(
    "bladeRotors", "Rotors", "Spinning blades own the center. Steal it back.",
    { bronze: 600, silver: 1400, gold: 2700, author: 4100 },
    12544,
  ),
  defineTrial(
    "precisionLadder", "The Ladder", "Each rung tighter than the last. Pure line discipline.",
    { bronze: 400, silver: 800, gold: 1400, author: 2200 },
    5505,
  ),
  defineTrial(
    "chaosField", "Debris Field", "No pattern to memorize. Improvise at speed.",
    { bronze: 450, silver: 900, gold: 1600, author: 2500 },
    6334,
  ),
  defineTrial(
    "splitDecision", "Split Second", "Forks at speed. Choose once, commit forever.",
    { bronze: 400, silver: 750, gold: 1300, author: 2000 },
    5919,
  ),
];

export function trialById(id: string): TrialDef | undefined {
  return TRIALS.find((t) => t.id === id);
}

/** Highest medal earned at this distance (null below bronze). */
export function medalFor(trial: TrialDef, distance: number): Medal | null {
  let earned: Medal | null = null;
  for (const medal of MEDAL_ORDER) {
    if (distance >= trial.medals[medal]) earned = medal;
  }
  return earned;
}

/** The next medal above `distance`, if any (for HUD pressure + death screen). */
export function nextMedalFor(
  trial: TrialDef,
  distance: number,
): { medal: Medal; at: number } | null {
  for (const medal of MEDAL_ORDER) {
    if (distance < trial.medals[medal]) return { medal, at: trial.medals[medal] };
  }
  return null;
}

export const MEDAL_RANK: Record<Medal, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
  author: 4,
};
