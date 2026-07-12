import { SPEED, TRACK } from "../core/constants";
import { clamp01, lerp } from "../core/mathUtils";
import type { Rng } from "../core/rng";
import type { BuildCtx, ObstacleSpec, PatternDef, PatternResult, PickupSpec } from "../core/types";
import { biomeIndexAt } from "./biomes";
import { BREATHER, NORMAL_PATTERNS } from "./patterns";
import { SETPIECES } from "./setpieces";
import {
  openLanes,
  validatePattern,
  widestCorridor,
  type ValidationResult,
} from "./validator";

/** Obstacle-free runway between consecutive patterns (meters). */
const SEAM_RUNWAY = 26;

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
 * Streams patterns ahead of the craft. Every chunk is validated by the
 * lane-reachability solver before being accepted; corridors chain so the
 * exit of one pattern always feeds legal entries of the next.
 */
export class TrackGenerator {
  private rng: Rng;
  generatedUpTo = 0;
  private exitLanes: Uint8Array;
  private sinceSetpiece = 0;
  private forceBreather = true;
  private lastPatternId = "";
  private shieldCooldown = 900;
  private nextSetpieceAt: number;
  readonly debug: boolean;
  /** Stats for tests. */
  rejections = 0;
  fallbacks = 0;

  constructor(rng: Rng, debug = false) {
    this.rng = rng;
    this.debug = debug;
    this.exitLanes = openLanes();
    this.nextSetpieceAt = rng.range(650, 950);
  }

  fill(target: number, emit: GeneratorEmit): void {
    let guard = 0;
    while (this.generatedUpTo < target && guard++ < 64) {
      emit.chunk(this.nextChunk());
    }
  }

  private nextChunk(): GeneratedChunk {
    // Leave a clean seam between patterns: the runway gives the craft slack
    // to reposition, and lets the validator dilate the entry corridor.
    const s0 = this.generatedUpTo + SEAM_RUNWAY;
    const difficulty = difficultyAt(s0);
    const speed = speedAt(s0);
    const biome = biomeIndexAt(s0);

    const corridor = widestCorridor(this.exitLanes);
    const pattern = this.choosePattern(difficulty, biome, corridor.half);
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
      const v = validatePattern(
        built.obstacles,
        s0,
        built.length,
        this.exitLanes,
        SEAM_RUNWAY,
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
      validation = validatePattern([], s0, 90, openLanes(), SEAM_RUNWAY, this.debug);
      usedPattern = BREATHER;
    }

    // Chain corridors for the next pattern.
    let exitLanes = validation.exitLanes;
    let hasAny = false;
    for (let i = 0; i < exitLanes.length; i++) if (exitLanes[i]) hasAny = true;
    if (!hasAny) exitLanes = openLanes();
    this.exitLanes = exitLanes;

    if (usedPattern.category === "setpiece") {
      this.sinceSetpiece = 0;
      this.nextSetpieceAt = this.rng.range(650, 1000);
      this.forceBreather = true;
    } else {
      this.sinceSetpiece += result.length + SEAM_RUNWAY;
      this.forceBreather = false;
    }
    this.lastPatternId = usedPattern.id;

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

  private choosePattern(difficulty: number, biome: number, entryHalf: number): PatternDef {
    if (this.forceBreather) return BREATHER;

    const setpieceDue = this.sinceSetpiece > this.nextSetpieceAt;
    const pool = (setpieceDue ? SETPIECES : NORMAL_PATTERNS).filter(
      (p) =>
        difficulty >= p.minDifficulty - 0.02 &&
        difficulty <= p.maxDifficulty + 0.35 &&
        (!p.biomes || p.biomes.includes(biome)) &&
        (p.maxEntryHalf === undefined || entryHalf <= p.maxEntryHalf) &&
        (p.minEntryHalf === undefined || entryHalf >= p.minEntryHalf) &&
        p.id !== this.lastPatternId,
    );
    if (pool.length === 0) return setpieceDue ? this.rng.pick(SETPIECES) : BREATHER;
    const idx = this.rng.weighted(pool.map((p) => p.weight));
    return pool[idx];
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
