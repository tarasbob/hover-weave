import {
  CRAFT,
  DANGER,
  ENERGY,
  FIXED_DT,
  FLOW,
  lookaheadFor,
  MAX_STEPS_PER_FRAME,
  RUN,
  SPEED,
  STEER,
  THREAD,
  TRACK,
} from "./constants";
import { Emitter } from "./events";
import type { InputState } from "./input";
import { circleObbDistSq, clamp, clamp01, lerp, pistonPulse } from "./mathUtils";
import { InputRecorder, quantizeAxis, type RunRecording } from "./replay";
import { createRng } from "./rng";
import {
  Motion,
  type MotionType,
  type Obstacle,
  type ObstacleKind,
  type ObstacleSpec,
  type Pickup,
  type PrecisionGrade,
  type RunStatus,
} from "./types";
import { biomeIndexAt, BIOMES } from "../track/biomes";
import { speedAt, TrackGenerator, type GeneratedChunk } from "../track/generator";

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

export interface RunStats {
  score: number;
  distance: number;
  nearMisses: number;
  closePasses: number;
  razorPasses: number;
  perfectPasses: number;
  threads: number;
  shards: number;
  bestShardCombo: number;
  bestFlowChain: number;
  maxFlowPoints: number;
  maxFlowTier: number;
  boosts: number;
  boostTime: number;
  obstacleDrops: number;
  pickupDrops: number;
  duration: number;
  seed: string;
  daily: boolean;
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

  // Run identity.
  seed = "";
  daily = false;
  status: RunStatus = "idle";

  // Craft state.
  x = 0;
  latVel = 0;
  bank = 0;
  distance = 0;
  speed = 0;
  /** Current speed as a 0..1 fraction of the possible span (for fx/audio). */
  speedNorm = 0;

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
  hasShield = false;
  iframes = 0;
  shardCombo = 0;
  shardComboTimer = 0;
  /** Danger-weighted passive score factor (line choice vs. available geometry). */
  dangerFactor = 1;
  /** Last confirmed tight pass, pending a thread pairing. */
  private lastPass: { at: number; side: number; award: number; clearance: number } | null = null;

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
    speedSum: number;
    events: number;
  } | null = null;

  // Death.
  deathTimer = 0;
  deathX = 0;
  deathSpeed = 0;

  // Pools.
  readonly obstacles: Obstacle[] = [];
  readonly pickups: Pickup[] = [];
  private obstacleFree: number[] = [];
  private pickupFree: number[] = [];

  private generator: TrackGenerator | null = null;
  private accumulator = 0;
  private lastBiomeIndex = 0;
  /** Interpolation snapshot for buttery rendering. */
  prevX = 0;
  prevDistance = 0;
  prevBank = 0;

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
      bestShardCombo: 0, bestFlowChain: 0,
      maxFlowPoints: 0, maxFlowTier: 0, boosts: 0, boostTime: 0,
      obstacleDrops: 0, pickupDrops: 0, duration: 0,
      seed: "", daily: false, deathCause: null,
      sections: [], lineRating: null,
    };
  }

  /** Deactivate all live entities (used when returning to the title). */
  clearField(): void {
    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
  }

  /**
   * Reset everything and start a new run. Instant — all pools are reused.
   * `skipTo` (dev/testing) jumps the craft deep into the run: chunks up to
   * the skip point are generated and discarded (same RNG stream as playing
   * there), so the field around the craft matches a real run exactly.
   */
  start(seed: string, daily: boolean, skipTo = 0): void {
    this.seed = seed;
    this.daily = daily;
    this.status = "running";
    this.x = 0;
    this.latVel = 0;
    this.bank = 0;
    this.distance = 0;
    this.speed = 0;
    this.speedNorm = 0;
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
    this.hasShield = false;
    this.iframes = 0;
    this.shardCombo = 0;
    this.shardComboTimer = 0;
    this.dangerFactor = 1;
    this.lastPass = null;
    this.deathTimer = 0;
    this.deathSpeed = 0;
    this.accumulator = 0;
    this.prevX = 0;
    this.prevDistance = 0;
    this.prevBank = 0;
    this.lastBiomeIndex = 0;
    this.stats = this.emptyStats();
    this.stats.seed = seed;
    this.stats.daily = daily;
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
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
    this.debugChunks.length = 0;

    this.generator = new TrackGenerator(createRng(seed), this.collectDebug);
    if (skipTo > 0) {
      this.distance = skipTo;
      this.prevDistance = skipTo;
      this.speed = speedAt(skipTo);
      this.time = SPEED.LAUNCH_RAMP; // Skip the launch ramp too.
      this.lastBiomeIndex = biomeIndexAt(skipTo);
      this.generator.fill(Math.max(0, skipTo - TRACK.DESPAWN_BEHIND - 50), {
        chunk: () => {},
      });
    }
    this.streamAhead();
    this.events.emit("runStart", { seed, daily });
    this.events.emit("biome", {
      index: this.lastBiomeIndex,
      name: BIOMES[this.lastBiomeIndex].label,
    });
  }

  /** Advance sim by wall-clock dt (handles fixed-step accumulation + slow-mo). */
  update(dt: number, input: InputState): void {
    if (this.status === "idle") return;

    let scale = 1;
    if (this.status === "dead") {
      this.deathTimer += dt;
      scale = RUN.DEATH_SLOWMO;
      if (this.deathTimer > RUN.DEATH_SLOWMO_DURATION) return; // Freeze world.
    }

    this.accumulator += Math.min(dt, 0.25) * scale;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.prevX = this.x;
      this.prevDistance = this.distance;
      this.prevBank = this.bank;
      const wasRunning = this.status === "running";
      this.step(FIXED_DT, input);
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

  get biomeIndex(): number {
    return biomeIndexAt(this.distance);
  }

  private step(dt: number, input: InputState): void {
    this.time += dt;
    const alive = this.status === "running";

    // The sim consumes the quantized axis — the recorded stream then replays
    // bit-exactly (roadmap 3.1). Dead/idle steps consume no input.
    const axis = alive ? quantizeAxis(input.axis) : 0;
    if (alive) this.recorder.record(axis, input.boost);

    // --- Speed ---------------------------------------------------------
    const launch = clamp01(this.time / SPEED.LAUNCH_RAMP);
    // Flow keeps paying score without bound, but its speed bonus stops at the
    // pre-uncap maximum tier — speed stays a boost-driven ratchet.
    const flowBonus =
      1 + Math.min(this.flowTier, FLOW.SPEED_BONUS_TIER_CAP) * FLOW.SPEED_BONUS_PER_TIER;
    let targetSpeed = speedAt(this.distance) * launch * flowBonus;

    // Boost.
    if (alive) {
      const wantBoost = input.boost && this.energy > (this.boosting ? 0 : ENERGY.BOOST_MIN);
      if (wantBoost && !this.boosting) {
        this.boosting = true;
        this.stats.boosts++;
        this.events.emit("boostStart", undefined);
      } else if (!wantBoost && this.boosting) {
        this.boosting = false;
        this.events.emit("boostEnd", undefined);
      }
      if (this.boosting) {
        this.energy = Math.max(0, this.energy - ENERGY.BOOST_DRAIN * dt);
        this.stats.boostTime += dt;
        if (this.energy <= 0) {
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

    this.speed = alive
      ? lerp(this.speed, targetSpeed, 1 - Math.exp(-2.8 * dt))
      : Math.max(0, this.speed - 90 * dt); // Crash deceleration.
    this.speedNorm = clamp01((this.speed - SPEED.BASE) / (SPEED.MAX * SPEED.BOOST_MULT - SPEED.BASE));

    if (alive) this.distance += this.speed * dt;
    if (alive) {
      const biome = biomeIndexAt(this.distance);
      if (biome !== this.lastBiomeIndex) {
        this.lastBiomeIndex = biome;
        this.events.emit("biome", { index: biome, name: BIOMES[biome].label });
      }
    }

    // --- Steering (speed-proportional, momentum-based) -------------------
    const maxLat = Math.max(10, this.speed) * STEER.RATIO;
    if (alive) {
      const authority = this.boosting ? STEER.BOOST_AUTHORITY : 1;
      this.latVel += axis * Math.max(10, this.speed) * STEER.ACCEL_K * authority * dt;
      const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
      this.latVel *= Math.exp(-drag * dt * (this.boosting ? 0.85 : 1));
      this.latVel = clamp(this.latVel, -maxLat, maxLat);
      this.x += this.latVel * dt;
      if (this.x < -TRACK.X_LIMIT) {
        this.x = -TRACK.X_LIMIT;
        this.latVel = Math.max(0, this.latVel) * 0.4;
      } else if (this.x > TRACK.X_LIMIT) {
        this.x = TRACK.X_LIMIT;
        this.latVel = Math.min(0, this.latVel) * 0.4;
      }
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

      // Score: distance rate scaled by flow multiplier and local danger —
      // flying where the geometry is dense pays; empty-edge hugging doesn't.
      const mult = 1 + this.flowPoints * FLOW.MULT_PER_POINT;
      this.score += this.speed * dt * mult * this.dangerFactor;

      this.stats.score = Math.floor(this.score);
      this.stats.distance = this.distance;
      this.stats.duration = this.time;
      this.stats.maxFlowPoints = Math.max(this.stats.maxFlowPoints, this.flowPoints);

      // 30 Hz line trace for the kill-cam (roadmap 3.3).
      this.stepCounter++;
      if (this.stepCounter % TRACE_EVERY_STEPS === 0) this.pushTrace();
    }
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
            enteredAt: d, steps: 0, flowSteps: 0, speedSum: 0, events: 0,
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
      baseSpeed: speedAt((sec.s0 + sec.s1) / 2),
    });
    this.stats.sections.push({
      patternId: sec.patternId, intensity: sec.intensity,
      s0: sec.s0, s1: sec.s1,
      grade, composite, events: sec.events, flowUptime, pace,
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
    return this.recorder.toRecording(
      this.seed, this.daily, this.stats.score, this.stats.distance,
    );
  }

  /**
   * Snapshot everything the kill-cam needs (roadmap 3.3): your traced line,
   * the validator's solved path, and obstacle envelopes around the impact.
   * Call right after death — pools still hold the killing geometry.
   */
  buildForensics(behind = 320, ahead = 50): DeathForensics | null {
    if (this.status !== "dead") return null;
    const deathS = this.distance;
    const s0 = deathS - behind;
    const s1 = deathS + ahead;

    const trace = this.getTrace().filter((t) => t.s >= s0);

    const path: [number, number][][] = [];
    for (const c of this.chunkLog) {
      if (c.s1 < s0 || c.s0 > s1) continue;
      const seg = c.path.filter(([s]) => s >= s0 && s <= s1);
      if (seg.length >= 2) path.push(seg);
    }

    let obstacles: ForensicsObstacle[] = [];
    for (const rec of this.recentObstacles) {
      if (rec.s >= s0 && rec.s <= s1) obstacles.push(rec);
    }
    for (const o of this.obstacles) {
      if (!o.active || !o.collidable || o.kind === "decor") continue;
      if (o.cs < s0 || o.cs > s1) continue;
      const vHalf = o.kind === "ring" ? o.hx : o.hy;
      if (o.cy - vHalf > CRAFT.Y_MAX || o.cy + vHalf < CRAFT.Y_MIN) continue;
      obstacles.push({
        kind: o.kind, s: o.cs, x: o.cx,
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
      deathX: this.deathX,
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

  private streamAhead(): void {
    const gen = this.generator;
    if (!gen) return;
    gen.fill(this.distance + this.genHorizon, {
      chunk: (chunk) => this.spawnChunk(chunk),
    });
  }

  private spawnChunk(chunk: GeneratedChunk): void {
    for (const spec of chunk.obstacles) this.spawnObstacle(spec, chunk.patternId);
    for (const p of chunk.pickups) {
      const idx = this.pickupFree.pop();
      if (idx === undefined) {
        this.stats.pickupDrops++;
        continue;
      }
      const pk = this.pickups[idx];
      pk.active = true;
      pk.type = p.type;
      pk.s = p.s;
      pk.x = p.x;
      pk.y = p.y;
      pk.seeking = false;
      pk.magnetic = p.magnet ?? true;
      pk.spawnTime = this.time;
    }
    if (chunk.announce) {
      this.events.emit("setpiece", { name: chunk.announce });
    }
    // Always-on lightweight chunk record: section grading needs the bounds
    // and intensity, the kill-cam needs the validator's solved path — keep
    // enough behind the craft to cover the forensics window.
    this.chunkLog.push({
      s0: chunk.s0,
      s1: chunk.s1,
      patternId: chunk.patternId,
      intensity: chunk.intensity,
      path: chunk.path,
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

  private spawnObstacle(spec: ObstacleSpec, patternId: string): void {
    const idx = this.obstacleFree.pop();
    if (idx === undefined) {
      this.stats.obstacleDrops++;
      return;
    }
    const o = this.obstacles[idx];
    o.active = true;
    o.kind = spec.kind;
    o.s = spec.s;
    o.x = spec.x;
    o.y = spec.y;
    o.hx = spec.hx;
    o.hy = spec.hy;
    o.hs = spec.hs;
    o.yaw = spec.yaw ?? 0;
    o.motion = spec.motion ?? Motion.None;
    o.m0 = spec.m0 ?? 0;
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
  }

  private updateObstacles(dt: number, alive: boolean): void {
    const t = this.time;
    const craftS = this.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;
    let engageDensity = 0;
    let availDensity = 0;

    for (const o of this.obstacles) {
      if (!o.active) continue;

      if (obstacleTrailingEdge(o) < behind) {
        // Keep the envelope around for the kill-cam: its window reaches far
        // past the recycling line.
        if (o.collidable && o.kind !== "decor") {
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
      }

      if (!alive || !o.collidable) continue;

      // Broad phase along track.
      const stepLen = this.speed * dt;
      const sExtent = o.motion === Motion.RotateYaw
        ? Math.hypot(o.hx, o.hs)
        : Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
      const dS = craftS - o.cs;

      // Danger sample. Availability: is there anything to dodge in this
      // stretch at all? Engagement: is the craft's line actually near it?
      // Only geometry in the craft's vertical band counts — an arch crossbar
      // overhead is scenery, not danger.
      if (Math.abs(dS) < DANGER.S_WINDOW) {
        const vHalf = o.kind === "ring" ? o.hx : o.hy;
        if (o.cy - vHalf < CRAFT.Y_MAX && o.cy + vHalf > CRAFT.Y_MIN) {
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

      if (withinS) {
        // Vertical overlap (movers use current cy).
        const yOverlap = o.cy - o.hy < CRAFT.Y_MAX && o.cy + o.hy > CRAFT.Y_MIN;
        if (yOverlap) {
          let hit = false;
          let clearance = Infinity;

          if (o.kind === "ring") {
            const inS = Math.abs(dS) < o.hs + stepLen * 0.5 + CRAFT.RADIUS * 0.5;
            if (inS) {
              const dx = this.x - o.cx;
              const dy = CRAFT.HOVER_HEIGHT - o.cy;
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
    if (this.section) this.section.events++;

    // Grazes fund boost — the perpetual-boost loop for elite play.
    const grazeEnergy =
      reward.grade === "perfect"
        ? ENERGY.GRAZE_PERFECT
        : reward.grade === "razor"
          ? ENERGY.GRAZE_RAZOR
          : ENERGY.GRAZE_CLOSE;
    const energyAward = this.grantEnergy(grazeEnergy);

    const chainBonus = 1 + Math.min(
      FLOW.CHAIN_SCORE_CAP,
      Math.max(0, this.flowChain - 1) * FLOW.CHAIN_SCORE_STEP,
    );
    const scoreAward = Math.round(
      reward.baseScore * this.flowMultiplier * chainBonus * this.speedRewardFactor,
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
    });
    return scoreAward;
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
    let scoreAward = Math.round(base * this.flowMultiplier * this.speedRewardFactor);
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
  }

  private onHit(o: Obstacle): void {
    if (this.hasShield) {
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
      const distSq = dS * dS + dx * dx;

      if (p.type === "shard") {
        if (p.magnetic && !p.seeking && distSq < ENERGY.MAGNET_RADIUS * ENERGY.MAGNET_RADIUS) {
          p.seeking = true;
        }
        if (p.seeking) {
          const d = Math.sqrt(distSq) || 1;
          const pull = 34 * dt;
          p.x -= (dx / d) * pull * 0.6;
          p.s -= (dS / d) * pull;
          p.y = lerp(p.y, CRAFT.HOVER_HEIGHT, 8 * dt);
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
            riskBonus,
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
