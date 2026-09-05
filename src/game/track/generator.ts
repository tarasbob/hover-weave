import { OVERDRIVE, overdriveAt, RESONANCE, SPEED, TRACK } from "../core/constants";
import { NO_HEAT, type HeatEffects } from "../core/heat";
import { clamp, clamp01, lerp } from "../core/mathUtils";
import { createRng, type Rng } from "../core/rng";
import type {
  BuildCtx,
  ObstacleSpec,
  PatternDef,
  PatternResult,
  PatternSkill,
  PickupSpec,
  RouteChoiceSpec,
} from "../core/types";
import { biomeIndexAt } from "./biomes";
import { BREATHER, buildOpeningChoices, FIELD_PATTERNS, NORMAL_PATTERNS, OPENING_PATTERN } from "./patterns";
import { SETPIECES } from "./setpieces";
import { SKY_PATTERNS } from "./skyhooks";
import { mutatePattern, resonatePattern } from "./mutators";
import type { TrialDef } from "./trials";
import {
  openLanes,
  blockedRanges,
  validatePattern,
  widestCorridor,
  type CourseOffset,
  type ValidationResult,
} from "./validator";

export interface GeneratedChunk {
  s0: number;
  s1: number;
  patternId: string;
  requestedPatternId: string;
  attempts: number;
  intensity: number;
  skills: PatternSkill[];
  announce?: string;
  obstacles: ObstacleSpec[];
  pickups: PickupSpec[];
  /** Named authored branches for route-choice telemetry. */
  routes: RouteChoiceSpec[];
  /** Validator's solved safe line, [s, x] pairs (kill-cam + tooling). */
  path: [number, number][];
  debug?: ValidationResult;
}

/**
 * Difficulty curve: fast early growth, asymptotic tail, gentle waves.
 * Deliberately bounded to 0..1 — every pattern is authored against this
 * envelope. Late-game pressure past ~8 km comes from `overdriveAt` instead
 * (speed growth, seam shrink, validator tightening, mutator aggression).
 */
export function difficultyAt(s: number): number {
  const base = 1 - Math.exp(-s / 2400);
  const wave = Math.sin(s * 0.0011) * 0.07;
  return clamp01(base * 0.96 + wave + 0.035);
}

/**
 * Target craft speed at distance s (before boost/flow modifiers). Asymptotic
 * toward SPEED.MAX early, then slow unbounded log growth in overdrive — the
 * treadmill never stops accelerating, it just accelerates slowly.
 */
export function speedAt(s: number): number {
  const base = lerp(SPEED.BASE, SPEED.MAX, 1 - Math.exp(-s / SPEED.RAMP_DISTANCE));
  return base + OVERDRIVE.SPEED_PER_OCTAVE * overdriveAt(s);
}

export function patternIntensity(pattern: PatternDef): number {
  if (pattern.intensity) return pattern.intensity;
  if (pattern.category === "breather") return 1;
  if (pattern.category === "setpiece") return 4;
  if (pattern.category === "field") return 3;
  return clamp(Math.round(1.5 + pattern.minDifficulty * 4), 2, 5);
}

export interface GeneratorEmit {
  chunk(chunk: GeneratedChunk): void;
}

/**
 * Skyhook ids, for the sky cadence guarantee (fun-frontier 6.2). Sky normals
 * spawn *only* through the cadence (sky setpieces also rotate with the
 * set-piece cadence): presence is guaranteed by the metronome, so the
 * classic ground rotation keeps its exact competitive composition.
 */
const SKY_IDS = new Set(SKY_PATTERNS.map((p) => p.id));

/**
 * Streams patterns ahead of the craft. Every chunk — including all random
 * mutations — is validated by the lane-reachability solver before being
 * accepted; corridors chain so the exit of one pattern always feeds legal
 * entries of the next.
 *
 * In trial mode (roadmap 4.1) the generator loops a single forced pattern
 * and swaps the ambient difficulty/speed/pressure curves for the trial's
 * own escalation — everything else (mutators, validation, corridor
 * chaining, pickups) works exactly as on the endless track.
 */
export class TrackGenerator {
  private rng: Rng;
  private readonly trial: TrialDef | null;
  /** Resolved heat stack (identity when unheated — bit-identical streams). */
  private readonly heat: HeatEffects;
  private readonly courseOffset?: CourseOffset;
  generatedUpTo = 0;
  private exitLanes: Uint8Array;
  private sinceSetpiece = 0;
  private sinceField = 0;
  private sinceSky = 0;
  private forceBreather = true;
  private recoveryDue = false;
  private peakStreak = 0;
  private recentSkills: PatternSkill[] = [];
  private lastPatternId = "";
  private shieldCooldown = 900;
  private nextSetpieceAt: number;
  private nextFieldAt: number;
  /** Sky cadence guarantee: jumping is core, never seed luck (6.2). */
  private nextSkyAt: number;
  /** Track distance at which each pattern was last used (novelty weighting). */
  private lastUsedAt = new Map<string, number>();
  readonly debug: boolean;
  /** Stats for tests. */
  rejections = 0;
  fallbacks = 0;

  constructor(
    rng: Rng,
    debug = false,
    trial: TrialDef | null = null,
    heat: HeatEffects = NO_HEAT,
    courseOffset?: CourseOffset,
  ) {
    this.rng = rng;
    this.debug = debug;
    this.trial = trial;
    this.heat = heat;
    this.courseOffset = trial ? undefined : courseOffset;
    this.exitLanes = openLanes();
    this.nextSetpieceAt = rng.range(620, 900);
    this.nextFieldAt = rng.range(240, 440) * heat.fieldCadenceScale;
    // Low first draw: the wedge must land inside the first-flight jump
    // lesson window (600–1400 m) even after the gentle sub-500 m opening.
    // Trials never draw (nor fire) the sky cadence: their fixed-seed rng
    // streams — and with them every baked medal and reference distance —
    // stay byte-identical to the pre-skyhook bake.
    this.nextSkyAt = trial ? Infinity : rng.range(420, 560);
  }

  fill(target: number, emit: GeneratorEmit): void {
    let guard = 0;
    while (this.generatedUpTo < target && guard++ < 64) {
      emit.chunk(this.nextChunk());
    }
  }

  /** Ambient difficulty here (trials ramp on their own curve). */
  private difficultyFor(s: number): number {
    return this.trial ? this.trial.difficultyAt(s) : difficultyAt(s);
  }

  private speedFor(s: number): number {
    return this.trial ? this.trial.speedAt(s) : speedAt(s);
  }

  /** Late-pressure channel: endless overdrive, or the trial's own ramp. */
  private pressureFor(s: number): number {
    return this.trial ? this.trial.pressureAt(s) : overdriveAt(s);
  }

  private nextChunk(): GeneratedChunk {
    const entryLanes = this.exitLanes;
    // Randomized obstacle-free seam between patterns: repositioning slack for
    // the craft and dilation room for the validator. Overdrive (and the Dense
    // Field heat) squeezes the seams toward a ~10–14 m floor so late track
    // never offers free breath.
    const seamScale = this.heat.seamScale / (1 + 0.35 * this.pressureFor(this.generatedUpTo));
    const runway = this.rng.range(
      Math.max(10, 18 * seamScale),
      Math.max(14, 34 * seamScale),
    );
    const s0 = this.generatedUpTo + runway;

    // Per-chunk difficulty surprise (after the opening stretch) keeps the
    // same distance from playing identically across runs.
    const baseDifficulty = this.difficultyFor(s0);
    const difficulty =
      s0 > 300 ? clamp01(baseDifficulty + this.rng.range(-0.08, 0.12)) : baseDifficulty;
    const speed = this.speedFor(s0);
    const biome = biomeIndexAt(s0);

    const corridor = widestCorridor(this.exitLanes);
    const pattern = this.choosePattern(difficulty, biome, corridor.half, s0);
    const baseCtx: BuildCtx = {
      rng: this.rng,
      s0,
      difficulty,
      entryX: corridor.x,
      entryHalf: corridor.half,
      speed,
      biome,
    };

    let result: PatternResult | null = null;
    let validation: ValidationResult | null = null;
    let usedPattern = pattern;
    let attempts = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const tryPattern = attempt < 6 ? pattern : BREATHER;
      const tryCtx: BuildCtx = {
        ...baseCtx,
        difficulty: Math.max(0, difficulty * (1 - Math.min(attempt, 5) * 0.13)),
      };
      const built = tryPattern.build(tryCtx);
      mutatePattern(
        this.rng,
        built,
        s0,
        tryPattern.category,
        baseCtx.entryX,
        tryCtx.difficulty,
        this.pressureFor(s0),
        this.heat,
      );
      // Rhythm resonance (fun-frontier 2.1, mainline): re-time every mover
      // onto the beat grid after all mutation. Timing only — geometry,
      // envelopes, validation, and the rng stream are unaffected, so the
      // validator still proves exactly what it proved before the re-grid.
      // Past ~20 km, a growing deterministic subset moves in rational 3:2 /
      // 5:4 relationships. Trials retain the single grid for clean practice.
      const polyrhythm = this.trial
        ? 0
        : clamp01((this.pressureFor(s0) - 1.5) / 1.5);
      resonatePattern(built, RESONANCE.BPM, polyrhythm);
      const v = validatePattern(
        built.obstacles,
        s0,
        built.length,
        this.exitLanes,
        runway,
        this.debug,
        tryCtx.difficulty,
        this.heat.slackBias,
        this.courseOffset,
      );
      if (v.ok) {
        result = built;
        validation = v;
        usedPattern = tryPattern;
        attempts = attempt + 1;
        if (attempt > 0) this.rejections += attempt;
        if (tryPattern !== pattern) this.fallbacks++;
        break;
      }
    }
    if (!result || !validation) {
      // Truly unreachable in practice; emit an empty stretch as a last resort.
      this.fallbacks++;
      result = { length: 90, exitX: 0, exitHalf: TRACK.X_LIMIT - 2, obstacles: [], pickups: [] };
      validation = validatePattern(
        [], s0, 90, this.courseOffset ? this.exitLanes : openLanes(), runway, this.debug, difficulty,
        this.heat.slackBias, this.courseOffset,
      );
      usedPattern = BREATHER;
      attempts = 8;
    }

    // Chain corridors for the next pattern.
    let exitLanes = validation.exitLanes;
    let hasAny = false;
    for (let i = 0; i < exitLanes.length; i++) if (exitLanes[i]) hasAny = true;
    if (!hasAny) exitLanes = openLanes();
    this.exitLanes = exitLanes;

    // Pacing bookkeeping.
    const span = result.length + runway;
    if (usedPattern.category === "setpiece") {
      this.sinceSetpiece = 0;
      this.nextSetpieceAt = this.rng.range(620, 960) * lerp(1, 0.72, difficulty);
      this.forceBreather = s0 < 1800;
      this.recoveryDue = !this.forceBreather;
    } else {
      this.sinceSetpiece += span;
      this.forceBreather = false;
    }
    if (usedPattern.category === "field") {
      this.sinceField = 0;
      this.nextFieldAt =
        this.rng.range(420, 760) * lerp(1, 0.74, difficulty) * this.heat.fieldCadenceScale;
    } else {
      this.sinceField += span;
    }
    if (SKY_IDS.has(usedPattern.id)) {
      this.sinceSky = 0;
      // A wedge every ~8–14 s of play: ever-present, but never so dense
      // that the ground disciplines starve (the mix survey guards this).
      this.nextSkyAt = this.rng.range(650, 1100) * lerp(1, 0.9, difficulty);
    } else {
      this.sinceSky += span;
    }
    this.lastPatternId = usedPattern.id;
    this.lastUsedAt.set(usedPattern.id, s0);
    const usedIntensity = patternIntensity(usedPattern);
    if (this.recoveryDue && usedIntensity <= 2) {
      this.recoveryDue = false;
      this.peakStreak = 0;
    } else if (usedIntensity >= 4) {
      this.peakStreak++;
      if (this.peakStreak >= 2) this.recoveryDue = true;
    } else {
      this.peakStreak = Math.max(0, this.peakStreak - 1);
    }
    if (usedPattern.skills?.length) {
      this.recentSkills.push(...usedPattern.skills);
      while (this.recentSkills.length > 5) this.recentSkills.shift();
    }

    const pickups = [...result.pickups];
    this.placePathPickups(validation, pickups, result.obstacles, s0, difficulty);

    this.generatedUpTo = s0 + result.length;
    const chunk: GeneratedChunk = {
      s0,
      s1: this.generatedUpTo,
      patternId: usedPattern.id,
      requestedPatternId: pattern.id,
      attempts,
      intensity: usedIntensity,
      skills: usedPattern.skills ?? [],
      announce: result.announce,
      obstacles: result.obstacles,
      pickups,
      routes: result.routes ?? [],
      path: validation.path,
    };
    if (this.debug) chunk.debug = validation;
    // Remix the opening after the base generator has consumed its draws.
    // The seeded span supplies independent variation: new opening content
    // cannot resequence later fields, cadence, shield drops or trial courses.
    // 160m leaves the entire steer lesson (which ends by 100m) clear.
    if (!this.trial && usedPattern === BREATHER && s0 >= 160 && s0 < 500) {
      const opening = buildOpeningChoices({
        ...baseCtx,
        rng: createRng(`first-weave|${s0}|${result.length}`),
      }, result.length);
      const obstacles = [...result.obstacles, ...opening.obstacles];
      const proof = validatePattern(
        obstacles, s0, result.length, entryLanes, runway, this.debug,
        difficulty, this.heat.slackBias, this.courseOffset,
      );
      // The next authored section must retain exactly the same entry set.
      // If an extra choice alters that contract, keep the original breather.
      if (proof.ok && proof.exitLanes.every((lane, i) => lane === validation.exitLanes[i])) {
        chunk.patternId = OPENING_PATTERN.id;
        chunk.requestedPatternId = OPENING_PATTERN.id;
        chunk.skills = OPENING_PATTERN.skills ?? [];
        chunk.obstacles = obstacles;
        chunk.path = proof.path;
        chunk.pickups = pickups.map((pickup) => {
          const buried = opening.obstacles.some((obstacle) =>
            Math.abs(pickup.s - obstacle.s) < obstacle.hs + 3 &&
            blockedRanges(obstacle).some(([left, right]) => pickup.x >= left && pickup.x <= right),
          );
          if (!buried) return pickup;
          const closest = proof.path.reduce((best, point) =>
            Math.abs(point[0] - pickup.s) < Math.abs(best[0] - pickup.s) ? point : best,
          );
          return { ...pickup, x: closest[1] };
        });
        chunk.pickups.push(...opening.pickups);
        if (this.debug) chunk.debug = proof;
      }
    }
    return chunk;
  }

  private choosePattern(
    difficulty: number,
    biome: number,
    entryHalf: number,
    s0: number,
  ): PatternDef {
    // Trials loop their pattern from the first chunk; the validator retry
    // ladder (difficulty backoff -> breather) still applies per chunk.
    if (this.trial) return this.trial.pattern;
    if (this.forceBreather) return BREATHER;

    const eligible = (p: PatternDef) =>
      difficulty >= p.minDifficulty - 0.02 &&
      difficulty <= p.maxDifficulty + 0.35 &&
      (s0 >= 500 || patternIntensity(p) <= 1) &&
      (s0 >= 1400 || patternIntensity(p) <= 3) &&
      (!p.biomes || p.biomes.includes(biome)) &&
      (p.maxEntryHalf === undefined || entryHalf <= p.maxEntryHalf) &&
      (p.minEntryHalf === undefined || entryHalf >= p.minEntryHalf) &&
      (p.maxSpeed === undefined || this.speedFor(s0) <= p.maxSpeed) &&
      p.id !== this.lastPatternId;

    // A short low-intensity weave follows stacked peaks. Late recovery keeps
    // the player steering instead of dropping into a long empty breather.
    if (this.recoveryDue) {
      const recovery = NORMAL_PATTERNS.filter(
        (p) => eligible(p) && patternIntensity(p) <= 2,
      );
      if (recovery.length > 0) {
        const weights = recovery.map((p) => p.weight * this.noveltyWeight(p, s0));
        return recovery[this.rng.weighted(weights)];
      }
      return BREATHER;
    }

    // Cadence guarantees: set-pieces trump, then overdue skyhooks (jumping
    // is a core verb, never seed luck), then overdue field sections. Each
    // due-but-ineligible cadence falls through to the next (an early stuck
    // "setpiece due" must not shadow the sky guarantee for a kilometre).
    const setpieceDue = this.sinceSetpiece > this.nextSetpieceAt;
    const skyDue = this.sinceSky > this.nextSkyAt;
    const fieldDue = this.sinceField > this.nextFieldAt;
    let pool: PatternDef[] = [];
    if (setpieceDue) pool = SETPIECES.filter(eligible);
    if (pool.length === 0 && skyDue) pool = SKY_PATTERNS.filter(eligible);
    if (pool.length === 0 && fieldDue) pool = FIELD_PATTERNS.filter(eligible);
    if (pool.length === 0) {
      pool = [...NORMAL_PATTERNS, ...FIELD_PATTERNS].filter(eligible);
    }
    if (pool.length === 0) return BREATHER;

    // Director target: rapid distance ramp plus a rolling build/peak wave.
    const wave = (Math.sin(s0 / 310) + 1) * 0.5;
    const targetIntensity = clamp(Math.round(1 + difficulty * 3.3 + wave * difficulty), 1, 5);

    // Novelty, intensity fit, and skill variation shape the weighted pick.
    const weights = pool.map((p) => {
      const intensityFit = 1 / (1 + Math.abs(patternIntensity(p) - targetIntensity) * 0.72);
      const skills = p.skills ?? [];
      const repeats = skills.filter((skill) => this.recentSkills.includes(skill)).length;
      const skillNovelty = skills.length === 0 ? 1 : repeats === 0 ? 1.3 : Math.max(0.62, 1 - repeats * 0.16);
      return p.weight * this.noveltyWeight(p, s0) * intensityFit * skillNovelty;
    });
    return pool[this.rng.weighted(weights)];
  }

  private noveltyWeight(pattern: PatternDef, s0: number): number {
    const last = this.lastUsedAt.get(pattern.id);
    const staleness = last === undefined ? 3000 : s0 - last;
    return 1 + Math.min(1.5, staleness / 3000);
  }

  private placePathPickups(
    v: ValidationResult,
    pickups: PickupSpec[],
    obstacles: ObstacleSpec[],
    s0: number,
    difficulty: number,
  ): void {
    if (v.path.length < 3) return;
    for (let i = 2; i < v.path.length - 1; i += 8) {
      if (!this.rng.chance(lerp(0.3, 0.2, difficulty))) continue;
      const [s, safeX] = v.path[i];
      if (pickups.some((p) => Math.abs(p.s - s) < 10)) continue;
      let x = safeX;
      let riskRoute = false;
      if (difficulty > 0.2 && this.rng.chance(lerp(0.35, 0.78, difficulty))) {
        const candidate = clamp(
          safeX + this.rng.sign() * this.rng.range(2.5, lerp(4.5, 8, difficulty)),
          -TRACK.X_LIMIT + 2,
          TRACK.X_LIMIT - 2,
        );
        const blocked = obstacles.some(
          (o) =>
            Math.abs(o.s - s) < o.hs + 4 &&
            blockedRanges(o).some(([x0, x1]) => candidate > x0 - 1.2 && candidate < x1 + 1.2),
        );
        if (!blocked) {
          x = candidate;
          riskRoute = true;
        }
      }
      pickups.push({ type: "shard", s, x, y: 1.3, magnet: !riskRoute });
    }
    // Heat: Scarce Shields thins and delays the drip; Tin Hull removes it —
    // the chance draw still happens so unheated rng streams are untouched.
    const shieldChance = lerp(0.32, 0.1, difficulty) * this.heat.shieldChanceScale;
    if (s0 > this.shieldCooldown && this.rng.chance(shieldChance)) {
      const [s, x] = v.path[Math.floor(v.path.length / 2)];
      if (this.heat.shields) pickups.push({ type: "shield", s, x, y: 1.5 });
      this.shieldCooldown =
        s0 +
        this.rng.range(1250, 2100) *
          lerp(1, 1.25, difficulty) *
          this.heat.shieldCooldownScale;
    }
  }
}
