import {
  BUMPER,
  CARVE,
  CRAFT,
  DASH,
  ENERGY,
  FIXED_DT,
  FLOW,
  GLASS,
  lookaheadFor,
  MAX_STEPS_PER_FRAME,
  onBeatAt,
  RAMP,
  RESONANCE,
  RUN,
  SPEED,
  SPRINT_MODE,
  STEER,
  SURGE,
  THREAD,
  TRACK,
} from "./constants";
import { Emitter } from "./events";
import { NO_HEAT, normalizeHeat, resolveHeat, type HeatEffects } from "./heat";
import { NO_LAB, normalizeLab, resolveLab, type LabEffects } from "./lab";
import type { InputState } from "./input";
import { FixedTickActions } from "./actionInput";
import { clamp, clamp01, lerp } from "./mathUtils";
import type { GameMode, RunConfig } from "./modes";
import { InputRecorder, quantizeAxis, type RunRecording } from "./replay";
import { createRng } from "./rng";
import {
  type LandingGrade,
  type Obstacle,
  type ObstacleSpec,
  type Pickup,
  type PrecisionGrade,
  type RouteChoiceSpec,
  type RunEventKind,
  type RunStatus,
} from "./types";
import { biomeIndexAt, BIOMES, MYTHIC_ZONES } from "../track/biomes";
import { Course } from "../track/course";
import { speedAt, TrackGenerator, type GeneratedChunk } from "../track/generator";
import { trialById, type TrialDef } from "../track/trials";

import { EntityPools } from "./simulation/entityPools";
import { EventDirector } from "./simulation/eventDirector";
import { ObstacleSystem } from "./simulation/obstacleSystem";
import { GRADE_MIN_INTENSITY, RunAnalysis } from "./simulation/runAnalysis";
import {
  emptyStats,
  type ChunkRecord,
  type DeathCause,
  type DeathForensics,
  type RouteChoiceResult,
  type RunStats,
  type TraceSample,
} from "./simulation/runStats";

export { obstacleTrailingEdge } from "./simulation/obstacleSystem";
export { gradeSection, GRADE_MIN_INTENSITY, TRACE_OPEN_CLEARANCE } from "./simulation/runAnalysis";
export type {
  ChunkRecord, DeathCause, DeathForensics, ForensicsObstacle, RouteChoiceResult,
  RunStats, SectionGrade, SectionMetrics, SectionResult, TraceSample,
} from "./simulation/runStats";

export interface PrecisionReward {
  grade: PrecisionGrade;
  precision: number;
  flowPoints: number;
  baseScore: number;
}

export function precisionRewardAt(clearance: number): PrecisionReward {
  const safeClearance = clamp(clearance, 0, FLOW.NEAR_MISS_CLEARANCE);
  const precision = clamp01(1 - safeClearance / FLOW.NEAR_MISS_CLEARANCE);
  if (safeClearance <= FLOW.PERFECT_CLEARANCE) {
    return {
      grade: "perfect",
      precision,
      flowPoints: FLOW.PERFECT_POINTS,
      baseScore: FLOW.PERFECT_SCORE,
    };
  }
  if (safeClearance <= FLOW.RAZOR_CLEARANCE) {
    return {
      grade: "razor",
      precision,
      flowPoints: FLOW.RAZOR_POINTS,
      baseScore: FLOW.RAZOR_SCORE,
    };
  }
  return {
    grade: "close",
    precision,
    flowPoints: FLOW.CLOSE_POINTS,
    baseScore: FLOW.CLOSE_SCORE,
  };
}

/** Continuous steering authority at a given residual thrust charge. */
export function steeringAuthorityAt(boostCharge: number): number {
  return lerp(1, STEER.BOOST_AUTHORITY, clamp01(boostCharge));
}

/**
 * The whole game simulation. Deterministic given a seed + input stream.
 * No three.js, no React — stepped at a fixed 120 Hz.
 */
export class SimWorld {
  readonly events = new Emitter();

  // Run identity (roadmap Phase 4: one RunConfig describes the whole run).
  seed = "";
  mode: GameMode = "endless";
  trialId: string | null = null;
  private config: RunConfig = { mode: "endless", seed: "" };
  private trial: TrialDef | null = null;
  /** Sim seconds after which a surviving run finishes (0 = unlimited). */
  timeLimit = 0;
  /** Ambient target-speed curve (trials swap in their own escalation). */
  private speedCurve: (s: number) => number = speedAt;
  /** Resolved heat modifiers (identity when the stack is empty). */
  heatFx: HeatEffects = NO_HEAT;
  /** Resolved lab prototype flags (all off when the stack is empty). */
  labFx: LabEffects = NO_LAB;
  status: RunStatus = "idle";
  /** Seeded winding-track centerline (flat for trials). */
  course: Course = new Course(null);

  // Craft state.
  x = 0;
  latVel = 0;
  bank = 0;
  distance = 0;
  speed = 0;
  /** Current speed as a 0..1 fraction of the possible span (for fx/audio). */
  speedNorm = 0;
  /** Craft height (skyhook ramps, fun-frontier 6.1). HOVER_HEIGHT unless a
   *  ramp is ridden — the only way the craft ever leaves the ground band. */
  y: number = CRAFT.HOVER_HEIGHT;
  vy = 0;
  airborne = false;
  /** Track s where the current flight left its lip (flight-length stat). */
  private flightStartS = 0;
  private flightStartTime = 0;
  /** Lip position of the wedge currently/last ridden (side-slip detection). */
  private rideLipS = -Infinity;
  /** Flare detection: fresh committed presses while airborne. */
  private airPressDir = 0;
  private airPressAge = 999;
  private airPressGap = 999;
  /** Double jump (fun-frontier 6.2): impulses left this flight, tap tracking. */
  private airJumpsLeft = 0;
  private airTapArmed = false;
  private airTapTimer = 999;
  private prevAirBoost = false;
  /** Seconds of halved steering authority after a hard landing. */
  private numbTimer = 0;
  /** Perfect-landing rush: captured over-target speed, decaying. */
  private rushTimer = 0;
  private rushBonus = 0;

  // Meters.
  time = 0;
  score = 0;
  flowPoints = 0;
  flowTier = 0;
  flowTimer = 0;
  flowChain = 0;
  flowChainTimer = FLOW.CHAIN_WINDOW + 1;
  energy: number = ENERGY.START;
  boosting = false;
  boostCharge = 0;
  /** Seconds left on the free-boost surge window (lab 5.1; 0 = closed). */
  surgeTimer = 0;
  /** Phase dash state (lab 5.3): burst timer, cooldown, direction, edge. */
  dashTimer = 0;
  dashCooldown = 0;
  private dashDir = 0;
  private dashHeld = false;
  /** Carve state (lab "carve", fun-frontier 1.2). */
  private pressDir = 0;
  private lastDir = 0;
  private pressTimer = 999;
  private pumpCooldown = 0;
  /** 0..1 — how far past the steering cap the craft is gliding (FX/HUD). */
  glide = 0;
  hasShield = false;
  iframes = 0;
  shardCombo = 0;
  shardComboTimer = 0;
  /** Danger-weighted passive score factor (line choice vs. available geometry). */
  dangerFactor = 1;
  /** Last confirmed tight pass, pending a thread pairing. */
  private lastPass: { at: number; side: number; award: number; clearance: number } | null = null;
  private routeGates: (RouteChoiceSpec & { resolved: boolean })[] = [];
  private lastForeshadowS0 = -Infinity;
  private nextForeshadowTime = 0;

  stats: RunStats = emptyStats();

  // Input recording (roadmap 3.1). The sim consumes the quantized axis, so a
  // saved recording re-simulates the run bit-exactly.
  readonly recorder = new InputRecorder();
  /** Disable for replay/ghost worlds (a replay of a replay is itself). */
  recordInputs = true;

  private readonly analysis = new RunAnalysis(this, (s) => this.speedCurve(s));
  /** Bounded history of streamed chunks for paths, grading and presentation. */
  readonly chunkLog: ChunkRecord[] = this.analysis.chunks;

  // Drama director (seeded, distance-triggered global events).
  activeEvent: { kind: RunEventKind; endAt: number } | null = null;

  // Death.
  deathTimer = 0;
  deathX = 0;
  deathY: number = CRAFT.HOVER_HEIGHT;
  deathSpeed = 0;
  deathLatVel = 0;
  deathVy = 0;
  deathBank = 0;

  // Pools own slot allocation; presentation keeps stable array references.
  private readonly entities = new EntityPools();
  readonly obstacles: Obstacle[] = this.entities.obstacles;
  readonly pickups: Pickup[] = this.entities.pickups;
  private readonly director = new EventDirector(this, this.entities, (s) => this.speedCurve(s));
  private readonly obstacleSystem = new ObstacleSystem(this, this.entities, this.analysis, {
    onHit: (o) => this.onHit(o),
    onShatter: (o) => this.onShatter(o),
    onBounce: (o) => this.onBounce(o),
    onPassConfirmed: (o) => this.onPassConfirmed(o),
  });

  private generator: TrackGenerator | null = null;
  private readonly chunkSink = {
    chunk: (chunk: GeneratedChunk) => this.spawnChunk(chunk),
  };
  private accumulator = 0;
  /** Steering hold-time carried by the unfinished fixed tick (axis × seconds). */
  private pendingAxisTime = 0;
  private readonly tickActions = new FixedTickActions();
  /** Reused only when a tick combines samples from multiple render frames. */
  private readonly bufferedInput: InputState = {
    axis: 0, boost: false, dash: false, restart: false, pause: false,
  };
  private lastBiomeIndex = 0;
  private nextMythicIndex = 0;
  /** Interpolation snapshot for buttery rendering. */
  prevX = 0;
  prevDistance = 0;
  prevBank = 0;
  prevY: number = CRAFT.HOVER_HEIGHT;

  debugChunks: GeneratedChunk[] = [];
  collectDebug = false;

  /** Deactivate all live entities (used when returning to the title). */
  clearField(): void {
    this.entities.clear();
    this.routeGates.length = 0;
  }

  /**
   * Reset everything and start a new run. Instant — all pools are reused.
   * `config.skipTo` (dev/testing) jumps the craft deep into the run: chunks
   * up to the skip point are generated and discarded (same RNG stream as
   * playing there), so the field around the craft matches a real run exactly.
   */
  start(config: RunConfig): void {
    const seed = config.seed;
    const skipTo = config.skipTo ?? 0;
    // Canonicalize the heat/lab stacks (endless only) so run identity — and
    // with it recordings, ghosts, and determinism — never depends on order.
    const heat = config.mode === "endless" ? normalizeHeat(config.heat) : [];
    const lab = config.mode === "endless" ? normalizeLab(config.lab) : [];
    this.config = { ...config };
    if (heat.length > 0) this.config.heat = heat;
    else delete this.config.heat;
    if (lab.length > 0) this.config.lab = lab;
    else delete this.config.lab;
    this.seed = seed;
    this.mode = config.mode;
    this.trialId = config.mode === "trial" ? (config.trialId ?? null) : null;
    this.trial = this.trialId ? (trialById(this.trialId) ?? null) : null;
    this.timeLimit = config.mode === "sprint" ? SPRINT_MODE.DURATION : 0;
    this.speedCurve = this.trial ? this.trial.speedAt : speedAt;
    this.heatFx = resolveHeat(heat);
    this.labFx = resolveLab(lab);
    // Trials are fixed skill tests — they stay dead straight. Everything
    // else rides the seeded winding course.
    this.course = new Course(this.trial ? null : seed);
    this.director.reset(seed, skipTo, this.trial !== null);
    this.status = "running";
    this.x = 0;
    this.latVel = 0;
    this.bank = 0;
    this.distance = 0;
    this.speed = 0;
    this.speedNorm = 0;
    this.y = CRAFT.HOVER_HEIGHT;
    this.vy = 0;
    this.airborne = false;
    this.flightStartS = 0;
    this.flightStartTime = 0;
    this.rideLipS = -Infinity;
    this.airPressDir = 0;
    this.airPressAge = 999;
    this.airPressGap = 999;
    this.airJumpsLeft = 0;
    this.airTapArmed = false;
    this.airTapTimer = 999;
    this.prevAirBoost = false;
    this.numbTimer = 0;
    this.rushTimer = 0;
    this.rushBonus = 0;
    this.time = 0;
    this.score = 0;
    this.flowPoints = 0;
    this.flowTier = 0;
    this.flowTimer = 0;
    this.flowChain = 0;
    this.flowChainTimer = FLOW.CHAIN_WINDOW + 1;
    this.energy = ENERGY.START;
    this.boosting = false;
    this.boostCharge = 0;
    this.surgeTimer = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDir = 0;
    this.dashHeld = false;
    this.pressDir = 0;
    this.lastDir = 0;
    this.pressTimer = 999;
    this.pumpCooldown = 0;
    this.glide = 0;
    this.hasShield = false;
    this.iframes = 0;
    this.shardCombo = 0;
    this.shardComboTimer = 0;
    this.dangerFactor = 1;
    this.lastPass = null;
    this.routeGates.length = 0;
    this.lastForeshadowS0 = -Infinity;
    this.nextForeshadowTime = 0;
    this.deathTimer = 0;
    this.deathX = 0;
    this.deathY = CRAFT.HOVER_HEIGHT;
    this.deathSpeed = 0;
    this.deathLatVel = 0;
    this.deathVy = 0;
    this.deathBank = 0;
    this.accumulator = 0;
    this.pendingAxisTime = 0;
    this.tickActions.reset();
    this.prevX = 0;
    this.prevDistance = 0;
    this.prevBank = 0;
    this.prevY = CRAFT.HOVER_HEIGHT;
    this.lastBiomeIndex = 0;
    this.nextMythicIndex = MYTHIC_ZONES.findIndex((zone) => zone.at > skipTo);
    if (this.nextMythicIndex < 0) this.nextMythicIndex = MYTHIC_ZONES.length;
    this.stats = emptyStats();
    this.stats.seed = seed;
    this.stats.mode = this.mode;
    this.stats.trialId = this.trialId;
    this.stats.heat = heat;
    this.stats.lab = lab;
    // Recording is only meaningful for real runs from the start line.
    this.recorder.reset(this.recordInputs && skipTo === 0);
    this.analysis.reset();
    this.entities.clear();
    this.debugChunks.length = 0;

    this.generator = new TrackGenerator(
      createRng(seed),
      this.collectDebug,
      this.trial,
      this.heatFx,
      this.trial ? undefined : (s) => this.course.offsetAt(s),
    );
    if (skipTo > 0) {
      this.distance = skipTo;
      this.prevDistance = skipTo;
      this.x = this.course.offsetAt(skipTo);
      this.prevX = this.x;
      this.speed = this.speedCurve(skipTo);
      this.time = SPEED.LAUNCH_RAMP; // Skip the launch ramp too.
      this.lastBiomeIndex = biomeIndexAt(skipTo);
      this.generator.fill(Math.max(0, skipTo - TRACK.DESPAWN_BEHIND - 50), {
        chunk: () => {},
      });
    }
    this.streamAhead();
    this.events.emit("runStart", { config });
    this.events.emit("biome", {
      index: this.lastBiomeIndex,
      name: BIOMES[this.lastBiomeIndex].label,
    });
  }

  /** Advance sim by wall-clock dt (handles fixed-step accumulation + slow-mo). */
  update(dt: number, input: InputState): void {
    if (this.status === "idle") return;

    let scale = 1;
    if (this.status === "dead" || this.status === "finished") {
      this.deathTimer += dt;
      // A crash gets the slow-mo beat; a survived finish glides at full speed.
      const slowMo = this.status === "dead";
      if (slowMo) scale = RUN.DEATH_SLOWMO;
      const freezeAfter = slowMo ? RUN.DEATH_SLOWMO_DURATION : RUN.FINISH_GLIDE_DURATION;
      if (this.deathTimer > freezeAfter) return; // Freeze world.
    }

    const bufferedTime = this.accumulator;
    const elapsed = Math.min(dt, 0.25) * scale;
    const timedActions = this.tickActions.append(input.actions, elapsed);
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.prevX = this.x;
      this.prevDistance = this.distance;
      this.prevBank = this.bank;
      this.prevY = this.y;
      const wasRunning = this.status === "running";
      // Polling can happen faster than the 120 Hz sim. Preserve the steering
      // contributed by frames that took no step, then fill this tick with the
      // current frame's sample. Samples on zero-step frames reach the next tick.
      // Later ticks in this frame use the current sample directly; fixed-step
      // callers (including replay and calibration pilots) remain unchanged.
      let stepInput = input;
      if (timedActions || (steps === 0 && bufferedTime > 0)) {
        this.bufferedInput.axis = steps === 0 && bufferedTime > 0
          ? (this.pendingAxisTime + input.axis * (FIXED_DT - bufferedTime)) / FIXED_DT
          : input.axis;
        this.bufferedInput.boost = input.boost;
        this.bufferedInput.dash = input.dash;
        stepInput = this.bufferedInput;
      }
      if (timedActions) this.tickActions.sample(FIXED_DT, stepInput);
      this.step(FIXED_DT, stepInput);
      this.accumulator -= FIXED_DT;
      steps++;
      if (wasRunning && this.status === "dead") {
        // The rest of this render frame happened after impact. Convert its
        // unprocessed wall time into slow-mo time so frame partitioning cannot
        // skip the crash beat.
        const remainingWallTime = Math.max(0, this.accumulator);
        this.deathTimer += remainingWallTime;
        this.accumulator = remainingWallTime * RUN.DEATH_SLOWMO;
      }
    }
    if (steps === MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
      this.tickActions.reset();
    }
    // This is a single partial tick, not an input history: bounded memory
    // regardless of display rate. Once a tick ran, all remaining time belongs
    // to this frame (including the post-impact slow-motion conversion above).
    this.pendingAxisTime = steps === 0
      ? this.pendingAxisTime + input.axis * elapsed
      : input.axis * this.accumulator;
  }

  /** Interpolation alpha for rendering. */
  get alpha(): number {
    return clamp01(this.accumulator / FIXED_DT);
  }

  get renderX(): number {
    return lerp(this.prevX, this.x, this.alpha);
  }

  get renderDistance(): number {
    return lerp(this.prevDistance, this.distance, this.alpha);
  }

  get renderBank(): number {
    return lerp(this.prevBank, this.bank, this.alpha);
  }

  get renderY(): number {
    return lerp(this.prevY, this.y, this.alpha);
  }

  get biomeIndex(): number {
    return biomeIndexAt(this.distance);
  }

  private step(dt: number, input: InputState): void {
    this.time += dt;
    const alive = this.status === "running";

    // The sim consumes the quantized axis — the recorded stream then replays
    // bit-exactly (roadmap 3.1). Dead/idle steps consume no input. The dash
    // bit is masked unless the Phase Dash flag is on, so plain recordings
    // never grow it (lab 5.3): the recorded value is the executed value.
    const axis = alive ? quantizeAxis(input.axis) : 0;
    const dashHeld = alive && this.labFx.dash && input.dash;
    if (alive) this.recorder.record(axis, input.boost, dashHeld);

    // --- Speed ---------------------------------------------------------
    const launch = clamp01(this.time / SPEED.LAUNCH_RAMP);
    // Flow keeps paying score without bound, but its speed bonus stops at the
    // pre-uncap maximum tier — speed stays a boost-driven ratchet.
    const flowBonus =
      1 + Math.min(this.flowTier, FLOW.SPEED_BONUS_TIER_CAP) * FLOW.SPEED_BONUS_PER_TIER;
    let targetSpeed = this.speedCurve(this.distance) * launch * flowBonus;

    // Boost. An open surge window (lab 5.1) makes it free while it lasts:
    // no drain, and ignition works even on an empty meter. With the lab off
    // surgeTimer is always 0, so this block is bit-identical to plain boost.
    if (alive) {
      if (this.surgeTimer > 0) this.surgeTimer = Math.max(0, this.surgeTimer - dt);
      const surging = this.surgeTimer > 0;
      const wantBoost =
        input.boost && (surging || this.energy > (this.boosting ? 0 : ENERGY.BOOST_MIN));
      if (wantBoost && !this.boosting) {
        this.boosting = true;
        this.stats.boosts++;
        this.events.emit("boostStart", undefined);
      } else if (!wantBoost && this.boosting) {
        this.boosting = false;
        this.events.emit("boostEnd", undefined);
      }
      if (this.boosting) {
        if (!surging) this.energy = Math.max(0, this.energy - ENERGY.BOOST_DRAIN * dt);
        this.stats.boostTime += dt;
        if (this.energy <= 0 && !surging) {
          this.boosting = false;
          this.events.emit("boostEnd", undefined);
        }
      }
    } else if (this.boosting) {
      this.boosting = false;
      this.events.emit("boostEnd", undefined);
    }
    this.boostCharge = clamp01(this.boostCharge + (this.boosting ? dt * 3.2 : -dt * 2.4));
    targetSpeed *= 1 + (SPEED.BOOST_MULT - 1) * this.boostCharge;

    // Skyhook air economy (fun-frontier 6.1): a boost-dive converts sink
    // rate into forward speed while it lasts; a perfect landing keeps that
    // transient alive as a decaying rush instead of losing it at touchdown.
    // Both terms are exactly 0 for a craft that never rides a ramp.
    if (alive) {
      if (this.airborne && this.boosting && this.vy < 0) {
        targetSpeed += RAMP.DIVE_SPEED_GAIN * -this.vy;
      }
      if (this.rushTimer > 0) {
        this.rushTimer = Math.max(0, this.rushTimer - dt);
        targetSpeed += this.rushBonus * (this.rushTimer / RAMP.RUSH_TIME);
      }
    }

    // Phase dash (lab 5.3): rising edge fires a short committed lateral
    // burst — energy-priced, cooldown-gated, no i-frames. With the flag off
    // dashHeld is always false and every timer stays 0: bit-identical.
    if (alive) {
      if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
      if (
        dashHeld &&
        !this.dashHeld &&
        !this.airborne && // No phase-blinking mid-flight.
        this.dashTimer <= 0 &&
        this.dashCooldown <= 0 &&
        Math.abs(axis) >= DASH.MIN_AXIS &&
        this.energy >= DASH.ENERGY
      ) {
        this.dashTimer = DASH.TIME;
        this.dashDir = axis > 0 ? 1 : -1;
        this.dashCooldown = DASH.COOLDOWN;
        this.energy -= DASH.ENERGY;
        this.stats.dashes++;
        this.events.emit("dash", { dir: this.dashDir, x: this.x });
      }
      this.dashHeld = dashHeld;
    }

    this.speed = alive
      ? lerp(this.speed, targetSpeed, 1 - Math.exp(-2.8 * dt))
      : Math.max(0, this.speed - 90 * dt); // Crash deceleration.
    this.speedNorm = clamp01((this.speed - SPEED.BASE) / (SPEED.MAX * SPEED.BOOST_MULT - SPEED.BASE));

    if (alive) this.distance += this.speed * dt;
    if (alive) {
      while (
        this.nextMythicIndex < MYTHIC_ZONES.length &&
        this.distance >= MYTHIC_ZONES[this.nextMythicIndex].at
      ) {
        const zone = MYTHIC_ZONES[this.nextMythicIndex++];
        this.events.emit("mythic", {
          depth: zone.at,
          name: zone.label,
          index: this.nextMythicIndex - 1,
        });
      }
      const biome = biomeIndexAt(this.distance);
      if (biome !== this.lastBiomeIndex) {
        this.lastBiomeIndex = biome;
        this.events.emit("biome", { index: biome, name: BIOMES[biome].label });
      }
    }

    // --- Steering (speed-proportional, momentum-based) -------------------
    const maxLat = Math.max(10, this.speed) * STEER.RATIO;
    if (alive) {
      // Post-hard-landing numb: halved authority while the struts recover.
      // 1 whenever no ramp has been slammed — the plain path is untouched.
      if (this.numbTimer > 0) this.numbTimer = Math.max(0, this.numbTimer - dt);
      const numb = this.numbTimer > 0 ? 0.5 : 1;
      if (this.airborne) {
        // Airborne (fun-frontier 6.1): weak bite, thin drag. Carried carve
        // momentum persists — only air drag erodes it — so a pumped lip
        // launch glides. Enough authority to feather a line, not re-plan it.
        const authority =
          steeringAuthorityAt(this.boostCharge) * RAMP.AIR_AUTHORITY * numb;
        this.latVel += axis * Math.max(10, this.speed) * STEER.ACCEL_K * authority * dt;
        this.latVel *= Math.exp(-RAMP.AIR_DRAG * dt);
        const airCap = maxLat * CARVE.OVER_RATIO;
        this.latVel = clamp(this.latVel, -airCap, airCap);
        this.x += this.latVel * dt;
      } else if (this.dashTimer > 0) {
        // Mid-dash (lab 5.3): steering is committed — a fixed-rate burst
        // that ends as a reposition, not a fling.
        this.dashTimer = Math.max(0, this.dashTimer - dt);
        this.latVel = this.dashDir * (DASH.DISTANCE / DASH.TIME);
        this.x += this.latVel * dt;
        if (this.dashTimer <= 0) this.latVel *= DASH.EXIT_MOMENTUM;
      } else if (this.labFx.carve) {
        this.stepCarve(dt, axis, maxLat, numb);
      } else {
        // Speed and steering cost share the same continuous thrust state.
        // Releasing boost no longer grants full authority while residual
        // charge still supplies almost-full speed.
        const authority = steeringAuthorityAt(this.boostCharge) * numb;
        this.latVel += axis * Math.max(10, this.speed) * STEER.ACCEL_K * authority * dt;
        const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
        this.latVel *= Math.exp(-drag * dt * lerp(1, 0.85, this.boostCharge));
        this.latVel = clamp(this.latVel, -maxLat, maxLat);
        this.x += this.latVel * dt;
      }
      // There is no invisible wall: carried momentum takes the craft off the
      // road. This also applies to airborne, shielded, dashing and carving runs.
      if (this.checkTrackEdge()) return;
      // Glide readout for FX/HUD (0 everywhere but a carving or flying craft).
      if (this.labFx.carve || this.airborne) {
        this.glide = clamp01((Math.abs(this.latVel) / maxLat - 1) / (CARVE.OVER_RATIO - 1));
      } else if (this.glide !== 0) {
        this.glide = 0;
      }

      // --- Skyhook vertical state (ride / launch / fly / land) ------------
      // The raw recorded button (not the energy-gated ignition) drives the
      // double-jump tap: replays carry the identical stream.
      this.stepVertical(dt, axis, input.boost);
    } else {
      this.latVel *= Math.exp(-4 * dt);
    }
    const targetBank = clamp(
      -(this.latVel / Math.max(1, maxLat)) * STEER.MAX_BANK,
      -STEER.MAX_BANK,
      STEER.MAX_BANK,
    );
    this.bank = lerp(this.bank, targetBank, 1 - Math.exp(-10 * dt));

    // --- Streaming -----------------------------------------------------
    this.streamAhead();
    if (alive) this.resolveRouteChoices();
    if (alive) this.updateForeshadow();

    // --- Drama director (after streaming: events read the solved paths) --
    if (alive) this.director.update();

    // --- Section tracking (before obstacle events, so passes confirmed
    // this step attribute to the chunk the craft is currently inside) -----
    if (alive) this.analysis.updateSection();

    // --- Obstacles: motion + collision + near miss ----------------------
    this.obstacleSystem.update(dt, alive);
    if (alive && this.status !== "running") return;

    // --- Pickups ---------------------------------------------------------
    if (alive) this.updatePickups(dt);

    // --- Flow / combo timers ---------------------------------------------
    if (alive) {
      this.flowTimer += dt;
      this.flowChainTimer += dt;
      if (this.flowChainTimer > FLOW.CHAIN_WINDOW) this.flowChain = 0;
      const highTiers = Math.max(0, this.flowTier - 2);
      const decayGrace = Math.max(
        1.8,
        FLOW.DECAY_GRACE - highTiers * FLOW.GRACE_LOSS_PER_HIGH_TIER,
      );
      // Uncapped flow: everything above the soft cap bleeds continuously
      // (no grace), quadratically in the overage. Sustained streams find an
      // equilibrium set by their event rate instead of a hard wall.
      const over = this.flowPoints - FLOW.MAX_POINTS;
      if (over > 0) {
        const bleed = FLOW.DECAY_RATE * FLOW.OVER_DECAY_QUAD * over * over;
        this.flowPoints = Math.max(FLOW.MAX_POINTS, this.flowPoints - bleed * dt);
      }
      if (this.flowTimer > decayGrace && this.flowPoints > 0) {
        const decayRate = FLOW.DECAY_RATE * (1 + highTiers * FLOW.DECAY_RATE_PER_HIGH_TIER);
        this.flowPoints = Math.max(0, this.flowPoints - decayRate * dt);
      }
      this.setFlowTier(Math.floor(this.flowPoints / FLOW.POINTS_PER_TIER));

      this.shardComboTimer += dt;
      if (this.shardComboTimer > ENERGY.COMBO_WINDOW) this.shardCombo = 0;

      if (this.iframes > 0) this.iframes -= dt;

      // Score: distance rate scaled by flow multiplier, local danger, and the
      // heat stack — flying where the geometry is dense pays; empty-edge
      // hugging doesn't; opt-in burdens pay multiplicatively (roadmap 4.3).
      const mult = 1 + this.flowPoints * FLOW.MULT_PER_POINT;
      this.score += this.speed * dt * mult * this.dangerFactor * this.heatFx.scoreMult;

      this.stats.score = Math.floor(this.score);
      this.stats.distance = this.distance;
      this.stats.duration = this.time;
      this.stats.maxFlowPoints = Math.max(this.stats.maxFlowPoints, this.flowPoints);
      this.stats.boostChargeTime += this.boostCharge * dt;
      if (this.glide > 0) this.stats.glideTime += dt;

      // 30 Hz line trace for the kill-cam (roadmap 3.3).
      this.analysis.sampleStep();

      // Time-limited runs finish at the end of the step that crosses the
      // horizon — the step was recorded, so a replay/ghost re-simulates the
      // finish bit-exactly (the epsilon absorbs fixed-step float accumulation).
      if (this.timeLimit > 0 && this.time >= this.timeLimit - 1e-9) {
        this.onFinish();
      }
    }
  }

  /**
   * Carve steering (lab "carve", fun-frontier 1.2). Same two buttons, four
   * techniques: flick (fresh presses bite harder), pump (a reversal at
   * carried speed rebounds the carve with a bonus), glide (pumped momentum
   * rides past maxLat; only the excess decays, and steering into the slide
   * adds nothing — pumps are the only fuel), boost-carve (pump bonus scales
   * while boosting). Pure holds behave like plain steering outside the
   * flick window, so the novice line is untouched in feel.
   */
  private stepCarve(dt: number, axis: number, maxLat: number, numb = 1): void {
    const dir = axis >= CARVE.COMMIT ? 1 : axis <= -CARVE.COMMIT ? -1 : 0;
    if (this.pumpCooldown > 0) this.pumpCooldown = Math.max(0, this.pumpCooldown - dt);
    this.pressTimer += dt;
    if (dir !== 0 && dir !== this.pressDir) {
      // Fresh committed press (from neutral or a reversal).
      this.pressTimer = 0;
      if (
        dir === -this.lastDir &&
        this.pumpCooldown <= 0 &&
        this.latVel * dir < 0 &&
        Math.abs(this.latVel) >= CARVE.PUMP_MIN_FRAC * maxLat
      ) {
        // Pump quality rises continuously as the reversal approaches peak
        // carried velocity. The environment determines when that peak is
        // useful, so a fixed metronomic macro cannot be universally optimal.
        const carried = Math.abs(this.latVel) / maxLat;
        const quality = clamp01(
          (carried - CARVE.PUMP_MIN_FRAC) /
            (CARVE.PUMP_FULL_FRAC - CARVE.PUMP_MIN_FRAC),
        );
        const keep = CARVE.PUMP_KEEP * lerp(0.55, 1, quality);
        const bonus =
          CARVE.PUMP_BONUS * quality * (this.boostCharge > 0.5 ? CARVE.PUMP_BOOST_GAIN : 1);
        const v = Math.min(
          Math.abs(this.latVel) * keep + maxLat * bonus,
          maxLat * CARVE.OVER_RATIO,
        );
        this.latVel = dir * v;
        this.pumpCooldown = CARVE.PUMP_COOLDOWN;
        this.stats.pumps++;
        this.stats.pumpQualitySum += quality;
        this.events.emit("pump", {
          dir,
          x: this.x,
          wall: false,
          strength: quality,
        });
      }
    }
    if (dir !== 0) {
      this.pressDir = dir;
      this.lastDir = dir;
    } else {
      this.pressDir = 0;
    }

    const gliding = Math.abs(this.latVel) > maxLat + 1e-6;
    // Glide is pump-fueled only: steering with the slide adds nothing.
    const pushing = gliding && this.latVel * axis > 0;
    const flick = this.pressTimer < CARVE.FLICK_WINDOW ? CARVE.FLICK_BOOST : 1;
    const authority =
      steeringAuthorityAt(this.boostCharge) * (pushing ? 0 : 1) * numb;
    this.latVel += axis * Math.max(10, this.speed) * STEER.ACCEL_K * flick * authority * dt;
    if (Math.abs(this.latVel) > maxLat) {
      // Above the cap only the excess decays (slowly) — the carve rides.
      const s = Math.sign(this.latVel);
      const excess = (Math.abs(this.latVel) - maxLat) * Math.exp(-CARVE.GLIDE_DRAG * dt);
      this.latVel = s * Math.min(maxLat + excess, maxLat * CARVE.OVER_RATIO);
    } else {
      const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
      this.latVel *= Math.exp(-drag * dt * lerp(1, 0.85, this.boostCharge));
      this.latVel = clamp(this.latVel, -maxLat, maxLat);
    }
    this.x += this.latVel * dt;
  }

  /**
   * Skyhook vertical state (fun-frontier 6.1). The craft leaves hover height
   * only by riding a wedge, so a run that never touches one reduces this to
   * a counter check — grounded physics stay bit-identical to pre-ramp builds.
   *
   * Riding sets vy to the climb rate (slope × speed × EFFICIENCY, capped), so
   * leaving the wedge — over the lip or off a side — simply keeps flying on
   * whatever the ride was carrying. Airborne, gravity (plus the boost-dive)
   * integrates until the craft meets its floor: the ground, or the surface
   * of the next wedge in a chain.
   */
  private stepVertical(dt: number, axis: number, boostRaw: boolean): void {
    if (this.entities.liveRamps === 0 && !this.airborne) return;

    // Flare detection: a fresh committed press while airborne arms the
    // flare; its timing quality is read at touchdown. Two fresh presses
    // inside CHATTER_GAP void it, so a PWM steering cadence never lands one.
    if (this.airborne) {
      const dir = axis >= RAMP.COMMIT ? 1 : axis <= -RAMP.COMMIT ? -1 : 0;
      if (dir !== 0 && dir !== this.airPressDir) {
        this.airPressGap = this.airPressAge;
        this.airPressAge = 0;
      }
      this.airPressDir = dir;
      this.airPressAge += dt;

      // Double jump (fun-frontier 6.2): a boost press that begins AND ends
      // in the air within TAP_WINDOW fires one upward impulse per flight.
      // A press carried over the lip shows no airborne rising edge, so it
      // stays a dive; holding past the window commits to the dive too.
      if (boostRaw && !this.prevAirBoost) {
        this.airTapArmed = true;
        this.airTapTimer = 0;
      }
      if (boostRaw) {
        this.airTapTimer += dt;
        if (this.airTapTimer > RAMP.TAP_WINDOW) this.airTapArmed = false;
      }
      if (!boostRaw && this.prevAirBoost && this.airTapArmed) {
        this.airTapArmed = false;
        if (this.airJumpsLeft > 0 && this.energy >= RAMP.JUMP_ENERGY) {
          this.airJumpsLeft--;
          this.energy -= RAMP.JUMP_ENERGY;
          // Timing quality peaks exactly at the apex (|vy| ≈ 0) — the UT
          // rhythm. A dive-accelerated |vy| beyond VY_MAX clamps to the
          // floor impulse: jumping out of a committed dive is expensive.
          const quality = clamp01(1 - Math.abs(this.vy) / RAMP.VY_MAX);
          this.vy = RAMP.JUMP_VY * (RAMP.JUMP_FLOOR + (1 - RAMP.JUMP_FLOOR) * quality);
          this.stats.airJumps++;
          this.stats.airJumpQualitySum += quality;
          this.events.emit("airJump", {
            x: this.x,
            s: this.distance,
            y: this.y,
            vy: this.vy,
            quality,
          });
        }
      }
      this.prevAirBoost = boostRaw;
    }

    // The floor under the craft: the ground, or the tallest ridden surface.
    let floorY: number = CRAFT.HOVER_HEIGHT;
    let climb = 0;
    let riding = false;
    let lipS = -Infinity;
    if (this.entities.liveRamps > 0) {
      const d = this.distance;
      for (const o of this.obstacles) {
        if (!o.active || o.kind !== "ramp") continue;
        const f = (d - (o.cs - o.hs)) / (2 * o.hs);
        if (f < 0 || f > 1) continue;
        if (Math.abs(this.x - o.cx) > o.hx) continue;
        const h = CRAFT.HOVER_HEIGHT + f * o.hy;
        if (h >= floorY) {
          floorY = h;
          climb = (o.hy / (2 * o.hs)) * this.speed;
          lipS = o.cs + o.hs;
          riding = true;
        }
      }
    }

    if (!this.airborne) {
      if (riding) {
        // Snap up onto the surface (side entries pop on), then track it —
        // the tracking rate always outruns the deck's own climb.
        this.y = Math.min(floorY, this.y + Math.max(RAMP.SNAP_UP, climb * 1.15) * dt);
        this.vy = Math.min(climb * RAMP.EFFICIENCY, RAMP.VY_MAX);
        this.rideLipS = lipS;
      } else if (this.y > CRAFT.HOVER_HEIGHT) {
        // Left the wedge above ground level. Only the lip pays the launch:
        // sliding off a side drops instead of flying, so a mis-carve never
        // sails beyond the guaranteed-clear landing tube.
        const lipLaunch = this.distance >= this.rideLipS - 0.5;
        if (!lipLaunch) this.vy = 0;
        this.airborne = true;
        this.flightStartS = this.distance;
        this.flightStartTime = this.time;
        this.airPressDir = 0;
        this.airPressAge = 999;
        this.airPressGap = 999;
        // One double jump per flight; a press held through the lip never
        // arms a tap (no airborne rising edge is possible for it).
        this.airJumpsLeft = 1;
        this.airTapArmed = false;
        this.airTapTimer = 999;
        this.prevAirBoost = boostRaw;
        if (lipLaunch && this.vy >= RAMP.EVENT_MIN_VY) {
          this.stats.jumps++;
          this.events.emit("launch", {
            x: this.x,
            s: this.distance,
            vy: this.vy,
            boosted: this.boosting,
          });
        }
      } else {
        this.y = CRAFT.HOVER_HEIGHT;
        this.vy = 0;
      }
    }

    if (this.airborne) {
      const dive = this.boosting;
      this.vy -= (RAMP.GRAVITY + (dive ? RAMP.DIVE_ACCEL : 0)) * dt;
      this.y += this.vy * dt;
      this.stats.airTime += dt;
      if (dive) this.stats.diveTime += dt;
      if (this.y <= floorY) {
        this.y = floorY;
        this.onLand();
      }
    }
  }

  /**
   * Airborne touchdown. Impact is graded continuously: a flare (one fresh
   * committed press within FLARE_WINDOW of this moment) forgives FLARE_KEEP
   * of the impact by its timing quality. Un-dived arcs land clean by
   * construction (VY_MAX < SOFT_VY); an unflared dive lands hard (speed
   * scrub + numb steering); a well-flared dive grades perfect — the dive's
   * speed transient survives as a decaying rush and the landing pays out
   * like a precision event (resonant on the beat grid).
   */
  private onLand(): void {
    const impact = Math.max(0, -this.vy);
    const flare =
      this.airPressAge <= RAMP.FLARE_WINDOW && this.airPressGap >= RAMP.CHATTER_GAP
        ? clamp01(1 - this.airPressAge / RAMP.FLARE_WINDOW)
        : 0;
    const effective = impact * (1 - RAMP.FLARE_KEEP * flare);
    // Perfect = a real committed descent (deep dive or a full jumped arc)
    // redeemed by the flare; feather-falls flare into plain clean.
    const grade: LandingGrade =
      effective <= RAMP.SOFT_VY
        ? flare >= RAMP.PERFECT_MIN_Q && impact > RAMP.PERFECT_MIN_IMPACT
          ? "perfect"
          : "clean"
        : "hard";

    this.airborne = false;
    this.vy = 0;
    const airTime = this.time - this.flightStartTime;
    this.stats.longestFlight = Math.max(
      this.stats.longestFlight,
      this.distance - this.flightStartS,
    );
    if (flare > 0) this.stats.flares++;

    let scoreAward = 0;
    let energyAward = 0;
    let resonant = false;
    if (grade === "hard") {
      this.stats.hardLandings++;
      this.speed *= 1 - RAMP.HARD_SCRUB;
      this.numbTimer = RAMP.NUMB_TIME;
    } else if (grade === "perfect") {
      this.stats.perfectLandings++;
      // The dive bonus doesn't vanish at touchdown — it decays instead.
      this.rushBonus = RAMP.DIVE_SPEED_GAIN * impact;
      this.rushTimer = RAMP.RUSH_TIME;
      resonant = onBeatAt(this.time);
      this.flowPoints += RAMP.LAND_FLOW * this.speedFlowFactor;
      this.flowTimer = 0;
      energyAward = this.grantEnergy(RAMP.LAND_ENERGY);
      scoreAward = Math.round(
        RAMP.LAND_SCORE * (0.6 + Math.min(airTime, 1.6)) * this.flowMultiplier *
          this.speedRewardFactor * this.heatFx.scoreMult *
          (resonant ? RESONANCE.BONUS : 1),
      );
      this.score += scoreAward;
      this.analysis.notePrecision();
    }
    this.events.emit("land", {
      x: this.x,
      s: this.distance,
      grade,
      impact,
      flare,
      airTime,
      resonant,
      scoreAward,
      energyAward,
    });
  }

  get flowMultiplier(): number {
    return 1 + this.flowPoints * FLOW.MULT_PER_POINT;
  }

  get flowDecayGrace(): number {
    const highTiers = Math.max(0, this.flowTier - 2);
    return Math.max(1.8, FLOW.DECAY_GRACE - highTiers * FLOW.GRACE_LOSS_PER_HIGH_TIER);
  }

  get flowGraceRemaining(): number {
    return clamp01(1 - this.flowTimer / this.flowDecayGrace);
  }

  private setFlowTier(tier: number): void {
    if (tier !== this.flowTier) {
      const prev = this.flowTier;
      this.flowTier = tier;
      this.stats.maxFlowTier = Math.max(this.stats.maxFlowTier, tier);
      this.events.emit("flowTier", { tier, prev });
    }
  }

  /** Trace samples in chronological order. */
  getTrace(): TraceSample[] {
    return this.analysis.getTrace();
  }

  /** The finished run's input recording (null while recording is disabled). */
  getRecording(): RunRecording | null {
    return this.recorder.toRecording(this.config, this.stats.score, this.stats.distance);
  }

  /** Course-local craft trace, solved paths and geometry around the impact. */
  buildForensics(behind = 320, ahead = 50): DeathForensics | null {
    return this.analysis.buildForensics(behind, ahead);
  }

  /**
   * Generated (and visible) distance ahead — speed-proportional so the
   * warning window stays constant in seconds as the treadmill accelerates.
   */
  get genHorizon(): number {
    return lookaheadFor(this.speed);
  }

  /** Winding-course centerline offset at track distance s (0 for trials). */
  courseOffsetAt(s: number): number {
    return this.course.offsetAt(s);
  }

  private streamAhead(): void {
    const gen = this.generator;
    if (!gen) return;
    gen.fill(this.distance + this.genHorizon, this.chunkSink);
  }

  private spawnChunk(chunk: GeneratedChunk): void {
    for (const spec of chunk.obstacles) this.spawnObstacle(spec, chunk.patternId);
    for (const p of chunk.pickups) {
      // Tin Hull also silences pattern-authored shields (the generator's own
      // path shields are already suppressed at placement).
      if (p.type === "shield" && !this.heatFx.shields) continue;
      this.spawnPickupWorld(p.type, p.s, p.x + this.course.offsetAt(p.s), p.y, p.magnet ?? true);
    }
    if (chunk.announce) {
      this.events.emit("setpiece", { name: chunk.announce });
    }
    for (const route of chunk.routes) {
      this.routeGates.push({
        ...route,
        decisionId: `${Math.round(chunk.s0)}:${route.decisionId}`,
        x: route.x + this.course.offsetAt(route.s),
        resolved: false,
      });
    }
    this.analysis.recordChunk(chunk);
    if (this.collectDebug && chunk.debug) {
      // Retain everything between the craft and the horizon (path-follower
      // bots and the kill-cam need chunks the craft is currently inside, not
      // just the freshest ones), pruning what falls behind.
      this.debugChunks.push(chunk);
      while (
        this.debugChunks.length > 64 ||
        (this.debugChunks.length > 0 &&
          this.debugChunks[0].s1 < this.distance - TRACK.DESPAWN_BEHIND - 60)
      ) {
        this.debugChunks.shift();
      }
    }
  }

  /** Resolve each authored fork once the craft crosses its decision row. */
  private resolveRouteChoices(): void {
    const due = new Set<string>();
    for (const route of this.routeGates) {
      if (!route.resolved && this.distance >= route.s) due.add(route.decisionId);
    }
    for (const decisionId of due) {
      const routes = this.routeGates.filter(
        (route) => !route.resolved && route.decisionId === decisionId,
      );
      if (routes.length === 0) continue;
      let selected = routes[0];
      let best = Infinity;
      for (const route of routes) {
        const normalized = Math.abs(this.x - route.x) / Math.max(0.25, route.half);
        if (normalized < best) {
          best = normalized;
          selected = route;
        }
        route.resolved = true;
      }
      const result: RouteChoiceResult = {
        decisionId,
        routeId: selected.routeId,
        label: selected.label,
        reward: selected.reward,
        s: selected.s,
      };
      this.stats.routeChoices.push(result);
      this.events.emit("routeChoice", result);
    }
    this.routeGates = this.routeGates.filter(
      (route) => !route.resolved || route.s > this.distance - 80,
    );
  }

  /** Emit one cross-sensory preview when a real challenge is 3–8 seconds out. */
  private updateForeshadow(): void {
    if (this.time < this.nextForeshadowTime) return;
    let next: ChunkRecord | null = null;
    for (const chunk of this.chunkLog) {
      if (
        chunk.intensity < GRADE_MIN_INTENSITY ||
        chunk.s0 <= this.distance ||
        chunk.s0 === this.lastForeshadowS0
      ) {
        continue;
      }
      const lead = (chunk.s0 - this.distance) / Math.max(1, this.speed);
      if (lead < 3 || lead > 8) continue;
      if (!next || chunk.s0 < next.s0) next = chunk;
    }
    if (!next) return;
    this.lastForeshadowS0 = next.s0;
    this.nextForeshadowTime = this.time + 2.5;
    this.events.emit("patternAhead", {
      patternId: next.patternId,
      skills: next.skills,
      lead: (next.s0 - this.distance) / Math.max(1, this.speed),
    });
  }

  private spawnPickupWorld(
    type: Pickup["type"], s: number, x: number, y: number, magnetic: boolean,
  ): void {
    this.entities.spawnPickup(type, s, x, y, magnetic, this);
  }

  private spawnObstacle(spec: ObstacleSpec, patternId: string): void {
    this.entities.spawnObstacle(spec, patternId, this);
  }

  /**
   * Precision rewards scale with speed — grazing at 130 m/s is worth far more
   * than at base speed. Floored at 1 so the launch ramp never shrinks rewards.
   */
  get speedRewardFactor(): number {
    return Math.max(1, Math.pow(this.speed / SPEED.BASE, FLOW.SPEED_REWARD_EXP));
  }

  /** Flow-point gains use a damped, capped speed factor (tier spikes stay bounded). */
  private get speedFlowFactor(): number {
    return clamp(this.speed / SPEED.BASE, 1, FLOW.SPEED_FLOW_FACTOR_CAP);
  }

  private grantEnergy(amount: number): number {
    const refunded = amount * (this.boosting ? ENERGY.BOOST_REFUND : 1);
    const before = this.energy;
    this.energy = Math.min(ENERGY.MAX, this.energy + refunded);
    return this.energy - before;
  }

  /** A tight pass fully settled. Pays the graze (if close enough) and checks threads. */
  private onPassConfirmed(o: Obstacle): void {
    const clearance = clamp(o.nearMissClearance, 0, THREAD.CLEARANCE);
    const side = o.nearMissSide || (o.cx >= this.x ? 1 : -1);
    let award = 0;
    if (clearance < FLOW.NEAR_MISS_CLEARANCE) {
      award = this.onNearMiss(o, clearance);
    }

    // Thread the needle: this pass + a recent pass on the opposite side.
    const prev = this.lastPass;
    if (prev && prev.side !== side && this.distance - prev.at <= THREAD.WINDOW) {
      this.onThread(o, prev, { award, clearance });
      this.lastPass = null;
    } else {
      this.lastPass = { at: this.distance, side, award, clearance };
    }
  }

  private onNearMiss(o: Obstacle, clearance: number): number {
    const reward = precisionRewardAt(clearance);
    if (reward.grade === "perfect") {
      this.stats.perfectPasses++;
    } else if (reward.grade === "razor") {
      this.stats.razorPasses++;
    } else {
      this.stats.closePasses++;
    }

    this.flowChain = this.flowChainTimer <= FLOW.CHAIN_WINDOW ? this.flowChain + 1 : 1;
    this.flowChainTimer = 0;
    this.stats.bestFlowChain = Math.max(this.stats.bestFlowChain, this.flowChain);
    this.flowPoints += reward.flowPoints * this.speedFlowFactor;
    this.flowTimer = 0;
    this.stats.nearMisses++;
    if (this.airborne) this.stats.airGrazes++;
    this.analysis.notePrecision();

    // Grazes fund boost — the perpetual-boost loop for elite play.
    const grazeEnergy =
      reward.grade === "perfect"
        ? ENERGY.GRAZE_PERFECT
        : reward.grade === "razor"
          ? ENERGY.GRAZE_RAZOR
          : ENERGY.GRAZE_CLOSE;
    const energyAward = this.grantEnergy(grazeEnergy);

    // Rhythm resonance (fun-frontier 2.1, mainline): a perfect confirmed on
    // the beat grid rings out and pays extra — the world runs on the beat.
    const resonant = reward.grade === "perfect" && onBeatAt(this.time);
    if (resonant) this.stats.resonantPasses++;

    const chainBonus = 1 + Math.min(
      FLOW.CHAIN_SCORE_CAP,
      Math.max(0, this.flowChain - 1) * FLOW.CHAIN_SCORE_STEP,
    );
    const scoreAward = Math.round(
      reward.baseScore * this.flowMultiplier * chainBonus * this.speedRewardFactor *
        this.heatFx.scoreMult * (resonant ? RESONANCE.BONUS : 1),
    );
    this.score += scoreAward;
    this.events.emit("nearMiss", {
      x: o.cx, s: o.cs,
      clearance,
      precision: reward.precision,
      grade: reward.grade,
      chain: this.flowChain,
      scoreAward,
      energyAward,
      flowPoints: this.flowPoints,
      resonant,
    });
    if (this.labFx.surge && reward.grade === "perfect") this.openSurge();
    return scoreAward;
  }

  /** Open (or refresh) a free-boost surge window (lab prototype 5.1). */
  private openSurge(): void {
    this.surgeTimer = SURGE.WINDOW;
    this.events.emit("surge", { window: SURGE.WINDOW });
  }

  private onThread(
    o: Obstacle,
    prev: { award: number; clearance: number },
    cur: { award: number; clearance: number },
  ): void {
    // Tightness graded on the worse side of the pair.
    const worse = Math.max(prev.clearance, cur.clearance);
    const tightness = clamp01(1 - worse / THREAD.CLEARANCE);
    const base = THREAD.SCORE_MIN + (THREAD.SCORE_MAX - THREAD.SCORE_MIN) * tightness * tightness;
    // The double-graze repay below reuses awards that already carry heat.
    let scoreAward = Math.round(
      base * this.flowMultiplier * this.speedRewardFactor * this.heatFx.scoreMult,
    );
    // A true double-graze needle also repays both awards multiplicatively
    // (they already carry the flow/speed multipliers — no re-scaling).
    if (prev.award > 0 && cur.award > 0) {
      scoreAward += Math.round((prev.award + cur.award) * (THREAD.BONUS_MULT - 1));
    }
    this.score += scoreAward;
    this.flowPoints += THREAD.FLOW_POINTS * this.speedFlowFactor;
    this.flowTimer = 0;
    this.grantEnergy(THREAD.ENERGY);
    this.stats.threads++;
    this.analysis.notePrecision(2);
    this.events.emit("thread", {
      x: o.cx,
      s: o.cs,
      scoreAward,
      tightness,
      count: this.stats.threads,
    });
    if (this.labFx.surge) this.openSurge();
  }

  /** Boost-smashed glass: the pane dies, the craft doesn't. */
  private onShatter(o: Obstacle): void {
    this.entities.releaseObstacle(o);
    this.flowPoints += GLASS.FLOW * this.speedFlowFactor;
    this.flowTimer = 0;
    const energyAward = this.grantEnergy(GLASS.ENERGY);
    const scoreAward = Math.round(
      GLASS.SCORE * this.flowMultiplier * this.speedRewardFactor * this.heatFx.scoreMult,
    );
    this.score += scoreAward;
    this.stats.glassSmashed++;
    this.analysis.notePrecision();
    this.events.emit("shatter", {
      x: o.cx,
      y: o.cy,
      s: o.cs,
      hx: o.hx,
      hy: o.hy,
      scoreAward,
      energyAward,
    });
  }

  /** Bumper contact: fling sideways, eject from the overlap, pay a little. */
  private onBounce(o: Obstacle): void {
    const dir = this.x === o.cx ? (this.latVel >= 0 ? 1 : -1) : this.x > o.cx ? 1 : -1;
    this.latVel =
      dir * Math.max(BUMPER.MIN_FLING, Math.abs(this.latVel) * 0.4 + this.speed * BUMPER.FLING_K);
    this.x = o.cx + dir * (o.hx + CRAFT.RADIUS + 0.05);
    this.speed *= BUMPER.SPEED_KEEP;
    o.state = this.time + BUMPER.COOLDOWN;
    o.nearMissed = true; // Consumed: a bounce never doubles as a graze.
    this.flowPoints += BUMPER.FLOW * this.speedFlowFactor;
    this.flowTimer = 0;
    const scoreAward = Math.round(BUMPER.SCORE * this.flowMultiplier * this.heatFx.scoreMult);
    this.score += scoreAward;
    this.stats.bounces++;
    this.events.emit("bounce", { x: o.cx, s: o.cs, dir, scoreAward });
    // A bumper may eject the craft beyond the edge in this same fixed tick.
    this.checkTrackEdge();
  }

  private onHit(o: Obstacle): void {
    // Tin Hull: shields neither spawn nor absorb — every contact is fatal.
    if (this.hasShield && this.heatFx.shields) {
      this.hasShield = false;
      this.iframes = RUN.SHIELD_IFRAMES;
      this.flowPoints = Math.max(0, this.flowPoints - FLOW.SHIELD_PENALTY);
      this.flowChain = 0;
      this.flowChainTimer = FLOW.CHAIN_WINDOW + 1;
      this.lastPass = null;
      this.events.emit("shieldBreak", { x: this.x });
      return;
    }
    this.onCrash({
      cause: "obstacle",
      patternId: o.patternId,
      obstacleKind: o.kind,
      motion: o.motion,
    });
  }

  /** The center leaves the track; preserve position and velocity for the wreck. */
  private checkTrackEdge(): boolean {
    if (this.status !== "running") return false;
    const localX = this.x - this.course.offsetAt(this.distance);
    if (Math.abs(localX) < TRACK.X_LIMIT) return false;
    const edge = localX < 0 ? -1 : 1;
    this.onCrash({
      cause: "edge",
      edge,
      patternId: edge < 0 ? "leftEdge" : "rightEdge",
      obstacleKind: null,
      motion: 0,
    });
    return true;
  }

  private onCrash(cause: DeathCause): void {
    if (this.status !== "running") return;
    this.status = "dead";
    this.deathTimer = 0;
    this.deathX = this.x;
    this.deathY = this.y;
    this.deathSpeed = this.speed;
    this.deathLatVel = this.latVel;
    this.deathVy = this.vy;
    this.deathBank = this.bank;
    this.analysis.pushTrace(); // The impact itself always lands in the trace.
    this.analysis.finalizeSection(); // Partial section where the run ended still counts.
    this.stats.lineRating = this.analysis.computeLineRating();
    this.stats.score = Math.floor(this.score);
    this.stats.distance = this.distance;
    this.stats.duration = this.time;
    this.stats.deathCause = cause;
    this.events.emit("death", {
      x: this.x,
      y: this.y,
      s: this.distance,
      speed: this.speed,
      latVel: this.latVel,
      vy: this.vy,
      bank: this.bank,
      ...cause,
      cause: cause.cause ?? "obstacle",
    });
  }

  /** A time-limited run survived to its horizon (sprint, roadmap 4.2). */
  private onFinish(): void {
    this.status = "finished";
    this.deathTimer = 0;
    this.deathX = this.x;
    this.deathSpeed = this.speed;
    this.analysis.pushTrace();
    this.analysis.finalizeSection(); // The section in progress at the line still counts.
    this.stats.lineRating = this.analysis.computeLineRating();
    this.stats.score = Math.floor(this.score);
    this.stats.distance = this.distance;
    this.stats.duration = this.time;
    this.events.emit("finish", {
      score: this.stats.score,
      distance: this.distance,
    });
  }

  private updatePickups(dt: number): void {
    const craftS = this.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;

    for (const p of this.pickups) {
      if (!p.active) continue;
      if (p.s < behind) {
        this.entities.releasePickup(p);
        continue;
      }

      const dS = p.s - craftS;
      const dx = p.x - this.x;
      // Vertical gate (skyhook air shards): only separation beyond the
      // craft/pickup reach counts, so every grounded layout (shards at
      // 1.3–1.5 vs hover 1.15) keeps its exact classic 2D distance.
      const dyGap = Math.max(0, Math.abs(p.y - this.y) - 1.35);
      const distSq = dS * dS + dx * dx + dyGap * dyGap;

      if (p.type === "shard") {
        if (
          this.heatFx.magnet &&
          p.magnetic &&
          !p.seeking &&
          distSq < ENERGY.MAGNET_RADIUS * ENERGY.MAGNET_RADIUS
        ) {
          p.seeking = true;
        }
        if (p.seeking) {
          const d = Math.sqrt(distSq) || 1;
          const pull = 34 * dt;
          p.x -= (dx / d) * pull * 0.6;
          p.s -= (dS / d) * pull;
          // Seek toward the craft's height (== HOVER_HEIGHT when grounded).
          p.y = lerp(p.y, this.y, 8 * dt);
        }
      }

      const cr = ENERGY.COLLECT_RADIUS;
      if (distSq < cr * cr) {
        this.entities.releasePickup(p);
        if (p.type === "shard") {
          this.shardCombo = this.shardComboTimer <= ENERGY.COMBO_WINDOW
            ? Math.min(ENERGY.COMBO_CAP, this.shardCombo + 1)
            : 1;
          this.shardComboTimer = 0;
          this.stats.bestShardCombo = Math.max(this.stats.bestShardCombo, this.shardCombo);
          const risk = !p.magnetic;
          const riskBonus = risk ? 1.6 : 1;
          const nominalEnergy =
            (ENERGY.PER_SHARD + (this.shardCombo - 1) * ENERGY.COMBO_ENERGY_STEP) * riskBonus;
          const energyBefore = this.energy;
          this.energy = Math.min(ENERGY.MAX, this.energy + nominalEnergy);
          const energyAward = this.energy - energyBefore;
          this.flowPoints += FLOW.POINTS_PER_SHARD * riskBonus;
          this.flowTimer = 0;
          const scoreAward = Math.round(
            ENERGY.SHARD_SCORE *
            (1 + (this.shardCombo - 1) * ENERGY.COMBO_SCORE_STEP) *
            this.flowMultiplier *
            riskBonus *
            this.heatFx.scoreMult,
          );
          this.score += scoreAward;
          this.stats.shards++;
          this.events.emit("shard", {
            x: p.x,
            y: p.y,
            combo: this.shardCombo,
            scoreAward,
            energyAward,
            risk,
          });
        } else {
          this.hasShield = true;
          this.events.emit("shieldPickup", { x: p.x });
        }
      }
    }
  }
}
