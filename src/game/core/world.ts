import {
  BUMPER,
  CARVE,
  CRAFT,
  DANGER,
  DASH,
  ENERGY,
  EVENTS,
  FIXED_DT,
  FLOW,
  GLASS,
  lookaheadFor,
  MAX_STEPS_PER_FRAME,
  onBeatAt,
  RAMP,
  rampMaxFlight,
  RESONANCE,
  RUN,
  SERPENT,
  SPEED,
  SPRINT_MODE,
  STEER,
  SURGE,
  THREAD,
  TRACK,
} from "./constants";
import { Emitter } from "./events";
import { NO_HEAT, normalizeHeat, resolveHeat, type HeatEffects, type HeatId } from "./heat";
import { NO_LAB, normalizeLab, resolveLab, type LabEffects, type LabId } from "./lab";
import type { InputState } from "./input";
import { circleObbDistSq, clamp, clamp01, lerp, pistonPulse } from "./mathUtils";
import type { GameMode, RunConfig } from "./modes";
import { InputRecorder, quantizeAxis, type RunRecording } from "./replay";
import { createRng, type Rng } from "./rng";
import {
  Motion,
  type LandingGrade,
  type MotionType,
  type Obstacle,
  type ObstacleKind,
  type ObstacleSpec,
  type Pickup,
  type PatternSkill,
  type PrecisionGrade,
  type RouteChoiceSpec,
  type RouteReward,
  type RunEventKind,
  type RunStatus,
} from "./types";
import { biomeIndexAt, BIOMES, MYTHIC_ZONES } from "../track/biomes";
import { Course } from "../track/course";
import { speedAt, TrackGenerator, type GeneratedChunk } from "../track/generator";
import { trialById, type TrialDef } from "../track/trials";

// Sized for the LOOKAHEAD.MAX horizon (~2.2× the 720 m baseline peaks).
const OBSTACLE_CAP = 2600;
const PICKUP_CAP = 420;

export function obstacleTrailingEdge(o: Obstacle): number {
  if (o.motion === Motion.RotateYaw) return o.cs + Math.hypot(o.hx, o.hs);
  if (o.motion === Motion.OrbitXZ) {
    return o.s + Math.abs(o.m0) + Math.max(o.hx, o.hs);
  }
  const extent = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
  return o.cs + extent;
}

export interface DeathCause {
  patternId: string;
  obstacleKind: ObstacleKind;
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

/**
 * Grade a traversed chunk. Precision demand scales with the chunk's authored
 * intensity, pace pays for holding boost through it, flow uptime for keeping
 * the meter alive — an edge-hugging cruise grades C, a threaded boost line S.
 */
export function gradeSection(m: SectionMetrics): {
  grade: SectionGrade;
  composite: number;
  precision: number;
  pace: number;
} {
  const eventRate = (m.events / Math.max(1, m.traversed)) * 100;
  const precision = clamp01(eventRate / (1.1 * Math.max(1, m.intensity)));
  const pace = clamp01((m.avgSpeed / Math.max(1, m.baseSpeed) - 0.92) / 0.5);
  const composite = 0.45 * precision + 0.3 * m.flowUptime + 0.25 * pace;
  const grade: SectionGrade =
    composite >= 0.8 ? "S" : composite >= 0.55 ? "A" : composite >= 0.3 ? "B" : "C";
  return { grade, composite, precision, pace };
}

/** Sections below this intensity are transit, not tests — never graded. */
export const GRADE_MIN_INTENSITY = 2;

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

export const TRACE_OPEN_CLEARANCE = 99;
const TRACE_EVERY_STEPS = 4; // 120 Hz sim -> 30 Hz trace.
const TRACE_CAP = 1024;

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
  /** Carve pumps + wall-kisses landed (lab "carve" only; 0 otherwise). */
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

  stats: RunStats = this.emptyStats();

  // Input recording (roadmap 3.1). The sim consumes the quantized axis, so a
  // saved recording re-simulates the run bit-exactly.
  readonly recorder = new InputRecorder();
  /** Disable for replay/ghost worlds (a replay of a replay is itself). */
  recordInputs = true;

  // Always-on forensics + grading state (roadmap 3.3 / 3.4).
  readonly chunkLog: ChunkRecord[] = [];
  private traceRing: TraceSample[] = [];
  private traceIdx = 0;
  /** Envelopes of recently recycled obstacles — the kill-cam window reaches
   *  well past DESPAWN_BEHIND, so the field behind the craft must be kept. */
  private recentObstacles: ForensicsObstacle[] = [];
  private stepCounter = 0;
  /** Tightest hull clearance seen since the last trace sample. */
  private sampleClearance = Infinity;
  private section: {
    s0: number;
    s1: number;
    patternId: string;
    intensity: number;
    enteredAt: number;
    steps: number;
    flowSteps: number;
    boostSteps: number;
    speedSum: number;
    events: number;
  } | null = null;

  // Drama director (seeded, distance-triggered global events).
  private eventRng: Rng = createRng("idle");
  private nextEventAt = Infinity;
  activeEvent: { kind: RunEventKind; endAt: number } | null = null;
  private meteorNextAt = 0;

  // Death.
  deathTimer = 0;
  deathX = 0;
  deathSpeed = 0;

  // Pools.
  readonly obstacles: Obstacle[] = [];
  readonly pickups: Pickup[] = [];
  private obstacleFree: number[] = [];
  private pickupFree: number[] = [];
  /** Live ramp wedges in the pool — 0 keeps the vertical step a no-op. */
  private liveRamps = 0;

  private generator: TrackGenerator | null = null;
  private accumulator = 0;
  /** Steering hold-time carried by the unfinished fixed tick (axis × seconds). */
  private pendingAxisTime = 0;
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

  constructor() {
    for (let i = 0; i < OBSTACLE_CAP; i++) {
      this.obstacles.push({
        id: i, active: false, kind: "box",
        s: 0, x: 0, y: 0, hx: 1, hy: 1, hs: 1, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0,
        role: "primary", glow: 1, collidable: true, inner: 0,
        cx: 0, cy: 0, cs: 0, cyaw: 0,
        state: 0, landed: false, nearMissed: false, nearMissClearance: Infinity,
        nearMissSide: 0,
        patternId: "", spawnTime: 0,
      });
      this.obstacleFree.push(OBSTACLE_CAP - 1 - i);
    }
    for (let i = 0; i < PICKUP_CAP; i++) {
      this.pickups.push({
        id: i, active: false, type: "shard", s: 0, x: 0, y: 0,
        seeking: false, magnetic: true, spawnTime: 0,
      });
      this.pickupFree.push(PICKUP_CAP - 1 - i);
    }
  }

  private emptyStats(): RunStats {
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

  /** Deactivate all live entities (used when returning to the title). */
  clearField(): void {
    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.liveRamps = 0;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
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
    this.eventRng = createRng(`${seed}|events`);
    this.activeEvent = null;
    this.meteorNextAt = 0;
    this.nextEventAt = this.trial
      ? Infinity
      : Math.max(skipTo, EVENTS.START) + this.eventRng.range(0, EVENTS.GAP_MAX - EVENTS.GAP_MIN);
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
    this.deathSpeed = 0;
    this.accumulator = 0;
    this.pendingAxisTime = 0;
    this.prevX = 0;
    this.prevDistance = 0;
    this.prevBank = 0;
    this.prevY = CRAFT.HOVER_HEIGHT;
    this.lastBiomeIndex = 0;
    this.nextMythicIndex = MYTHIC_ZONES.findIndex((zone) => zone.at > skipTo);
    if (this.nextMythicIndex < 0) this.nextMythicIndex = MYTHIC_ZONES.length;
    this.stats = this.emptyStats();
    this.stats.seed = seed;
    this.stats.mode = this.mode;
    this.stats.trialId = this.trialId;
    this.stats.heat = heat;
    this.stats.lab = lab;
    // Recording is only meaningful for real runs from the start line.
    this.recorder.reset(this.recordInputs && skipTo === 0);
    this.chunkLog.length = 0;
    this.traceRing.length = 0;
    this.traceIdx = 0;
    this.recentObstacles.length = 0;
    this.stepCounter = 0;
    this.sampleClearance = Infinity;
    this.section = null;

    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.liveRamps = 0;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
    this.debugChunks.length = 0;

    this.generator = new TrackGenerator(
      createRng(seed),
      this.collectDebug,
      this.trial,
      this.heatFx,
    );
    if (skipTo > 0) {
      this.distance = skipTo;
      this.prevDistance = skipTo;
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
      if (steps === 0 && bufferedTime > 0) {
        this.bufferedInput.axis =
          (this.pendingAxisTime + input.axis * (FIXED_DT - bufferedTime)) / FIXED_DT;
        this.bufferedInput.boost = input.boost;
        this.bufferedInput.dash = input.dash;
        stepInput = this.bufferedInput;
      }
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
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
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
      // The clamp follows the winding centerline: the corridor itself drifts,
      // so even an empty stretch asks for a gentle steer. Damping acts on the
      // WALL-RELATIVE velocity — a wall that chases the craft must not eat
      // its escape speed on every contact frame (flat course: wallVel = 0,
      // bit-identical to the classic clamp).
      const courseX = this.course.offsetAt(this.distance);
      const wallVel =
        (courseX - this.course.offsetAt(this.distance - this.speed * dt)) / dt;
      if (this.x < courseX - TRACK.X_LIMIT) {
        this.x = courseX - TRACK.X_LIMIT;
        if (this.labFx.carve && !this.airborne && axis >= CARVE.COMMIT) {
          this.wallKiss(1, wallVel, maxLat);
        } else {
          this.latVel = wallVel + Math.max(0, this.latVel - wallVel) * 0.4;
        }
      } else if (this.x > courseX + TRACK.X_LIMIT) {
        this.x = courseX + TRACK.X_LIMIT;
        if (this.labFx.carve && !this.airborne && axis <= -CARVE.COMMIT) {
          this.wallKiss(-1, wallVel, maxLat);
        } else {
          this.latVel = wallVel + Math.min(0, this.latVel - wallVel) * 0.4;
        }
      }
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
    if (alive) this.updateEvents();

    // --- Section tracking (before obstacle events, so passes confirmed
    // this step attribute to the chunk the craft is currently inside) -----
    if (alive) this.updateSection();

    // --- Obstacles: motion + collision + near miss ----------------------
    this.updateObstacles(dt, alive);
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
      this.stepCounter++;
      if (this.stepCounter % TRACE_EVERY_STEPS === 0) this.pushTrace();

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
   * Wall-kiss (carve): pressing away from the clamp at the moment of contact
   * reflects the into-wall velocity component instead of absorbing it — the
   * track edges become springboards for a carving craft. `away` is the
   * direction off the wall (+1 off the left wall, -1 off the right).
   */
  private wallKiss(away: number, wallVel: number, maxLat: number): void {
    const rel = (this.latVel - wallVel) * away; // negative = into the wall
    const out = rel < 0 ? -rel * CARVE.WALL_KISS_KEEP : rel;
    this.latVel = wallVel + out * away;
    if (rel < -0.3 * maxLat && this.pumpCooldown <= 0) {
      this.pumpCooldown = CARVE.PUMP_COOLDOWN;
      this.stats.pumps++;
      const quality = clamp01(-rel / maxLat);
      this.stats.pumpQualitySum += quality;
      this.events.emit("pump", {
        dir: away,
        x: this.x,
        wall: true,
        strength: quality,
      });
    }
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
    if (this.liveRamps === 0 && !this.airborne) return;

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
    if (this.liveRamps > 0) {
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
      if (this.section) this.section.events++;
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

  // --- Sections + trace + forensics -----------------------------------------

  /** Enter/exit chunk sections as the craft crosses them; accumulate metrics. */
  private updateSection(): void {
    const d = this.distance;
    if (this.section && d > this.section.s1) this.finalizeSection();
    if (!this.section) {
      for (const c of this.chunkLog) {
        if (c.s0 > d) break; // chunkLog is in track order
        if (d >= c.s0 && d <= c.s1) {
          this.section = {
            s0: c.s0, s1: c.s1, patternId: c.patternId, intensity: c.intensity,
            enteredAt: d, steps: 0, flowSteps: 0, boostSteps: 0, speedSum: 0, events: 0,
          };
          break;
        }
      }
    }
    const sec = this.section;
    if (sec) {
      sec.steps++;
      sec.speedSum += this.speed;
      if (this.flowPoints >= FLOW.POINTS_PER_TIER) sec.flowSteps++;
      if (this.boosting) sec.boostSteps++;
    }
  }

  private finalizeSection(): void {
    const sec = this.section;
    this.section = null;
    if (!sec || sec.steps < 30) return; // Sub-quarter-second slivers are noise.
    const traversed = Math.min(this.distance, sec.s1) - sec.enteredAt;
    if (traversed < 20) return;
    const flowUptime = sec.flowSteps / sec.steps;
    const { grade, composite, pace } = gradeSection({
      intensity: sec.intensity,
      events: sec.events,
      traversed,
      flowUptime,
      avgSpeed: sec.speedSum / sec.steps,
      baseSpeed: this.speedCurve((sec.s0 + sec.s1) / 2),
    });
    this.stats.sections.push({
      patternId: sec.patternId, intensity: sec.intensity,
      s0: sec.s0, s1: sec.s1,
      grade, composite, events: sec.events, flowUptime,
      boostUptime: sec.boostSteps / sec.steps, pace,
    });
    if (sec.intensity >= GRADE_MIN_INTENSITY) {
      this.events.emit("sectionGrade", {
        patternId: sec.patternId, intensity: sec.intensity, grade, composite,
      });
    }
  }

  private computeLineRating(): SectionGrade | null {
    const graded = this.stats.sections.filter((s) => s.intensity >= GRADE_MIN_INTENSITY);
    if (graded.length === 0) return null;
    let weight = 0;
    let sum = 0;
    for (const s of graded) {
      weight += s.intensity;
      sum += s.composite * s.intensity;
    }
    const c = sum / weight;
    return c >= 0.8 ? "S" : c >= 0.55 ? "A" : c >= 0.3 ? "B" : "C";
  }

  private pushTrace(): void {
    const sample: TraceSample = {
      s: this.distance,
      x: this.x,
      y: this.y,
      speed: this.speed,
      flow: this.flowPoints,
      clearance: Math.min(this.sampleClearance, TRACE_OPEN_CLEARANCE),
    };
    if (this.traceRing.length < TRACE_CAP) {
      this.traceRing.push(sample);
    } else {
      this.traceRing[this.traceIdx] = sample;
      this.traceIdx = (this.traceIdx + 1) % TRACE_CAP;
    }
    this.sampleClearance = Infinity;
  }

  /** Trace samples in chronological order. */
  getTrace(): TraceSample[] {
    if (this.traceRing.length < TRACE_CAP) return [...this.traceRing];
    return [
      ...this.traceRing.slice(this.traceIdx),
      ...this.traceRing.slice(0, this.traceIdx),
    ];
  }

  /** The finished run's input recording (null while recording is disabled). */
  getRecording(): RunRecording | null {
    return this.recorder.toRecording(this.config, this.stats.score, this.stats.distance);
  }

  /**
   * Snapshot everything the kill-cam needs (roadmap 3.3): your traced line,
   * the validator's solved path, and obstacle envelopes around the impact.
   * Call right after death — pools still hold the killing geometry.
   *
   * Everything is straightened into course-local coordinates (winding
   * offset subtracted), so the top-down map's ±X_LIMIT frame stays truthful.
   */
  buildForensics(behind = 320, ahead = 50): DeathForensics | null {
    if (this.status !== "dead") return null;
    const deathS = this.distance;
    const s0 = deathS - behind;
    const s1 = deathS + ahead;
    const local = (s: number, x: number) => x - this.course.offsetAt(s);

    const trace = this.getTrace()
      .filter((t) => t.s >= s0)
      .map((t) => ({ ...t, x: local(t.s, t.x) }));

    const path: [number, number][][] = [];
    for (const c of this.chunkLog) {
      if (c.s1 < s0 || c.s0 > s1) continue;
      const seg = c.path
        .filter(([s]) => s >= s0 && s <= s1)
        .map(([s, x]) => [s, local(s, x)] as [number, number]);
      if (seg.length >= 2) path.push(seg);
    }

    let obstacles: ForensicsObstacle[] = [];
    for (const rec of this.recentObstacles) {
      if (rec.s >= s0 && rec.s <= s1) {
        obstacles.push({ ...rec, x: local(rec.s, rec.x) });
      }
    }
    for (const o of this.obstacles) {
      if (!o.active || !o.collidable || o.kind === "decor" || o.kind === "ramp") continue;
      if (o.cs < s0 || o.cs > s1) continue;
      const vHalf = o.kind === "ring" ? o.hx : o.hy;
      if (o.cy - vHalf > CRAFT.Y_MAX || o.cy + vHalf < CRAFT.Y_MIN) continue;
      obstacles.push({
        kind: o.kind, s: o.cs, x: local(o.cs, o.cx),
        hx: o.hx, hs: o.hs, yaw: o.cyaw, inner: o.inner,
      });
    }
    if (obstacles.length > 240) {
      obstacles = obstacles
        .sort((a, b) => Math.abs(a.s - deathS) - Math.abs(b.s - deathS))
        .slice(0, 240);
    }

    return {
      deathS,
      deathX: local(deathS, this.deathX),
      deathSpeed: this.deathSpeed,
      s0,
      s1,
      trace,
      path,
      obstacles,
    };
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
    gen.fill(this.distance + this.genHorizon, {
      chunk: (chunk) => this.spawnChunk(chunk),
    });
  }

  // --- Drama director --------------------------------------------------------

  /**
   * Rare seeded global events. Rolls are distance-triggered off a dedicated
   * rng stream, so replays and twin worlds stay bit-exact.
   */
  private updateEvents(): void {
    if (this.nextEventAt === Infinity) return;
    const d = this.distance;
    const ev = this.activeEvent;
    if (ev) {
      if (ev.kind === "meteor" && d >= this.meteorNextAt) {
        this.meteorNextAt =
          d + this.eventRng.range(EVENTS.METEOR_SPACING_MIN, EVENTS.METEOR_SPACING_MAX);
        this.spawnEventMeteor();
      }
      if (d > ev.endAt) {
        this.activeEvent = null;
        this.nextEventAt = d + this.eventRng.range(EVENTS.GAP_MIN, EVENTS.GAP_MAX);
      }
      return;
    }
    if (d < this.nextEventAt) return;
    const kind: RunEventKind = this.eventRng.chance(0.55) ? "meteor" : "rush";
    if (kind === "rush") {
      // A rush with nothing to lay down (no solved paths ahead) is skipped —
      // re-roll a little later instead of announcing an empty event.
      if (!this.spawnRush()) {
        this.nextEventAt = d + this.eventRng.range(200, 400);
        return;
      }
      this.activeEvent = { kind, endAt: d + EVENTS.RUSH_LENGTH };
    } else {
      this.activeEvent = { kind, endAt: d + EVENTS.METEOR_LENGTH };
      this.meteorNextAt = d;
    }
    this.stats.runEvents++;
    this.events.emit("runEvent", {
      kind,
      name: kind === "meteor" ? "METEOR BARRAGE" : "GOLDEN RUSH",
    });
  }

  /** X of the validator's solved safe line at s (world frame), if known. */
  private safePathXAt(s: number): number | null {
    for (const c of this.chunkLog) {
      if (s < c.s0 || s > c.s1 || c.path.length === 0) continue;
      let best: number | null = null;
      let bestD = Infinity;
      for (const [ps, px] of c.path) {
        const dd = Math.abs(ps - s);
        if (dd < bestD) {
          bestD = dd;
          best = px;
        }
      }
      return bestD <= 6 ? best : null;
    }
    return null;
  }

  /**
   * Is track position s inside a live skyhook approach/flight/landing
   * window? Drama-director rocks must never salt a landing tube — an
   * airborne craft has no authority to dodge a fresh drop.
   */
  private inRampWindow(s: number): boolean {
    if (this.liveRamps === 0) return false;
    for (const o of this.obstacles) {
      if (!o.active || o.kind !== "ramp") continue;
      const lip = o.cs + o.hs;
      const flight = rampMaxFlight(o.hy, o.hs * 2, this.speedCurve(lip));
      if (s > o.cs - o.hs - 20 && s < lip + flight + 10) return true;
    }
    return false;
  }

  /**
   * One telegraphed meteor: lands ahead as a permanent rock, never within
   * METEOR_PATH_CLEAR of the solved safe line (nor inside a skyhook flight
   * window). No proven line => no rock.
   */
  private spawnEventMeteor(): void {
    const s = this.distance + this.eventRng.range(EVENTS.METEOR_LEAD_MIN, EVENTS.METEOR_LEAD_MAX);
    const safeX = this.safePathXAt(s);
    const off = this.course.offsetAt(s);
    // The rng draws below run unconditionally so the stream stays aligned
    // whether or not a legal spot exists.
    const lane = this.eventRng.range(-(TRACK.X_LIMIT - 3), TRACK.X_LIMIT - 3);
    const w = this.eventRng.range(1.3, 2.2);
    const hy = this.eventRng.range(2, 3.2);
    const yaw = this.eventRng.range(0, Math.PI);
    const drop = this.eventRng.range(0, 8);
    const restY = this.eventRng.range(1.4, 2);
    if (safeX === null) return;
    if (this.inRampWindow(s)) return;
    const x = off + lane;
    if (Math.abs(x - safeX) < EVENTS.METEOR_PATH_CLEAR + w) return;
    // spawnObstacle re-applies the course offset: hand it local-frame specs.
    const lx = x - off;
    const trigger = s - (this.speed * 1.45 + 34);
    this.spawnObstacle(
      {
        kind: "crystal", x: lx, s, y: 34 + drop,
        hx: w, hy, hs: w, yaw,
        role: "warn", glow: 1.6,
        motion: Motion.FallY, m0: trigger, m1: restY,
      },
      "meteorBarrage",
    );
    this.spawnObstacle(
      {
        kind: "box", x: lx, s, y: 0.06,
        hx: w + 0.5, hy: 0.06, hs: w + 0.5,
        role: "warn", glow: 2.2,
        collidable: false, noValidate: true,
      },
      "meteorBarrage",
    );
  }

  /** Golden rush: a shard river laid along the solved safe line ahead. */
  private spawnRush(): boolean {
    const d0 = this.distance + EVENTS.RUSH_LEAD;
    const d1 = d0 + EVENTS.RUSH_LENGTH;
    let laid = 0;
    for (const c of this.chunkLog) {
      if (c.s1 < d0 || c.s0 > d1) continue;
      for (let i = 0; i < c.path.length; i += 2) {
        const [s, x] = c.path[i];
        if (s < d0 || s > d1) continue;
        this.spawnPickupWorld("shard", s, x, 1.3, true);
        laid++;
      }
    }
    return laid >= 8;
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
    // Always-on lightweight chunk record: section grading needs the bounds
    // and intensity, the kill-cam needs the validator's solved path — keep
    // enough behind the craft to cover the forensics window. Paths are
    // authored in the straight local frame; store them in world frame.
    this.chunkLog.push({
      s0: chunk.s0,
      s1: chunk.s1,
      patternId: chunk.patternId,
      intensity: chunk.intensity,
      skills: chunk.skills,
      path: this.course.flat
        ? chunk.path
        : chunk.path.map(([s, x]) => [s, x + this.course.offsetAt(s)] as [number, number]),
    });
    while (
      this.chunkLog.length > 64 ||
      (this.chunkLog.length > 0 && this.chunkLog[0].s1 < this.distance - 380)
    ) {
      this.chunkLog.shift();
    }
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
    type: Pickup["type"],
    s: number,
    x: number,
    y: number,
    magnetic: boolean,
  ): void {
    const idx = this.pickupFree.pop();
    if (idx === undefined) {
      this.stats.pickupDrops++;
      return;
    }
    const pk = this.pickups[idx];
    pk.active = true;
    pk.type = type;
    pk.s = s;
    pk.x = x;
    pk.y = y;
    pk.seeking = false;
    pk.magnetic = magnetic;
    pk.spawnTime = this.time;
  }

  private spawnObstacle(spec: ObstacleSpec, patternId: string): void {
    const idx = this.obstacleFree.pop();
    if (idx === undefined) {
      this.stats.obstacleDrops++;
      return;
    }
    // Patterns author in the straight local frame; the winding course lands
    // here, at spawn time (validation already happened in the local frame).
    const courseX = this.course.offsetAt(spec.s);
    const o = this.obstacles[idx];
    o.active = true;
    o.kind = spec.kind;
    o.s = spec.s;
    o.x = spec.x + courseX;
    o.y = spec.y;
    o.hx = spec.hx;
    o.hy = spec.hy;
    o.hs = spec.hs;
    o.yaw = spec.yaw ?? 0;
    o.motion = spec.motion ?? Motion.None;
    // CloseIn's m0 is an absolute lateral target — shift it with the course.
    o.m0 = (spec.m0 ?? 0) + (o.motion === Motion.CloseIn ? courseX : 0);
    o.m1 = spec.m1 ?? 0;
    o.m2 = spec.m2 ?? 0;
    o.role = spec.role ?? "primary";
    o.glow = spec.glow ?? 1;
    o.collidable = spec.collidable ?? true;
    o.inner = spec.inner ?? 0;
    o.cx = o.x;
    o.cy = o.y;
    o.cs = o.s;
    o.cyaw = o.yaw;
    o.state = 0;
    o.landed = false;
    o.nearMissed = false;
    o.nearMissClearance = Infinity;
    o.nearMissSide = 0;
    o.patternId = patternId;
    o.spawnTime = this.time;
    if (o.kind === "ramp") this.liveRamps++;
  }

  private updateObstacles(dt: number, alive: boolean): void {
    const t = this.time;
    const craftS = this.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;
    let engageDensity = 0;
    let availDensity = 0;
    // Craft vertical band follows the (usually grounded) craft. `y` is set
    // to HOVER_HEIGHT *exactly* whenever no ramp is in play, so these are
    // bit-identical to the classic Y_MIN/Y_MAX constants on the ground.
    const yLo =
      this.y === CRAFT.HOVER_HEIGHT
        ? CRAFT.Y_MIN
        : this.y + (CRAFT.Y_MIN - CRAFT.HOVER_HEIGHT);
    const yHi =
      this.y === CRAFT.HOVER_HEIGHT
        ? CRAFT.Y_MAX
        : this.y + (CRAFT.Y_MAX - CRAFT.HOVER_HEIGHT);

    for (const o of this.obstacles) {
      if (!o.active) continue;

      if (obstacleTrailingEdge(o) < behind) {
        if (o.kind === "ramp") this.liveRamps = Math.max(0, this.liveRamps - 1);
        // Keep the envelope around for the kill-cam: its window reaches far
        // past the recycling line.
        if (o.collidable && o.kind !== "decor" && o.kind !== "ramp") {
          const vHalf = o.kind === "ring" ? o.hx : o.hy;
          if (o.cy - vHalf < CRAFT.Y_MAX && o.cy + vHalf > CRAFT.Y_MIN) {
            this.recentObstacles.push({
              kind: o.kind, s: o.cs, x: o.cx,
              hx: o.hx, hs: o.hs, yaw: o.cyaw, inner: o.inner,
            });
            while (
              this.recentObstacles.length > 600 ||
              (this.recentObstacles.length > 0 &&
                this.recentObstacles[0].s < craftS - 380)
            ) {
              this.recentObstacles.shift();
            }
          }
        }
        o.active = false;
        this.obstacleFree.push(o.id);
        continue;
      }

      // Motion evaluation.
      switch (o.motion) {
        case Motion.None:
          break;
        case Motion.SweepX:
          o.cx = o.x + Math.sin(t * o.m0 + o.m1) * o.m2;
          break;
        case Motion.Pendulum: {
          const ang = Math.sin(t * o.m2) * o.m1;
          o.cx = o.x + Math.sin(ang) * o.m0;
          o.cy = o.y - Math.cos(ang) * o.m0;
          break;
        }
        case Motion.FallY: {
          if (!o.landed) {
            if (craftS > o.m0) {
              o.state += 88 * dt; // Fall velocity accumulates.
              o.cy = Math.max(o.m1, o.cy - o.state * dt * 14);
              if (o.cy <= o.m1) {
                o.cy = o.m1;
                o.landed = true;
                this.events.emit("slabFall", { x: o.cx, s: o.cs });
              }
            }
          }
          break;
        }
        case Motion.RotateYaw:
          o.cyaw = o.m1 + t * o.m0;
          break;
        case Motion.OrbitXZ: {
          const a = o.m2 + t * o.m1;
          o.cx = o.x + Math.cos(a) * o.m0;
          o.cs = o.s + Math.sin(a) * o.m0;
          break;
        }
        case Motion.CloseIn: {
          const p = clamp01((craftS - o.m1) / Math.max(1, o.m2 - o.m1));
          const e = p * p * (3 - 2 * p);
          o.cx = lerp(o.x, o.m0, e);
          break;
        }
        case Motion.Piston: {
          const pulse = pistonPulse((t * o.m0 + o.m1));
          o.cx = o.x + o.m2 * pulse;
          break;
        }
        case Motion.Blink: {
          const raw = t * o.m0 + o.m1;
          const phase = raw - Math.floor(raw);
          // Fire moment: the phase wrapped into the ON window this step.
          if (phase < o.state && alive) {
            const ahead = o.cs - craftS;
            if (ahead > -6 && ahead < 70) this.events.emit("beamFire", { x: o.cx, s: o.cs });
          }
          o.state = phase;
          break;
        }
        case Motion.Serpent: {
          const dip = 0.5 + 0.5 * Math.sin(t * o.m0 + o.m1);
          o.cy = o.y - o.m2 * dip;
          o.cx = o.x + Math.sin(t * o.m0 * 0.63 + o.m1 * 1.7) * SERPENT.WOBBLE;
          break;
        }
      }

      // Ramps are rideable surfaces, never colliders or danger: the vertical
      // step reads them directly. They stay `collidable` so the validator
      // and gap-scanning bots route ground traffic around the deck.
      if (!alive || !o.collidable || o.kind === "ramp") continue;
      // Pulse beams only exist while their duty window is ON: no collision
      // and no clearance credit while phased out (passes still confirm).
      const beamOff = o.kind === "beam" && o.motion === Motion.Blink && o.state >= o.m2;

      // Broad phase along track.
      const stepLen = this.speed * dt;
      const sExtent = o.motion === Motion.RotateYaw
        ? Math.hypot(o.hx, o.hs)
        : Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
      const dS = craftS - o.cs;

      // Danger sample. Availability: is there anything to dodge in this
      // stretch at all? Engagement: is the craft's line actually near it?
      // Only geometry in the craft's vertical band counts — an arch crossbar
      // overhead is scenery, not danger. Overflight credit (fun-frontier
      // 6.2): an AIRBORNE craft samples the ground band instead, so vaulting
      // dense geometry keeps the engaged score stream alive — choosing to
      // fly over the thickest line pays like threading it.
      if (Math.abs(dS) < DANGER.S_WINDOW) {
        // Rings gauge danger by their tube band (hy): a grounded ring rim
        // fills the craft band exactly as before, while a skyhook air ring
        // far overhead never inflates ground availability.
        const vHalf = o.hy;
        const dLo = this.airborne ? CRAFT.Y_MIN : yLo;
        const dHi = this.airborne ? CRAFT.Y_MAX : yHi;
        if (o.cy - vHalf < dHi && o.cy + vHalf > dLo) {
          const ws = 1 - Math.abs(dS) / DANGER.S_WINDOW;
          availDensity += ws;
          const effHx = o.kind === "ring"
            ? o.hx
            : Math.abs(Math.cos(o.cyaw)) * o.hx + Math.abs(Math.sin(o.cyaw)) * o.hs;
          const dxEdge = Math.max(0, Math.abs(o.cx - this.x) - effHx - CRAFT.RADIUS);
          if (dxEdge < DANGER.X_REACH) {
            engageDensity += ws * (1 - dxEdge / DANGER.X_REACH);
          }
        }
      }

      const withinS = Math.abs(dS) < sExtent + stepLen + CRAFT.RADIUS + 1.5;

      if (withinS && !beamOff) {
        // Vertical overlap (movers use current cy, band follows the craft).
        const yOverlap = o.cy - o.hy < yHi && o.cy + o.hy > yLo;
        if (yOverlap) {
          let hit = false;
          let clearance = Infinity;

          if (o.kind === "ring") {
            const inS = Math.abs(dS) < o.hs + stepLen * 0.5 + CRAFT.RADIUS * 0.5;
            if (inS) {
              const dx = this.x - o.cx;
              const dy = this.y - o.cy;
              const r = Math.hypot(dx, dy);
              const innerEdge = o.inner - CRAFT.RADIUS * 0.4;
              const outerEdge = o.hx + CRAFT.RADIUS * 0.6;
              if (r > innerEdge && r < outerEdge) hit = true;
              else clearance = r <= innerEdge ? innerEdge - r : r - outerEdge;
            }
          } else {
            const distSq = circleObbDistSq(
              this.x, craftS,
              o.cx, o.cs,
              o.hx, o.hs + stepLen * 0.5,
              o.cyaw,
            );
            const rr = CRAFT.RADIUS;
            if (distSq < rr * rr) hit = true;
            clearance = Math.max(0, Math.sqrt(distSq) - rr);
          }

          if (hit && o.kind === "bumper") {
            // Elastic: a boing, never a death. Per-obstacle cooldown rides
            // in `state` so an overlapping frame can't machine-gun flings.
            if (this.time >= o.state) this.onBounce(o);
            continue;
          }
          if (hit && o.kind === "glass" && this.boostCharge >= GLASS.SMASH_CHARGE) {
            // Boost is the key: plow through, shower of shards, keep flying.
            this.onShatter(o);
            continue;
          }

          // Kill-cam trace: tightest hull clearance this sample window.
          if (hit) this.sampleClearance = 0;
          else if (clearance < this.sampleClearance) this.sampleClearance = clearance;

          if (hit) {
            // A collision cannot also pay out as a precision pass, including
            // contacts absorbed during shield iframes.
            o.nearMissed = true;
            if (this.iframes <= 0) {
              // FallY slabs still in the air far above can't hit the craft
              // (yOverlap already filtered), so any hit here is real.
              this.onHit(o);
              if (this.status !== "running") return;
            }
          } else if (
            !o.nearMissed &&
            o.motion !== Motion.FallY && // state doubles as fall velocity there
            clearance < THREAD.CLEARANCE
          ) {
            // Keep the true closest approach (and its side); payout happens
            // once fully passed. The wider THREAD band also tracks "pressed"
            // passes that only matter as thread partners.
            if (clearance < o.nearMissClearance) {
              o.nearMissClearance = clearance;
              o.nearMissSide = o.cx >= this.x ? 1 : -1;
            }
          }
        }
      }

      // Pass confirmation: obstacle fully behind the craft.
      if (
        !o.nearMissed &&
        o.nearMissClearance < THREAD.CLEARANCE &&
        o.motion !== Motion.FallY && // Falling slabs feel arbitrary for near-miss credit.
        obstacleTrailingEdge(o) < craftS - CRAFT.RADIUS
      ) {
        o.nearMissed = true;
        if (alive) this.onPassConfirmed(o);
      }
    }

    if (alive) {
      const engagement = 1 - Math.exp(-engageDensity / DANGER.REF_ENGAGE);
      const availability = 1 - Math.exp(-availDensity / DANGER.REF_AVAIL);
      this.dangerFactor =
        1 + DANGER.BONUS * engagement - DANGER.PENALTY * availability * (1 - engagement);
    }
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
    if (this.section) this.section.events++;

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
    if (this.section) this.section.events += 2;
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
    o.active = false;
    this.obstacleFree.push(o.id);
    this.flowPoints += GLASS.FLOW * this.speedFlowFactor;
    this.flowTimer = 0;
    const energyAward = this.grantEnergy(GLASS.ENERGY);
    const scoreAward = Math.round(
      GLASS.SCORE * this.flowMultiplier * this.speedRewardFactor * this.heatFx.scoreMult,
    );
    this.score += scoreAward;
    this.stats.glassSmashed++;
    if (this.section) this.section.events++;
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
    this.status = "dead";
    this.deathTimer = 0;
    this.deathX = this.x;
    this.deathSpeed = this.speed;
    this.pushTrace(); // The impact itself always lands in the trace.
    this.finalizeSection(); // Partial section where the run ended still counts.
    this.stats.lineRating = this.computeLineRating();
    this.stats.score = Math.floor(this.score);
    this.stats.distance = this.distance;
    this.stats.duration = this.time;
    this.stats.deathCause = {
      patternId: o.patternId,
      obstacleKind: o.kind,
      motion: o.motion,
    };
    this.events.emit("death", {
      x: this.x,
      speed: this.speed,
      patternId: o.patternId,
      obstacleKind: o.kind,
      motion: o.motion,
    });
  }

  /** A time-limited run survived to its horizon (sprint, roadmap 4.2). */
  private onFinish(): void {
    this.status = "finished";
    this.deathTimer = 0;
    this.deathX = this.x;
    this.deathSpeed = this.speed;
    this.pushTrace();
    this.finalizeSection(); // The section in progress at the line still counts.
    this.stats.lineRating = this.computeLineRating();
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
        p.active = false;
        this.pickupFree.push(p.id);
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
        p.active = false;
        this.pickupFree.push(p.id);
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
