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

/**
 * The winding track (seeded course centerline). Patterns are still built and
 * validated in a straight local frame; the offset is applied when chunks
 * spawn into the world, and the craft clamp follows offset ± X_LIMIT. The
 * drift itself demands steering, so its worst-case slope must stay well
 * under the craft's physical slope (~0.5) minus the validator's planning
 * slope (0.25 early, 0.375 when difficulty ≥ 0.64) — hence the late taper.
 */
export const COURSE = {
  /** Hard bound on |offset| (amplitude budget + margin, for tests/render). */
  MAX_OFFSET: 17.5,
  /** Distance (m) over which the wander ramps in from a straight launch. */
  RAMP_IN: 900,
  /** Worst-case wave slope at full amplitude (sum over octaves). */
  SLOPE_EARLY: 0.062,
  /** Amplitude multiplier once the difficulty taper has fully applied. */
  LATE_SCALE: 0.35,
  /** Difficulty band across which the late taper blends in. */
  TAPER_D0: 0.5,
  TAPER_D1: 0.68,
} as const;

/** Shatterable glass: boost is the key. */
export const GLASS = {
  /** Boost charge (0..1) required for a contact to shatter instead of kill. */
  SMASH_CHARGE: 0.45,
  SCORE: 90,
  FLOW: 1,
  ENERGY: 6,
} as const;

/** Elastic bumpers: a boing instead of a death. */
export const BUMPER = {
  /** Minimum lateral fling speed (m/s). */
  MIN_FLING: 13,
  /** Fling speed as a fraction of forward speed. */
  FLING_K: 0.34,
  /** Seconds before the same bumper can fling again (also the squash time). */
  COOLDOWN: 0.3,
  /** Forward speed retained through the impact. */
  SPEED_KEEP: 0.96,
  SCORE: 25,
  FLOW: 0.5,
} as const;

/** Pulse beams (Blink motion): readable charge telegraph before firing. */
export const BEAM = {
  /** Fraction of the cycle before ON during which the charge glow builds. */
  CHARGE_FRAC: 0.28,
} as const;

/** Serpent segments: fixed lateral wobble around the spine anchor. */
export const SERPENT = {
  WOBBLE: 1.4,
} as const;

/**
 * Drama director: rare seeded global events. Distances in meters of track.
 * Meteors only land ≥ METEOR_PATH_CLEAR away from the validator's solved
 * safe line, so the proven corridor survives every barrage.
 */
export const EVENTS = {
  /** No events before this distance (let the opening teach itself). */
  START: 1200,
  GAP_MIN: 900,
  GAP_MAX: 1600,
  METEOR_LENGTH: 320,
  RUSH_LENGTH: 260,
  METEOR_SPACING_MIN: 26,
  METEOR_SPACING_MAX: 42,
  /** Meteors keep this lateral clearance (m) from the solved safe path. */
  METEOR_PATH_CLEAR: 5,
  /** Impact point lands this far ahead of the craft (m). */
  METEOR_LEAD_MIN: 170,
  METEOR_LEAD_MAX: 300,
  /** Rush shards start this far ahead of the craft (m). */
  RUSH_LEAD: 90,
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

/**
 * Surge windows (roadmap 5.1, lab prototype — default off): a perfect pass
 * or thread opens a short window of free boost. Chaining perfects sustains
 * it; the graze refund loop (1.1) still runs underneath.
 */
export const SURGE = {
  /** Seconds of free boost (no drain, ignites on an empty meter) per window. */
  WINDOW: 0.6,
} as const;

/**
 * Phase dash (roadmap 5.3, lab prototype — default off): the third verb. A
 * short fixed-rate lateral burst in the held steering direction. Priced in
 * energy, gated by a cooldown, and deliberately without i-frames — the
 * validator never assumes it, so every track stays steer-solvable.
 */
export const DASH = {
  /** Lateral displacement of one dash (m). */
  DISTANCE: 7,
  /** Seconds the burst lasts (steering is committed while it runs). */
  TIME: 0.11,
  /** Seconds between dashes. */
  COOLDOWN: 2,
  /** Energy price (the full amount is required to fire). */
  ENERGY: 25,
  /** Minimum |steering axis| that gives the dash a direction. */
  MIN_AXIS: 0.25,
  /** Lateral momentum kept when the burst ends (a reposition, not a fling). */
  EXIT_MOMENTUM: 0.25,
} as const;

/**
 * Rhythm resonance (fun-frontier 2.1 — mainline since v2, formerly lab 5.4):
 * every mover phase-locks to a fixed tempo's beat grid, the audio transport
 * pins to the same BPM, and perfect passes confirmed on the beat grade
 * "resonant". The world is a moving timetable; elites arrive on the beat.
 */
export const RESONANCE = {
  /** Fixed tempo (BPM) shared by the sim's beat grid and the transport. */
  BPM: 116,
  /** Half-window (s) around a beat for a perfect to grade resonant. */
  WINDOW: 0.07,
  /** Extra score multiplier on resonant perfects. */
  BONUS: 1.25,
} as const;

/**
 * Carve physics (fun-frontier 1.2, lab prototype "carve" — default off).
 * Four interlocking techniques on the same two steer buttons:
 *
 * - Flick: the first moments of a fresh committed press bite harder, so
 *   micro-taps are snappier than holds (cadence becomes accel control).
 * - Pump: reversing the press while carrying enough lateral speed rebounds
 *   the carve — carried speed mirrors into the new direction and gains a
 *   bonus bite (stronger while boosting). Mistimed flips get plain physics
 *   and bleed everything to drag.
 * - Glide: pump chains may push lateral speed past the steering ratio, up
 *   to OVER_RATIO × the cap. Only the excess decays (slowly), and steering
 *   *into* the glide adds nothing — pumps are the only fuel.
 * - Wall-kiss: pressing away from the lateral clamp at the moment of
 *   contact reflects the into-wall component instead of absorbing it.
 *
 * Not `as const`: the dev console exposes this object (`__carve`) as the
 * feel-tuning harness — mutate values live, restart the run, re-feel.
 */
export const CARVE = {
  /** Seconds of boosted acceleration after a fresh committed press. */
  FLICK_WINDOW: 0.09,
  /** Acceleration multiplier inside the flick window. */
  FLICK_BOOST: 1.6,
  /** |latVel| >= this × maxLat at the reversal for a pump to fire. */
  PUMP_MIN_FRAC: 0.55,
  /** Reversals at or above this fraction receive full pump quality. */
  PUMP_FULL_FRAC: 0.95,
  /** Fraction of carried speed mirrored into the new direction. */
  PUMP_KEEP: 0.9,
  /** Extra bite, as a fraction of maxLat, added on top of the mirror. */
  PUMP_BONUS: 0.3,
  /** Pump bonus multiplier while boosting (boost-carve sequencing). */
  PUMP_BOOST_GAIN: 1.3,
  /** Anti-chatter lockout; optimal timing still follows carried velocity. */
  PUMP_COOLDOWN: 0.16,
  /** Lateral speed hard cap as a multiple of maxLat. */
  OVER_RATIO: 1.45,
  /** Per-second decay of the excess above maxLat while gliding. */
  GLIDE_DRAG: 1.6,
  /** Fraction of the into-wall velocity component a wall-kiss reflects. */
  WALL_KISS_KEEP: 0.8,
  /** Committed-direction threshold on the quantized axis. */
  COMMIT: 0.25,
};

/**
 * Skyhook ramps (fun-frontier 6.1, mainline): authored wedges loft the craft
 * into a ballistic jump — the only way the craft ever leaves hover height,
 * so every non-ramp meter stays bit-identical to pre-ramp physics. Jumps are
 * always optional routes (the validated ground path never requires one).
 * The skill stack, novice → lifetime:
 *
 * - Approach: launch vy = lip slope × speed × EFFICIENCY (capped at VY_MAX);
 *   boosting into the lip buys height and distance, priced by the usual
 *   thrust-authority trade.
 * - Lip carve: lateral velocity carries ballistically — carving into the lip
 *   jumps diagonally across the course.
 * - Air steering: AIR_AUTHORITY × normal bite with AIR_DRAG damping; enough
 *   to feather a line, not to re-plan it.
 * - Dive: holding boost while airborne pitches down (DIVE_ACCEL) and
 *   converts descent into forward speed (DIVE_SPEED_GAIN × sink rate) —
 *   land sooner, faster, on a spot steered continuously.
 * - Double jump (fun-frontier 6.2, UT-style): a boost TAP that begins and
 *   ends airborne within TAP_WINDOW fires one upward impulse per flight,
 *   priced at JUMP_ENERGY. The impulse is continuous in timing quality —
 *   full JUMP_VY exactly at the apex (|vy| ≈ 0), decaying toward
 *   JUMP_FLOOR × JUMP_VY for sloppy timing — so the UT rhythm (jump,
 *   *beat*, jump) is the skill. Same button as the dive: tap to jump,
 *   hold to dive, so the verb set stays two buttons + boost.
 * - Flare: one committed fresh press within FLARE_WINDOW of touchdown
 *   forgives impact by FLARE_KEEP × timing quality. A flared dive grades
 *   PERFECT: no scrub, the dive's over-target speed is held as a decaying
 *   rush, and flow/score/energy pay out (RESONANT ×1.25 on the beat).
 *   Chattered presses (two fresh presses inside CHATTER_GAP) void the flare,
 *   so PWM steering macros can never farm landings.
 *
 * Landing grades: |vy| ≤ SOFT_VY lands CLEAN. SOFT_VY exceeds the worst
 * boost-free impact *including a full apex double jump* (the gentest bound
 * per authored wedge), so every un-dived arc — a novice's default flight,
 * jumped or not — is clean by construction. An unflared dive lands HARD:
 * HARD_SCRUB of speed and NUMB_TIME of halved steering authority. Risk
 * scales exactly with ambition.
 *
 * Not `as const`: the dev console exposes this object (`__ramp`) as the
 * feel-tuning harness — mutate values live, restart the run, re-feel.
 */
export const RAMP = {
  /** Downward acceleration while airborne (m/s²) — gamey, snappy. */
  GRAVITY: 24,
  /** Fraction of (lip slope × forward speed) converted into launch vy. */
  EFFICIENCY: 0.9,
  /** Launch vy cap (m/s): bounds airtime, so flight length stays linear in speed. */
  VY_MAX: 11,
  /** Steering acceleration multiplier while airborne. */
  AIR_AUTHORITY: 0.25,
  /** Lateral drag while airborne (per second; ground is 5.2 / 8.5). */
  AIR_DRAG: 1.1,
  /** Extra downward acceleration while boost-diving (m/s²). */
  DIVE_ACCEL: 30,
  /** Forward target-speed bonus per m/s of sink rate while diving. */
  DIVE_SPEED_GAIN: 0.55,
  /** Rate at which the craft snaps up onto a ramp surface entered mid-slope. */
  SNAP_UP: 14,
  /** Max boost hold (s) that still reads as a double-jump tap mid-air. */
  TAP_WINDOW: 0.14,
  /** Full-quality double-jump impulse (m/s, sets vy). */
  JUMP_VY: 8.5,
  /** Fraction of JUMP_VY a zero-quality (badly timed) jump still gets. */
  JUMP_FLOOR: 0.55,
  /** Energy price of a double jump (the full amount is required to fire). */
  JUMP_ENERGY: 20,
  /**
   * Impact |vy| at or below this lands clean. Must exceed the worst
   * boost-free impact — a full apex double jump falling from the capped
   * launch apex of the tallest authored lip:
   * sqrt(JUMP_VY² + 2·GRAVITY·(lip + VY_MAX²/(2·GRAVITY))) ≈ 18.4 at
   * lip 3 — so every un-dived arc, jumped or not, lands clean by
   * construction (gentest proves the bound per wedge). Dives (DIVE_ACCEL)
   * blow well past it.
   */
  SOFT_VY: 19,
  /** Fraction of forward speed scrubbed by a hard landing. */
  HARD_SCRUB: 0.1,
  /** Seconds of halved steering authority after a hard landing. */
  NUMB_TIME: 0.35,
  /** Seconds before touchdown inside which a fresh press counts as a flare. */
  FLARE_WINDOW: 0.14,
  /** Fraction of impact vy a perfectly timed flare forgives. */
  FLARE_KEEP: 0.75,
  /** Minimum flare quality for a cushioned dive to grade perfect. */
  PERFECT_MIN_Q: 0.4,
  /**
   * Minimum raw impact for a flared landing to grade perfect: the flare
   * must be redeeming a real descent (a dived kicker, a jumped arc), not a
   * feather-fall. Below it a flare still cushions — it just grades clean.
   */
  PERFECT_MIN_IMPACT: 14.5,
  /** A fresh press closer than this to the previous one voids the flare. */
  CHATTER_GAP: 0.45,
  /** Committed-direction threshold on the quantized axis (flare detection). */
  COMMIT: 0.25,
  /** Seconds a perfect landing holds its captured over-target speed. */
  RUSH_TIME: 2.5,
  /** Perfect-landing payout: base score and flow/energy awards. */
  LAND_SCORE: 110,
  LAND_FLOW: 2,
  LAND_ENERGY: 8,
  /** Launches with vy below this are silent slips, not events. */
  EVENT_MIN_VY: 2.5,
};

// --- Skyhook flight envelopes (shared by sim, patterns, and test gates) -----

/** Launch vy off a wedge (`lipHeight` over `deckLen`) ridden at `speed`. */
export function rampLaunchVy(lipHeight: number, deckLen: number, speed: number): number {
  return Math.min((lipHeight / deckLen) * speed * RAMP.EFFICIENCY, RAMP.VY_MAX);
}

/** Un-dived airtime for a launch at `vy` from `lipHeight` above hover. */
export function rampAirTime(vy: number, lipHeight: number): number {
  return (vy + Math.sqrt(vy * vy + 2 * RAMP.GRAVITY * lipHeight)) / RAMP.GRAVITY;
}

/**
 * Worst-case airtime for a launch at `vy` from `lipHeight`: ride the arc to
 * its apex, then fire a full-quality double jump (the airtime-maximal spot —
 * greatest height, zero wasted upward velocity) and fall from there.
 */
export function rampMaxAirTime(vy: number, lipHeight: number): number {
  const g = RAMP.GRAVITY;
  const apex = lipHeight + (vy * vy) / (2 * g);
  const j = RAMP.JUMP_VY;
  return vy / g + (j + Math.sqrt(j * j + 2 * g * apex)) / g;
}

/**
 * Speed ceiling for flight-envelope planning: full boost over the flow
 * speed-bonus ceiling, plus headroom for a landing rush carried into a
 * chained lip. Diving only ever shortens a flight, so the floaty full-boost
 * arc at this speed bounds every reachable landing.
 */
export function rampMaxAirSpeed(speed: number): number {
  return speed * SPEED.BOOST_MULT * 1.22 + 16;
}

/**
 * Worst-case flight length off a wedge at ambient (pre-boost) `speed`,
 * including one apex double jump.
 */
export function rampMaxFlight(lipHeight: number, deckLen: number, speed: number): number {
  const v = rampMaxAirSpeed(speed);
  const vy = rampLaunchVy(lipHeight, deckLen, v);
  return v * rampMaxAirTime(vy, lipHeight);
}

/**
 * Half-width of the guaranteed-clear landing tube beyond a lip: the deck
 * column, residual hands-off lateral drift (air drag bleeds carried carve
 * within the first second), and worst-case winding-course wander across the
 * flight. Patterns keep this tube free of collidable ground-band geometry;
 * a structural test gate re-proves it with simulated hands-off crossings.
 */
export function rampTubeHalf(deckHalfW: number, maxFlight: number): number {
  return deckHalfW + 8 + 0.03 * maxFlight;
}

/** Beat length in seconds at the resonance tempo. */
export const RESONANCE_BEAT = 60 / RESONANCE.BPM;

/** Is `time` within RESONANCE.WINDOW of a beat at the fixed resonance tempo? */
export function onBeatAt(time: number): boolean {
  const pos = time / RESONANCE_BEAT;
  return Math.abs(pos - Math.round(pos)) * RESONANCE_BEAT <= RESONANCE.WINDOW;
}

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
  sphere: 260,
  ring: 84,
  glass: 140,
  bumper: 130,
  beam: 90,
  ramp: 48,
  shard: 340,
  shield: 18,
  decor: 380,
} as const;

export type PoolName = keyof typeof POOL_SIZES;
