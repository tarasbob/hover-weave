/** Run results shared by simulation, replay, progression and presentation. */
import type { HeatId } from "../heat";
import type { LabId } from "../lab";
import type { GameMode } from "../modes";
import type { MotionType, ObstacleKind, PatternSkill, RouteReward } from "../types";

export interface DeathCause {
  /** Older persisted results omit this field and represent obstacle impacts. */
  cause?: "obstacle" | "edge";
  edge?: -1 | 1;
  patternId: string;
  obstacleKind: ObstacleKind | null;
  motion: MotionType;
}

// --- Section grades (roadmap 3.4) ------------------------------------------

export type SectionGrade = "S" | "A" | "B" | "C";

export interface SectionResult {
  patternId: string;
  intensity: number;
  s0: number;
  s1: number;
  grade: SectionGrade;
  /** 0..1 blended line quality (precision / flow uptime / pace). */
  composite: number;
  events: number;
  flowUptime: number;
  /** Fraction of in-chunk steps spent boosting (quest fuel, roadmap 4.5). */
  boostUptime: number;
  pace: number;
}

export interface SectionMetrics {
  intensity: number;
  /** Precision events (near misses + 2x threads) while inside the chunk. */
  events: number;
  /** Meters actually traversed inside the chunk. */
  traversed: number;
  /** Fraction of in-chunk steps spent at flow tier 1+. */
  flowUptime: number;
  /** Average speed inside vs. the ambient target here. */
  avgSpeed: number;
  baseSpeed: number;
}

// --- Forensics (roadmap 3.3) ------------------------------------------------

/** 30 Hz craft trace sample (line, speed, flow, tightest clearance). */
export interface TraceSample {
  s: number;
  x: number;
  /** Craft height (HOVER_HEIGHT unless airborne) — the kill-cam jump arc. */
  y: number;
  speed: number;
  flow: number;
  /** Tightest hull clearance observed since the previous sample (99 = open). */
  clearance: number;
}

/** Lightweight always-on record of a streamed chunk (forensics + grading). */
export interface ChunkRecord {
  s0: number;
  s1: number;
  patternId: string;
  intensity: number;
  skills: PatternSkill[];
  /** Validator's solved safe line through the chunk, as [s, x] pairs. */
  path: [number, number][];
}

export interface ForensicsObstacle {
  kind: ObstacleKind;
  s: number;
  x: number;
  hx: number;
  hs: number;
  yaw: number;
  inner: number;
}

export interface DeathForensics {
  deathS: number;
  deathX: number;
  deathSpeed: number;
  /** Along-track window covered by the snapshot. */
  s0: number;
  s1: number;
  /** Your flown line up to the impact. */
  trace: TraceSample[];
  /** Validator-solved safe line, one polyline segment per chunk. */
  path: [number, number][][];
  /** Obstacle envelopes (current transforms at the death step). */
  obstacles: ForensicsObstacle[];
}

export interface RouteChoiceResult {
  decisionId: string;
  routeId: string;
  label: string;
  reward: RouteReward;
  s: number;
}

export interface RunStats {
  score: number;
  distance: number;
  nearMisses: number;
  closePasses: number;
  razorPasses: number;
  perfectPasses: number;
  threads: number;
  /** Phase dashes fired (lab 5.3 only; 0 otherwise). */
  dashes: number;
  /** Carve pumps landed (lab "carve" only; 0 otherwise). */
  pumps: number;
  /** Sum of normalized pump quality, for post-run technique analysis. */
  pumpQualitySum: number;
  /** Seconds spent above the ordinary lateral-speed envelope. */
  glideTime: number;
  /** Perfects confirmed on the beat grid (mainline since fun-frontier 2.1). */
  resonantPasses: number;
  /** Skyhook launches ridden off a lip (fun-frontier 6.1). */
  jumps: number;
  /** Seconds spent airborne. */
  airTime: number;
  /** Seconds spent boost-diving while airborne. */
  diveTime: number;
  /** Flared touchdowns (any quality > 0). */
  flares: number;
  perfectLandings: number;
  hardLandings: number;
  /** Near misses confirmed while airborne. */
  airGrazes: number;
  /** Longest single flight, lip to touchdown (m). */
  longestFlight: number;
  /** Double jumps fired (fun-frontier 6.2). */
  airJumps: number;
  /** Sum of double-jump timing quality, for the technique sheet. */
  airJumpQualitySum: number;
  /** Glass panes smashed through while boosting. */
  glassSmashed: number;
  /** Bumper flings survived. */
  bounces: number;
  /** Global run events weathered (meteor barrages, golden rushes). */
  runEvents: number;
  shards: number;
  bestShardCombo: number;
  bestFlowChain: number;
  maxFlowPoints: number;
  maxFlowTier: number;
  boosts: number;
  boostTime: number;
  /** Integral of the continuous thrust charge across the run. */
  boostChargeTime: number;
  /** Authored strategic branches selected during the run. */
  routeChoices: RouteChoiceResult[];
  obstacleDrops: number;
  pickupDrops: number;
  duration: number;
  seed: string;
  mode: GameMode;
  /** Trial roster id (mode === "trial" only). */
  trialId: string | null;
  /** Canonical heat stack the run was flown under (endless only). */
  heat: HeatId[];
  /** Canonical lab prototype stack (endless only; non-empty = unranked run). */
  lab: LabId[];
  /** Null for a survived time-limited run (sprint finish). */
  deathCause: DeathCause | null;
  /** Per-chunk line grades in traversal order (roadmap 3.4). */
  sections: SectionResult[];
  /** Intensity-weighted aggregate of the graded sections (null = none graded). */
  lineRating: SectionGrade | null;
}

export function emptyStats(): RunStats {
  return {
    score: 0, distance: 0, nearMisses: 0, shards: 0,
    closePasses: 0, razorPasses: 0, perfectPasses: 0, threads: 0,
    dashes: 0, pumps: 0, pumpQualitySum: 0, glideTime: 0, resonantPasses: 0,
    jumps: 0, airTime: 0, diveTime: 0, flares: 0,
    perfectLandings: 0, hardLandings: 0, airGrazes: 0, longestFlight: 0,
    airJumps: 0, airJumpQualitySum: 0,
    glassSmashed: 0, bounces: 0, runEvents: 0,
    bestShardCombo: 0, bestFlowChain: 0,
    maxFlowPoints: 0, maxFlowTier: 0, boosts: 0, boostTime: 0, boostChargeTime: 0,
    routeChoices: [],
    obstacleDrops: 0, pickupDrops: 0, duration: 0,
    seed: "", mode: "endless", trialId: null, heat: [], lab: [], deathCause: null,
    sections: [], lineRating: null,
  };
}
