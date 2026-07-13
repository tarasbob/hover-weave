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
   * Minimum distance ahead of the craft that must always be generated. The
   * live horizon is speed-proportional (see LOOKAHEAD / lookaheadFor) so the
   * warning window stays measured in seconds, not meters.
   */
  GEN_HORIZON: 720,
  /** Obstacles further behind than this are recycled. */
  DESPAWN_BEHIND: 26,
} as const;

/**
 * Speed-proportional lookahead. Generation, the materialize band, and fog
 * visibility all scale together with speed so "seconds of warning" is
 * constant: fog density is multiplied by GEN_HORIZON / lookahead, keeping
 * (density × materialize distance) invariant — geometry always materializes
 * fully buried in fog, no pop-in at any speed.
 */
export const LOOKAHEAD = {
  /** Seconds of generated + visible track ahead at the current speed. */
  SECONDS: 8,
  /**
   * Render-budget bound on the horizon (fog floor, camera far plane, terrain
   * depth are sized against it). Holds the full 8 s window through ~195 m/s;
   * beyond that the window degrades gently instead of costs growing.
   */
  MAX: 1560,
  /** Instances scale 0 → full across this band (fractions of the horizon). */
  MATERIALIZE_START_FRAC: 680 / 720,
  MATERIALIZE_END_FRAC: 540 / 720,
} as const;

/** Generated/visible distance ahead for a given speed (720 m ⇔ 8 s at 90). */
export function lookaheadFor(speed: number): number {
  return Math.min(
    LOOKAHEAD.MAX,
    Math.max(TRACK.GEN_HORIZON, speed * LOOKAHEAD.SECONDS),
  );
}

/**
 * The endless late game. Difficulty's 0..1 envelope saturates by ~8 km (all
 * patterns are authored against it); overdrive is the unbounded pressure
 * channel that keeps climbing past it: +1 per doubling of distance beyond
 * START. Drives late speed growth, seam shrink, validator corridor
 * tightening, and mutator aggression.
 */
export const OVERDRIVE = {
  /** Track distance (m) where the late-game channel opens. */
  START: 8000,
  /** Distance scale of one overdrive octave (log2 doubling). */
  HALF: 8000,
  /** Extra target speed per overdrive octave (m/s, slow and unbounded). */
  SPEED_PER_OCTAVE: 7,
} as const;

/** Unbounded late-game pressure: 0 through START, then log2 growth. */
export function overdriveAt(s: number): number {
  if (s <= OVERDRIVE.START) return 0;
  return Math.log2(1 + (s - OVERDRIVE.START) / OVERDRIVE.HALF);
}

export const SPEED = {
  BASE: 30,
  /**
   * Asymptote of the early speed ramp — not a cap. Past OVERDRIVE.START the
   * target speed keeps growing by OVERDRIVE.SPEED_PER_OCTAVE per octave
   * (speedNorm and other FX consumers saturate here by design).
   */
  MAX: 90,
  /** Distance (m) over which speed approaches MAX (asymptotic). */
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
  /**
   * Soft cap: points climb past this freely, but everything above bleeds
   * continuously (no grace) at DECAY_RATE * OVER_DECAY_QUAD * over^2 per
   * second. Sustained elite streams find an equilibrium ~sqrt(event rate)
   * instead of a wall; below the soft cap behavior is identical to the
   * classic capped meter.
   */
  MAX_POINTS: 28,
  OVER_DECAY_QUAD: 0.028,
  /** Score multiplier = 1 + points * this. */
  MULT_PER_POINT: 0.25,
  /** Points per audio/visual tier. */
  POINTS_PER_TIER: 5,
  /** Speed bonus per flow tier (fraction of target speed). */
  SPEED_BONUS_PER_TIER: 0.035,
  /**
   * Flow tiers are uncapped for scoring, but the speed bonus stops growing
   * here (the pre-uncap maximum) so speed stays a boost-driven ratchet.
   */
  SPEED_BONUS_TIER_CAP: 5,
  /**
   * Precision rewards scale with speed: score x (speed / SPEED.BASE)^exp
   * (floored at x1). Grazing at 130 m/s pays ~x9 what it pays at base speed.
   */
  SPEED_REWARD_EXP: 1.5,
  /** Flow-point gain uses a damped speed factor, capped here (tier spikes stay bounded). */
  SPEED_FLOW_FACTOR_CAP: 2.5,
} as const;

export const ENERGY = {
  MAX: 100,
  START: 12,
  PER_SHARD: 5,
  COMBO_WINDOW: 1.35,
  COMBO_CAP: 8,
  COMBO_ENERGY_STEP: 0.4,
  COMBO_SCORE_STEP: 0.16,
  BOOST_DRAIN: 30,
  /** Minimum energy required to ignite a boost. */
  BOOST_MIN: 8,
  SHARD_SCORE: 40,
  /** Radius within which shards get magnetised toward the craft. */
  MAGNET_RADIUS: 5.5,
  COLLECT_RADIUS: 1.7,
  /** Grazes fund boost: energy per confirmed pass, by precision grade. */
  GRAZE_CLOSE: 1.5,
  GRAZE_RAZOR: 7,
  GRAZE_PERFECT: 12,
  /** Graze/thread energy income multiplier while boosting (perpetual-boost loop). */
  BOOST_REFUND: 1.75,
} as const;

/**
 * Thread the needle: passing obstacles on BOTH sides within a short
 * along-track window pays a bonus on top of any individual grazes.
 * Pairing accepts "pressed" passes (hull clearance < CLEARANCE, looser than
 * the near-miss threshold) so choosing the tighter of two gaps is valued
 * even when the gap is too wide for double near-miss payouts.
 */
export const THREAD = {
  /** Passes with hull clearance under this can pair into a thread. */
  CLEARANCE: 2.6,
  /** Max craft travel (m) between the two opposite-side passes. */
  WINDOW: 10,
  /** Thread base score spans MIN..MAX with tightness^2 (worse side of the pair). */
  SCORE_MIN: 45,
  SCORE_MAX: 210,
  /** True double-graze needles also repay both awards * (BONUS_MULT - 1). */
  BONUS_MULT: 1.5,
  FLOW_POINTS: 2,
  ENERGY: 3,
} as const;

/**
 * Danger-weighted scoring: the passive (distance) score rate compares where
 * the craft flies against what geometry is available nearby.
 *
 *   factor = 1 + BONUS * engagement - PENALTY * availability * (1 - engagement)
 *
 * - Empty stretches (nothing to dodge): availability ~0 -> factor ~1 (neutral).
 * - Threading dense geometry: engagement ~1 -> up to 1 + BONUS.
 * - Hugging the empty flank while a field rages elsewhere: availability ~1,
 *   engagement ~0 -> down to 1 - PENALTY ("edge-hugging pays ~nothing").
 */
export const DANGER = {
  /** Along-track half-window for both samples (m). */
  S_WINDOW: 48,
  /** Lateral reach of the engagement kernel from the craft hull (m). */
  X_REACH: 12,
  /** engagement = 1 - e^(-lateralWeightedDensity / REF_ENGAGE). */
  REF_ENGAGE: 1.9,
  /** availability = 1 - e^(-alongTrackDensity / REF_AVAIL). */
  REF_AVAIL: 2.6,
  BONUS: 0.8,
  PENALTY: 0.75,
} as const;

export const RUN = {
  /** Sim timescale during the death slow-mo. */
  DEATH_SLOWMO: 0.22,
  DEATH_SLOWMO_DURATION: 1.15,
  /** Seconds a finished (not crashed) run glides before the world freezes. */
  FINISH_GLIDE_DURATION: 1.4,
  /** Invulnerability seconds after a shield absorbs a hit. */
  SHIELD_IFRAMES: 1.1,
} as const;

/** Sprint mode (roadmap 4.2): fixed-length score attack on a weekly seed. */
export const SPRINT_MODE = {
  /** Run length in sim seconds (pause does not consume it). */
  DURATION: 180,
} as const;

/** Fixed timestep for the simulation (seconds). */
export const FIXED_DT = 1 / 120;
/** Covers 250ms exactly; longer stalls auto-pause instead of slowing the run. */
export const MAX_STEPS_PER_FRAME = 30;

export const BIOME_LENGTH = 2400;
export const BIOME_TRANSITION = 320;

/**
 * Render instance pools. Sized for the LOOKAHEAD.MAX horizon (~2.2× the
 * 720 m baseline); simtest asserts per-kind peak headroom.
 */
export const POOL_SIZES = {
  box: 1100,
  pillar: 560,
  crystal: 440,
  sphere: 170,
  ring: 84,
  shard: 280,
  shield: 18,
  decor: 380,
} as const;

export type PoolName = keyof typeof POOL_SIZES;
