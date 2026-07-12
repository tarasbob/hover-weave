/**
 * Shared gameplay types.
 * `s` = distance along the track (meters). Render world z = -(s - craftDistance).
 */

export type ObstacleKind = "box" | "pillar" | "crystal" | "sphere" | "ring" | "decor";

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
} as const;
export type MotionType = (typeof Motion)[keyof typeof Motion];

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
  /** Motion scratch (FallY: fall progress / velocity). */
  state: number;
  landed: boolean;
  nearMissed: boolean;
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
  /** Callout broadcast for set-pieces. */
  announce?: string;
}

export type PatternCategory = "normal" | "setpiece" | "breather";

export interface PatternDef {
  id: string;
  category: PatternCategory;
  weight: number;
  minDifficulty: number;
  maxDifficulty: number;
  /** Restrict to biome indices (undefined = all). */
  biomes?: number[];
  /** Only eligible when the entry corridor half-width is at most this. */
  maxEntryHalf?: number;
  /** Only eligible when the entry corridor half-width is at least this. */
  minEntryHalf?: number;
  build(ctx: BuildCtx): PatternResult;
}

export type RunStatus = "idle" | "running" | "dead";
