/**
 * Central tuning constants for the whole game.
 * Track-space convention: `s` is distance along the track (meters, increasing forward).
 * Render-space: world z = craftDistance - s  (ahead of the craft => negative z).
 */

export const TRACK = {
  /** Craft lateral clamp. */
  X_LIMIT: 30,
  /** Patterns may place geometry within this half width. */
  X_PATTERN: 33,
  /** Distance ahead of the craft that must always be generated. */
  GEN_HORIZON: 420,
  /** Obstacles further behind than this are recycled. */
  DESPAWN_BEHIND: 26,
} as const;

export const SPEED = {
  BASE: 30,
  MAX: 82,
  /** Distance (m) over which speed approaches max (asymptotic). */
  RAMP_DISTANCE: 9000,
  /** Speed multiplier while boosting. */
  BOOST_MULT: 1.45,
  /** Seconds for the initial 0 -> base speed launch ramp. */
  LAUNCH_RAMP: 0.9,
} as const;

export const STEER = {
  /**
   * Steering scales with forward speed so pattern geometry stays dodgeable at
   * any velocity — speed compresses reaction time instead of removing options.
   * Max lateral speed = RATIO * forward speed.
   */
  RATIO: 0.58,
  /** Lateral acceleration = ACCEL_K * forward speed (steady state == RATIO). */
  ACCEL_K: 2.75,
  /** Exponential damping applied to lateral velocity (per second). */
  DRAG: 5.2,
  /** Extra damping when there is no input (snappier release). */
  RELEASE_DRAG: 8.5,
  /** Steering authority multiplier while boosting. */
  BOOST_AUTHORITY: 0.62,
  MAX_BANK: 0.62,
} as const;

export const CRAFT = {
  RADIUS: 0.75,
  HOVER_HEIGHT: 1.15,
  /** Vertical collision extent of the craft. */
  Y_MIN: 0.35,
  Y_MAX: 2.05,
} as const;

export const FLOW = {
  /** Lateral clearance (m) under which a pass counts as a near miss. */
  NEAR_MISS_CLEARANCE: 1.25,
  /** Flow points gained per near miss. */
  POINTS_PER_NEAR_MISS: 1,
  /** Seconds of no flow events before decay starts. */
  DECAY_GRACE: 2.9,
  /** Points lost per second once decaying. */
  DECAY_RATE: 1.35,
  MAX_POINTS: 28,
  /** Score multiplier = 1 + points * this. */
  MULT_PER_POINT: 0.25,
  /** Points per audio/visual tier. */
  POINTS_PER_TIER: 5,
} as const;

export const ENERGY = {
  MAX: 100,
  PER_SHARD: 7,
  BOOST_DRAIN: 30,
  /** Minimum energy required to ignite a boost. */
  BOOST_MIN: 8,
  SHARD_SCORE: 40,
  /** Radius within which shards get magnetised toward the craft. */
  MAGNET_RADIUS: 5.5,
  COLLECT_RADIUS: 1.7,
} as const;

export const RUN = {
  /** Sim timescale during the death slow-mo. */
  DEATH_SLOWMO: 0.22,
  DEATH_SLOWMO_DURATION: 1.15,
  /** Invulnerability seconds after a shield absorbs a hit. */
  SHIELD_IFRAMES: 1.1,
} as const;

/** Fixed timestep for the simulation (seconds). */
export const FIXED_DT = 1 / 120;
export const MAX_STEPS_PER_FRAME = 10;

export const BIOME_LENGTH = 2400;
export const BIOME_TRANSITION = 320;

export const POOL_SIZES = {
  box: 640,
  pillar: 320,
  crystal: 256,
  sphere: 96,
  ring: 48,
  shard: 160,
  shield: 12,
  decor: 220,
} as const;

export type PoolName = keyof typeof POOL_SIZES;
