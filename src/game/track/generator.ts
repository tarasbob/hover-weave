import { SPEED, TRACK } from "../core/constants";
import { clamp01, lerp } from "../core/mathUtils";
import type { Rng } from "../core/rng";
import type { BuildCtx, ObstacleSpec, PatternDef, PatternResult, PickupSpec } from "../core/types";
import { biomeIndexAt } from "./biomes";
import { BREATHER, FIELD_PATTERNS, NORMAL_PATTERNS } from "./patterns";
import { SETPIECES } from "./setpieces";
import { mutatePattern } from "./mutators";
import {
  openLanes,
  validatePattern,
  widestCorridor,
  type ValidationResult,
} from "./validator";

export interface GeneratedChunk {
  s0: number;
  s1: number;
  patternId: string;
  announce?: string;
  obstacles: ObstacleSpec[];
  pickups: PickupSpec[];
  debug?: ValidationResult;
}

/** Difficulty curve: fast early growth, asymptotic tail, gentle waves. */
export function difficultyAt(s: number): number {
  const base = 1 - Math.exp(-s / 3800);
  const wave = Math.sin(s * 0.0011) * 0.07;
  return clamp01(base * 0.92 + wave + 0.04);
}

/** Target craft speed at distance s (before boost/flow modifiers). */
export function speedAt(s: number): number {
  return lerp(SPEED.BASE, SPEED.MAX, 1 - Math.exp(-s / SPEED.RAMP_DISTANCE));
}

export interface GeneratorEmit {
  chunk(chunk: GeneratedChunk): void;
}

/**
 * Streams patterns ahead of the craft. Every chunk — including all random
 * mutations — is validated by the lane-reachability solver before being
 * accepted; corridors chain so the exit of one pattern always feeds legal
 * entries of the next.
 */
export class TrackGenerator {
  private rng: Rng;
  generatedUpTo = 0;
  private exitLanes: Uint8Array;
  private sinceSetpiece = 0;
  private sinceField = 0;
  private forceBreather = true;
  private lastPatternId = "";
  private shieldCooldown = 900;
  private nextSetpieceAt: number;
  private nextFieldAt: number;
  /** Track distance at which each pattern was last used (novelty weighting). */
  private lastUsedAt = new Map<string, number>();
  readonly debug: boolean;
  /** Stats for tests. */
  rejections = 0;
  fallbacks = 0;

  constructor(rng: Rng, debug = false) {
    this.rng = rng;
    this.debug = debug;
    this.exitLanes = openLanes();
    this.nextSetpieceAt = rng.range(650, 950);
    this.nextFieldAt = rng.range(250, 500);
  }

  fill(target: number, emit: GeneratorEmit): void {
    let guard = 0;
    while (this.generatedUpTo < target && guard++ < 64) {
      emit.chunk(this.nextChunk());
    }
  }

  private nextChunk(): GeneratedChunk {
    // Randomized obstacle-free seam between patterns: repositioning slack for
    // the craft and dilation room for the validator.
    const runway = this.rng.range(18, 34);
    const s0 = this.generatedUpTo + runway;

    // Per-chunk difficulty surprise (after the opening stretch) keeps the
    // same distance from playing identically across runs.
    const baseDifficulty = difficultyAt(s0);
    const difficulty =
      s0 > 300 ? clamp01(baseDifficulty + this.rng.range(-0.08, 0.12)) : baseDifficulty;
    const speed = speedAt(s0);
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
    for (let attempt = 0; attempt < 6; attempt++) {
      const tryPattern = attempt < 4 ? pattern : BREATHER;
      const tryCtx: BuildCtx = {
        ...baseCtx,
        difficulty: Math.max(0, difficulty * (1 - attempt * 0.18)),
      };
      const built = tryPattern.build(tryCtx);
      mutatePattern(this.rng, built, s0, tryPattern.category, baseCtx.entryX);
      const v = validatePattern(
        built.obstacles,
        s0,
        built.length,
        this.exitLanes,
        runway,
        this.debug,
      );
      if (v.ok) {
        result = built;
        validation = v;
        usedPattern = tryPattern;
        if (attempt > 0) this.rejections += attempt;
        if (tryPattern !== pattern) this.fallbacks++;
        break;
      }
    }
    if (!result || !validation) {
      // Truly unreachable in practice; emit an empty stretch as a last resort.
      this.fallbacks++;
      result = { length: 90, exitX: 0, exitHalf: TRACK.X_LIMIT - 2, obstacles: [], pickups: [] };
      validation = validatePattern([], s0, 90, openLanes(), runway, this.debug);
      usedPattern = BREATHER;
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
      this.nextSetpieceAt = this.rng.range(650, 1000);
      this.forceBreather = true;
    } else {
      this.sinceSetpiece += span;
      this.forceBreather = false;
    }
    if (usedPattern.category === "field") {
      this.sinceField = 0;
      this.nextFieldAt = this.rng.range(450, 800);
    } else {
      this.sinceField += span;
    }
    this.lastPatternId = usedPattern.id;
    this.lastUsedAt.set(usedPattern.id, s0);

    const pickups = [...result.pickups];
    this.placePathPickups(validation, pickups, s0);

    this.generatedUpTo = s0 + result.length;
    const chunk: GeneratedChunk = {
      s0,
      s1: this.generatedUpTo,
      patternId: usedPattern.id,
      announce: result.announce,
      obstacles: result.obstacles,
      pickups,
    };
    if (this.debug) chunk.debug = validation;
    return chunk;
  }

  private choosePattern(
    difficulty: number,
    biome: number,
    entryHalf: number,
    s0: number,
  ): PatternDef {
    if (this.forceBreather) return BREATHER;

    const eligible = (p: PatternDef) =>
      difficulty >= p.minDifficulty - 0.02 &&
      difficulty <= p.maxDifficulty + 0.35 &&
      (!p.biomes || p.biomes.includes(biome)) &&
      (p.maxEntryHalf === undefined || entryHalf <= p.maxEntryHalf) &&
      (p.minEntryHalf === undefined || entryHalf >= p.minEntryHalf) &&
      p.id !== this.lastPatternId;

    // Cadence guarantees: set-pieces trump, then overdue field sections.
    const setpieceDue = this.sinceSetpiece > this.nextSetpieceAt;
    const fieldDue = this.sinceField > this.nextFieldAt;
    let pool: PatternDef[];
    if (setpieceDue) {
      pool = SETPIECES.filter(eligible);
      if (pool.length === 0) return this.rng.pick(SETPIECES);
    } else if (fieldDue) {
      pool = FIELD_PATTERNS.filter(eligible);
      if (pool.length === 0) pool = [...NORMAL_PATTERNS, ...FIELD_PATTERNS].filter(eligible);
    } else {
      pool = [...NORMAL_PATTERNS, ...FIELD_PATTERNS].filter(eligible);
    }
    if (pool.length === 0) return BREATHER;

    // Novelty bonus: the longer since a pattern last appeared, the likelier.
    const weights = pool.map((p) => {
      const last = this.lastUsedAt.get(p.id);
      const staleness = last === undefined ? 3000 : s0 - last;
      return p.weight * (1 + Math.min(1.5, staleness / 3000));
    });
    return pool[this.rng.weighted(weights)];
  }

  private placePathPickups(v: ValidationResult, pickups: PickupSpec[], s0: number): void {
    if (v.path.length < 3) return;
    for (let i = 2; i < v.path.length - 1; i += 5) {
      if (!this.rng.chance(0.4)) continue;
      const [s, x] = v.path[i];
      if (pickups.some((p) => Math.abs(p.s - s) < 7)) continue;
      pickups.push({ type: "shard", s, x, y: 1.3 });
    }
    if (s0 > this.shieldCooldown && this.rng.chance(0.3)) {
      const [s, x] = v.path[Math.floor(v.path.length / 2)];
      pickups.push({ type: "shield", s, x, y: 1.5 });
      this.shieldCooldown = s0 + this.rng.range(1100, 1800);
    }
  }
}
