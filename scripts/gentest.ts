/**
 * Generator assertions: pattern validity, pacing bands, variety, and fallback
 * pressure across deterministic seeds.
 */
import assert from "node:assert/strict";
import { createRng } from "../src/game/core/rng";
import {
  TrackGenerator,
  difficultyAt,
  patternIntensity,
  speedAt,
} from "../src/game/track/generator";
import { BREATHER, FIELD_PATTERNS, NORMAL_PATTERNS } from "../src/game/track/patterns";
import { SETPIECES } from "../src/game/track/setpieces";
import { mutatePattern } from "../src/game/track/mutators";
import { validatePattern, corridorLanes } from "../src/game/track/validator";
import type { BuildCtx } from "../src/game/core/types";

const patterns = [...NORMAL_PATTERNS, ...FIELD_PATTERNS, ...SETPIECES, BREATHER];

// Per-pattern validation rate with a consistent entry corridor.
console.log("== standalone validation rates, mutators on (100 tries each) ==");
const rates = new Map<string, number>();
for (const p of patterns) {
  let ok = 0;
  const rng = createRng("standalone-" + p.id);
  for (let i = 0; i < 100; i++) {
    const difficulty = rng.range(Math.max(0, p.minDifficulty), Math.min(1, p.maxDifficulty));
    const s0 = 2000;
    const entryX = rng.range(-10, 10);
    const entryHalf = rng.range(4, Math.min(14, p.maxEntryHalf ?? 14));
    const ctx: BuildCtx = {
      rng, s0, difficulty,
      entryX, entryHalf,
      speed: speedAt(6000) * 1.2,
      biome: p.biomes ? p.biomes[0] : 0,
    };
    const built = p.build(ctx);
    mutatePattern(rng, built, s0, p.category, entryX, difficulty);
    const v = validatePattern(
      built.obstacles, s0, built.length,
      corridorLanes(entryX, entryHalf), 26, false, difficulty,
    );
    if (v.ok) ok++;
  }
  rates.set(p.id, ok);
  console.log(`${p.id.padEnd(20)} ${ok}%`);
  assert.ok(ok >= 95, `${p.id} validation rate regressed to ${ok}%`);
}

for (const id of ["precisionLadder", "pulseWeave", "rotorRhythm", "splitDecision", "apexGauntlet"]) {
  assert.ok((rates.get(id) ?? 0) >= 98, `${id} must be highly reliable`);
  const pattern = patterns.find((candidate) => candidate.id === id);
  assert.ok(pattern);
  const built = pattern.build({
    rng: createRng(`risk-${id}`),
    s0: 5000,
    difficulty: 0.9,
    entryX: 0,
    entryHalf: 8,
    speed: speedAt(5000),
    biome: pattern.biomes?.[0] ?? 0,
  });
  assert.ok(
    built.pickups.some((pickup) => pickup.type === "shard" && pickup.magnet === false),
    `${id} needs an explicit non-magnetic risk reward line`,
  );
}

let orbitMutationCovered = false;
for (let i = 0; i < 50 && !orbitMutationCovered; i++) {
  const result = {
    length: 80,
    exitX: 0,
    exitHalf: 10,
    pickups: [],
    obstacles: [{
      kind: "sphere" as const,
      s: 40,
      x: 0,
      y: 2,
      hx: 1,
      hy: 1,
      hs: 1,
      motion: 5 as const,
      m0: 8,
      m1: 1,
      m2: 0,
    }],
  };
  const log = mutatePattern(createRng(`orbit-mutation-${i}`), result, 0, "setpiece", 10, 1);
  if (log.moverBoost > 1) {
    assert.equal(result.obstacles[0].m0, 8, "orbit radius changed during mover boost");
    assert.equal(result.obstacles[0].m1, log.moverBoost, "orbit angular speed was not boosted");
    orbitMutationCovered = true;
  }
}
assert.ok(orbitMutationCovered, "could not exercise the orbit mover mutation");

assert.ok(difficultyAt(500) < 0.32, "opening difficulty should remain readable");
assert.ok(difficultyAt(2500) > 0.62, "expert ramp should arrive by roughly 2.5km");
assert.ok(speedAt(2500) > 50, "speed ramp should create meaningful pressure by 2.5km");

// Full-chain generation mix across seeds.
console.log("\n== chained generation mix over 8 × 30km ==");
const counts = new Map<string, number>();
let totalObstacles = 0;
let totalChunks = 0;
let totalRejections = 0;
let totalFallbacks = 0;
let latePeakSeen = false;
for (let seedIndex = 0; seedIndex < 8; seedIndex++) {
  const gen = new TrackGenerator(createRng(`mix-${seedIndex}`), false);
  while (gen.generatedUpTo < 30000) {
    const before = gen.generatedUpTo;
    gen.fill(30000, {
      chunk: (c) => {
        counts.set(c.patternId, (counts.get(c.patternId) ?? 0) + 1);
        totalObstacles += c.obstacles.length;
        totalChunks++;
        if (c.s0 < 500) {
          assert.ok(c.intensity <= 1, `opening spike: ${c.patternId} intensity ${c.intensity}`);
        } else if (c.s0 < 1400) {
          assert.ok(c.intensity <= 3, `early spike: ${c.patternId} intensity ${c.intensity}`);
        }
        if (c.s0 > 5000 && c.intensity >= 5) latePeakSeen = true;
        const definition = patterns.find((pattern) => pattern.id === c.patternId);
        assert.ok(definition, `unknown generated pattern ${c.patternId}`);
        assert.equal(c.intensity, patternIntensity(definition));
      },
    });
    assert.ok(gen.generatedUpTo > before, `generator stalled at ${before.toFixed(0)}m`);
  }
  assert.ok(gen.generatedUpTo >= 30000, `seed ${seedIndex} did not reach 30km`);
  totalRejections += gen.rejections;
  totalFallbacks += gen.fallbacks;
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [id, n] of sorted) console.log(`${id.padEnd(20)} ${n}`);
console.log(
  `chunks=${totalChunks}, obstacles=${totalObstacles}, rejections=${totalRejections}, ` +
  `fallbacks=${totalFallbacks}, ` +
  `difficulty@30km=${difficultyAt(30000).toFixed(2)}`,
);

const fallbackRate = totalFallbacks / totalChunks;
assert.ok(fallbackRate < 0.03, `fallback rate ${(fallbackRate * 100).toFixed(1)}% is too high`);
assert.ok(totalRejections / totalChunks < 0.5, "generator retries are under excessive pressure");
assert.ok(latePeakSeen, "late generation never produced an intensity-5 peak");
for (const id of ["precisionLadder", "pulseWeave", "rotorRhythm", "splitDecision", "apexGauntlet"]) {
  assert.ok((counts.get(id) ?? 0) > 0, `${id} never appeared across fixed generation seeds`);
}

console.log("generator assertions: PASS");
