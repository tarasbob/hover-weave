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
  /**
   * Distance ahead of the craft that must always be generated. Deep enough
   * that everything materializes fully buried in fog — no visible pop-in.
   */
  GEN_HORIZON: 720,
  /** Obstacles further behind than this are recycled. */
  DESPAWN_BEHIND: 26,
  /** Instances scale from 0 to full size across this band inside the horizon. */
  MATERIALIZE_START: 680,
  MATERIALIZE_END: 540,
} as const;

export const SPEED = {
  BASE: 30,
  MAX: 90,
  /** Distance (m) over which speed approaches max (asymptotic). */
  RAMP_DISTANCE: 5600,
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
  NEAR_MISS_CLEARANCE: 1.3,
  /** Display/reward thresholds measured from the craft collision hull. */
  PERFECT_CLEARANCE: 0.24,
  RAZOR_CLEARANCE: 0.62,
  CLOSE_POINTS: 0.75,
  RAZOR_POINTS: 1.3,
  PERFECT_POINTS: 2,
  CLOSE_SCORE: 30,
  RAZOR_SCORE: 70,
  PERFECT_SCORE: 125,
  POINTS_PER_SHARD: 0.15,
  /** Near misses inside this window form a precision chain. */
  CHAIN_WINDOW: 2.75,
  CHAIN_SCORE_STEP: 0.07,
  CHAIN_SCORE_CAP: 0.7,
  /** Seconds of no flow events before decay starts. */
  DECAY_GRACE: 2.9,
  /** Points lost per second once decaying. */
  DECAY_RATE: 1.35,
  /** High Flow demands more frequent committed play. */
  DECAY_RATE_PER_HIGH_TIER: 0.22,
  GRACE_LOSS_PER_HIGH_TIER: 0.18,
  SHIELD_PENALTY: 7,
  MAX_POINTS: 28,
  /** Score multiplier = 1 + points * this. */
  MULT_PER_POINT: 0.25,
  /** Points per audio/visual tier. */
  POINTS_PER_TIER: 5,
} as const;

export const ENERGY = {
  MAX: 100,
  START: 12,
  PER_SHARD: 5,
  COMBO_WINDOW: 1.35,
  COMBO_CAP: 8,
  COMBO_ENERGY_STEP: 0.4,
  COMBO_SCORE_STEP: 0.16,
  BOOST_DRAIN: 34,
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
/** Covers 250ms exactly; longer stalls auto-pause instead of slowing the run. */
export const MAX_STEPS_PER_FRAME = 30;

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
