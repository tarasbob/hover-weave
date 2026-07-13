/**
 * Generator assertions: pattern validity, pacing bands, variety, and fallback
 * pressure across deterministic seeds.
 */
import assert from "node:assert/strict";
import { overdriveAt, SPEED } from "../src/game/core/constants";
import { HEATS, normalizeHeat, resolveHeat } from "../src/game/core/heat";
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
import { TRIALS, trialSeed } from "../src/game/track/trials";
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

// Overdrive: exactly zero through the authored game, slow unbounded log
// growth past it — speed never stops climbing, but climbs slowly.
assert.equal(overdriveAt(0), 0);
assert.equal(overdriveAt(7999), 0, "overdrive must not leak below its start");
assert.ok(Math.abs(overdriveAt(16000) - 1) < 1e-9, "one octave at 16km");
assert.ok(Math.abs(overdriveAt(32000) - Math.log2(4)) < 1e-9, "two octaves at 32km");
assert.ok(
  Math.abs(speedAt(7999) - (30 + 60 * (1 - Math.exp(-7999 / SPEED.RAMP_DISTANCE)))) < 1e-9,
  "pre-overdrive speed curve must be untouched",
);
assert.ok(speedAt(16000) > speedAt(7999) + 5, "overdrive speed growth must engage by 16km");
assert.ok(speedAt(32000) > SPEED.MAX + 10, "overdrive speed keeps growing past MAX");
assert.ok(
  speedAt(40000) > speedAt(8000) + 15,
  "the treadmill must keep meaningfully accelerating deep into overdrive",
);
assert.ok(
  speedAt(64000) - speedAt(32000) < speedAt(32000) - speedAt(16000) + 1e-9,
  "late speed growth must decelerate (log), not explode",
);

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

// Deep-overdrive chained generation (60km): validation must stay healthy
// under tightened corridors, shrunken seams, and hotter mutators — and the
// seam shrink itself must be visible in the emitted chunk gaps.
console.log("\n== deep overdrive: 1 × 60km ==");
{
  const gen = new TrackGenerator(createRng("deep-overdrive"), false);
  let prevS1 = 0;
  let chunks = 0;
  let earlyGapSum = 0;
  let earlyGapN = 0;
  let lateGapSum = 0;
  let lateGapN = 0;
  while (gen.generatedUpTo < 60000) {
    const before = gen.generatedUpTo;
    gen.fill(60000, {
      chunk: (c) => {
        const gap = c.s0 - prevS1;
        if (prevS1 > 0) {
          if (c.s0 < 6000) {
            earlyGapSum += gap;
            earlyGapN++;
          } else if (c.s0 > 32000) {
            lateGapSum += gap;
            lateGapN++;
          }
          assert.ok(gap >= 10 - 1e-9, `seam collapsed below the 10m floor (${gap.toFixed(1)}m)`);
        }
        prevS1 = c.s1;
        chunks++;
      },
    });
    assert.ok(gen.generatedUpTo > before, `deep generator stalled at ${before.toFixed(0)}m`);
  }
  const earlyGap = earlyGapSum / earlyGapN;
  const lateGap = lateGapSum / lateGapN;
  const deepFallbackRate = gen.fallbacks / chunks;
  console.log(
    `chunks=${chunks}, fallbacks=${gen.fallbacks} (${(deepFallbackRate * 100).toFixed(1)}%), ` +
    `rejections=${gen.rejections}, seam early=${earlyGap.toFixed(1)}m late=${lateGap.toFixed(1)}m, ` +
    `overdrive@60km=${overdriveAt(60000).toFixed(2)}`,
  );
  assert.ok(
    deepFallbackRate < 0.04,
    `deep-overdrive fallback rate ${(deepFallbackRate * 100).toFixed(1)}% is too high`,
  );
  assert.ok(
    lateGap < earlyGap * 0.66,
    `overdrive must shrink runway seams (early ${earlyGap.toFixed(1)}m -> late ${lateGap.toFixed(1)}m)`,
  );
  assert.ok(lateGap >= 10, "late seams must respect the 10m floor");
}

// Worst-combo heat generation (roadmap 4.3): the full stack — dense field,
// fast movers, narrow gaps, scarce shields, tin hull — must keep the chain
// healthy: validation stays honest (every emitted chunk is still solver-
// proven), fallbacks stay rare, seams respect the floor, no stalls.
console.log("\n== full heat stack: 2 × 30km ==");
{
  const heat = resolveHeat(normalizeHeat(HEATS.map((h) => h.id)));
  let chunks = 0;
  let fallbacks = 0;
  let rejections = 0;
  for (let seedIndex = 0; seedIndex < 2; seedIndex++) {
    const gen = new TrackGenerator(createRng(`heat-mix-${seedIndex}`), false, null, heat);
    let prevS1 = 0;
    while (gen.generatedUpTo < 30000) {
      const before = gen.generatedUpTo;
      gen.fill(30000, {
        chunk: (c) => {
          chunks++;
          if (prevS1 > 0) {
            assert.ok(
              c.s0 - prevS1 >= 10 - 1e-9,
              `heat seam collapsed (${(c.s0 - prevS1).toFixed(1)}m)`,
            );
          }
          prevS1 = c.s1;
        },
      });
      assert.ok(gen.generatedUpTo > before, `heat generator stalled at ${before.toFixed(0)}m`);
    }
    fallbacks += gen.fallbacks;
    rejections += gen.rejections;
  }
  const rate = fallbacks / chunks;
  console.log(
    `chunks=${chunks}, fallbacks=${fallbacks} (${(rate * 100).toFixed(1)}%), rejections=${rejections}`,
  );
  assert.ok(rate < 0.05, `full-heat fallback rate ${(rate * 100).toFixed(1)}% is too high`);
  assert.ok(
    rejections / chunks < 1.2,
    "full-heat generator retries are under excessive pressure",
  );
}

// Trial-mode generation (roadmap 4.1): each roster trial loops its forced
// pattern for 8km on the trial's own escalation curves. The chain must stay
// healthy — no stalls, only the forced pattern (plus the rare validated
// breather fallback), and seams must tighten under the trial pressure ramp.
console.log("\n== trial-mode chained generation, 8km each ==");
for (const trial of TRIALS) {
  const gen = new TrackGenerator(createRng(trialSeed(trial.id)), false, trial);
  let chunks = 0;
  let fallbackChunks = 0;
  let prevS1 = 0;
  let earlyGapSum = 0;
  let earlyGapN = 0;
  let lateGapSum = 0;
  let lateGapN = 0;
  while (gen.generatedUpTo < 8000) {
    const before = gen.generatedUpTo;
    gen.fill(8000, {
      chunk: (c) => {
        chunks++;
        assert.ok(
          c.patternId === trial.id || c.patternId === "openField",
          `trial ${trial.id} emitted a foreign chunk: ${c.patternId}`,
        );
        if (c.patternId !== trial.id) fallbackChunks++;
        const gap = c.s0 - prevS1;
        if (prevS1 > 0) {
          assert.ok(gap >= 10 - 1e-9, `trial seam collapsed (${gap.toFixed(1)}m)`);
          if (c.s0 < 1200) {
            earlyGapSum += gap;
            earlyGapN++;
          } else if (c.s0 > 4500) {
            lateGapSum += gap;
            lateGapN++;
          }
        }
        prevS1 = c.s1;
      },
    });
    assert.ok(gen.generatedUpTo > before, `trial ${trial.id} generator stalled`);
  }
  const fallbackRate = fallbackChunks / chunks;
  const earlyGap = earlyGapSum / Math.max(1, earlyGapN);
  const lateGap = lateGapSum / Math.max(1, lateGapN);
  console.log(
    `${trial.id.padEnd(18)} chunks=${String(chunks).padStart(3)} ` +
    `fallbacks=${(fallbackRate * 100).toFixed(1)}% ` +
    `seam ${earlyGap.toFixed(1)}m -> ${lateGap.toFixed(1)}m`,
  );
  assert.ok(
    fallbackRate < 0.1,
    `trial ${trial.id} fallback rate ${(fallbackRate * 100).toFixed(1)}% is too high`,
  );
  assert.ok(
    lateGap < earlyGap,
    `trial pressure must shrink seams (${earlyGap.toFixed(1)}m -> ${lateGap.toFixed(1)}m)`,
  );
}

console.log("generator assertions: PASS");
