/**
 * Shared gameplay types.
 * `s` = distance along the track (meters). Render world z = -(s - craftDistance).
 */

export type ObstacleKind =
  | "box"
  | "pillar"
  | "crystal"
  | "sphere"
  | "ring"
  | "decor"
  /** Shatterable pane: lethal unless hit while boost charge is high. */
  | "glass"
  /** Elastic puck: contact flings the craft sideways instead of killing. */
  | "bumper"
  /** Energy beam: collidable only during the ON phase of its Blink cycle. */
  | "beam"
  /**
   * Skyhook launch wedge (fun-frontier 6.1): a rideable surface that never
   * kills. `hs` = half length, `hx` = half width, `hy` = full lip height
   * (the deck rises linearly toward +s), `y` = 0 (base on the ground).
   * Left `collidable` so the validator and gap-scanning bots plan ground
   * traffic *around* the deck — riding it is always a deliberate choice —
   * while the sim's collision loop skips the kind and the vertical step
   * reads the surface directly.
   */
  | "ramp";
export type PrecisionGrade = "close" | "razor" | "perfect";
/** Airborne touchdown quality (skyhook ramps, fun-frontier 6.1). */
export type LandingGrade = "clean" | "hard" | "perfect";

export const Motion = {
  None: 0,
  /** x = baseX + sin(t * m0 + m1) * m2 */
  SweepX: 1,
  /** Pendulum bob: pivot (x, y), length m0, max angle m1, angular speed m2. */
  Pendulum: 2,
  /** Falls when craft distance passes m0; m1 = resting y. */
  FallY: 3,
  /** yaw = m1 + t * m0. Long blade spinning around its center. */
  RotateYaw: 4,
  /** Orbit around (x, s): radius m0, angular speed m1, phase m2. */
  OrbitXZ: 5,
  /** Slides from x toward m0 as craft distance goes m1 -> m2. */
  CloseIn: 6,
  /** Crusher slam: x = baseX + sign(m2) * pulse(t * m0 + m1) * |m2|. */
  Piston: 7,
  /**
   * On/off duty cycle (beams): phase = frac(t * m0 + m1), solid while
   * phase < m2. The live phase is written to `state` for the renderer.
   */
  Blink: 8,
  /**
   * Serpent segment: spine anchor (x, y), wave rate m0 (rad/s), phase m1,
   * vertical dip amplitude m2 — cy = y - m2 * (0.5 + 0.5 sin(m0 t + m1)),
   * plus a small fixed lateral wobble around x.
   */
  Serpent: 9,
} as const;
export type MotionType = (typeof Motion)[keyof typeof Motion];

/** Randomized mid-run global events (roadmap: drama director). */
export type RunEventKind = "meteor" | "rush";

export type ColorRole = "primary" | "accent" | "warn" | "dim";

export interface ObstacleSpec {
  kind: ObstacleKind;
  /** Center along track (absolute). */
  s: number;
  x: number;
  y: number;
  /** Half extents: lateral, vertical, along-track. */
  hx: number;
  hy: number;
  hs: number;
  yaw?: number;
  motion?: MotionType;
  m0?: number;
  m1?: number;
  m2?: number;
  role?: ColorRole;
  /** Extra emissive boost for this instance (1 = normal). */
  glow?: number;
  collidable?: boolean;
  /** Ring opening half-width (ring kind only). */
  inner?: number;
  /**
   * Validator overrides: worst-case blocked lateral range.
   * Defaults to [x - hx, x + hx] inflated by the motion sweep.
   */
  vx0?: number;
  vx1?: number;
  /** Skip in validation entirely (safe decor). */
  noValidate?: boolean;
}

export interface PickupSpec {
  type: "shard" | "shield";
  s: number;
  x: number;
  y: number;
  /** Risk-route shards can disable the generous collection magnet. */
  magnet?: boolean;
}

export type RouteReward = "energy" | "flow" | "tempo";

/**
 * One visible branch at a decision row. Rewards are expressed by authored
 * geometry/pickups; this metadata names the choice for telemetry and feedback.
 */
export interface RouteChoiceSpec {
  decisionId: string;
  routeId: string;
  label: string;
  reward: RouteReward;
  s: number;
  x: number;
  half: number;
}

/** Live pooled obstacle instance. */
export interface Obstacle {
  id: number;
  active: boolean;
  kind: ObstacleKind;
  s: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
  hs: number;
  yaw: number;
  motion: MotionType;
  m0: number;
  m1: number;
  m2: number;
  role: ColorRole;
  glow: number;
  collidable: boolean;
  inner: number;
  /** Evaluated (current) transform, updated for movers each step. */
  cx: number;
  cy: number;
  cs: number;
  cyaw: number;
  /**
   * Motion scratch. FallY: fall velocity. Blink: live phase (0..1) — the
   * renderer reads it for the charge/fire telegraph. Bumper: sim time until
   * which re-bounces are ignored (and the renderer's squash timer).
   */
  state: number;
  landed: boolean;
  nearMissed: boolean;
  /** Closest collision-hull clearance observed during this pass. */
  nearMissClearance: number;
  /** Which side of the craft the obstacle was on at closest approach (+1 right). */
  nearMissSide: number;
  /** Authored chunk that produced this obstacle, used for useful death feedback. */
  patternId: string;
  /** Sim time when spawned (for scale-in animation). */
  spawnTime: number;
}

export interface Pickup {
  id: number;
  active: boolean;
  type: "shard" | "shield";
  s: number;
  x: number;
  y: number;
  seeking: boolean;
  magnetic: boolean;
  spawnTime: number;
}

export interface BuildCtx {
  rng: import("./rng").Rng;
  s0: number;
  /** 0..1 difficulty at this point. */
  difficulty: number;
  entryX: number;
  entryHalf: number;
  /** Expected craft speed here (m/s). */
  speed: number;
  biome: number;
}

export interface PatternResult {
  length: number;
  exitX: number;
  exitHalf: number;
  obstacles: ObstacleSpec[];
  pickups: PickupSpec[];
  /** Optional state-dependent route choices embedded in this pattern. */
  routes?: RouteChoiceSpec[];
  /** Callout broadcast for set-pieces. */
  announce?: string;
}

export type PatternCategory = "normal" | "setpiece" | "breather" | "field";
export type PatternSkill = "precision" | "rhythm" | "reaction" | "commitment" | "navigation";
export type PatternIntensity = 1 | 2 | 3 | 4 | 5;

export interface PatternDef {
  id: string;
  category: PatternCategory;
  weight: number;
  /** Challenge-director metadata. Existing patterns may use inferred defaults. */
  intensity?: PatternIntensity;
  skills?: PatternSkill[];
  minDifficulty: number;
  maxDifficulty: number;
  /** Restrict to biome indices (undefined = all). */
  biomes?: number[];
  /** Only eligible when the entry corridor half-width is at most this. */
  maxEntryHalf?: number;
  /** Only eligible when the entry corridor half-width is at least this. */
  minEntryHalf?: number;
  /**
   * Only eligible while the ambient target speed is at most this (m/s).
   * Patterns whose safe geometry scales with speed (skyhook landing tubes)
   * must retire before unbounded escalation dilutes them into free track.
   */
  maxSpeed?: number;
  build(ctx: BuildCtx): PatternResult;
}

export type RunStatus = "idle" | "running" | "dead" | "finished";
