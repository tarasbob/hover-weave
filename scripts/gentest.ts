/**
 * Generator assertions: pattern validity, pacing bands, variety, and fallback
 * pressure across deterministic seeds.
 */
import assert from "node:assert/strict";
import {
  COURSE,
  CRAFT,
  overdriveAt,
  RAMP,
  rampMaxFlight,
  rampTubeHalf,
  RESONANCE,
  SPEED,
} from "../src/game/core/constants";
import { HEATS, normalizeHeat, resolveHeat } from "../src/game/core/heat";
import { createRng } from "../src/game/core/rng";
import { Motion } from "../src/game/core/types";
import { Course } from "../src/game/track/course";
import {
  TrackGenerator,
  difficultyAt,
  patternIntensity,
  speedAt,
  type GeneratedChunk,
} from "../src/game/track/generator";
import {
  BREATHER,
  CIRCUIT_PATTERNS,
  FIELD_PATTERNS,
  NORMAL_PATTERNS,
} from "../src/game/track/patterns";
import { SETPIECES } from "../src/game/track/setpieces";
import { SKY_NORMAL, SKY_PATTERNS } from "../src/game/track/skyhooks";
import { mutatePattern, resonatePattern } from "../src/game/track/mutators";
import { TRIALS, trialSeed } from "../src/game/track/trials";
import { validatePattern, corridorLanes } from "../src/game/track/validator";
import type { BuildCtx, PatternResult } from "../src/game/core/types";

const patterns = [
  ...NORMAL_PATTERNS,
  ...SKY_NORMAL,
  ...FIELD_PATTERNS,
  ...CIRCUIT_PATTERNS,
  ...SETPIECES,
  BREATHER,
];

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

// --- Skyhook envelopes (fun-frontier 6.1) -----------------------------------
// Every wedge a sky pattern authors must be followed by a guaranteed-clear
// landing tube: no collidable ground-band geometry inside the worst-case
// (full-boost, floaty) flight window, the pattern must own the whole window,
// air furniture must live strictly above the grounded craft band, and the
// mutator pipeline must never jitter or scatter these layouts (mirroring is
// exercised and must keep every guarantee).
console.log("\n== skyhook envelopes: landing tubes stay clear ==");
{
  let decks = 0;
  let airRings = 0;
  for (const p of SKY_PATTERNS) {
    const rng = createRng(`sky-envelope-${p.id}`);
    for (let i = 0; i < 120; i++) {
      const difficulty = rng.range(p.minDifficulty, Math.min(1, p.maxDifficulty));
      // Sweep placement depth: mid-game through deep overdrive speeds.
      const s0 = rng.chance(0.5) ? rng.range(1600, 9000) : rng.range(9000, 60000);
      const speed = speedAt(s0);
      const ctx: BuildCtx = {
        rng, s0, difficulty,
        entryX: rng.range(-8, 8),
        entryHalf: rng.range(4, Math.min(14, p.maxEntryHalf ?? 14)),
        speed,
        biome: 0,
      };
      const built = p.build(ctx);
      const log = mutatePattern(rng, built, s0, p.category, ctx.entryX, difficulty, overdriveAt(s0));
      assert.ok(!log.jittered, `${p.id} must be protected from jitter`);
      assert.equal(log.scatterAdded, 0, `${p.id} must be protected from scatter`);
      resonatePattern(built, RESONANCE.BPM, 0);

      const ramps = built.obstacles.filter((o) => o.kind === "ramp");
      assert.ok(ramps.length > 0, `${p.id} authored no wedge`);
      for (const deck of ramps) {
        decks++;
        // The novice contract: a capped launch falling this wedge's full
        // lip height must still land under the clean ceiling.
        const worstUndivedImpact = Math.sqrt(
          RAMP.VY_MAX * RAMP.VY_MAX + 2 * RAMP.GRAVITY * deck.hy,
        );
        assert.ok(
          worstUndivedImpact < RAMP.SOFT_VY,
          `${p.id}: lip ${deck.hy.toFixed(1)}m makes an un-dived arc land hard ` +
          `(${worstUndivedImpact.toFixed(1)} ≥ ${RAMP.SOFT_VY})`,
        );
        const lip = deck.s + deck.hs;
        const flight = rampMaxFlight(deck.hy, deck.hs * 2, speed);
        const tube = rampTubeHalf(deck.hx, flight);
        assert.ok(
          lip + flight + 10 <= s0 + built.length + 1e-6,
          `${p.id}: flight window (${(lip + flight).toFixed(0)}m) escapes the pattern ` +
          `(ends ${(s0 + built.length).toFixed(0)}m) at speed ${speed.toFixed(0)}`,
        );
        for (const o of built.obstacles) {
          if (o === deck || o.kind === "ramp" || o.collidable === false) continue;
          // Only ground-band geometry can hurt a landing craft (collision
          // bands use hy for every kind, ring tubes included); skyhook air
          // furniture is checked separately below.
          if (o.y - o.hy > CRAFT.Y_MAX) continue;
          if (o.s + o.hs < lip || o.s - o.hs > lip + flight) continue;
          const oHalf = Math.abs(Math.cos(o.yaw ?? 0)) * o.hx + Math.abs(Math.sin(o.yaw ?? 0)) * o.hs;
          const gap = Math.abs(o.x - deck.x) - oHalf - tube;
          assert.ok(
            gap > 0,
            `${p.id}: ${o.kind} at (${o.x.toFixed(1)}, ${o.s.toFixed(0)}) intrudes ` +
            `${(-gap).toFixed(1)}m into the landing tube (±${tube.toFixed(1)}m, ` +
            `flight ${flight.toFixed(0)}m at speed ${speed.toFixed(0)})`,
          );
        }
      }
      for (const o of built.obstacles) {
        if (o.kind !== "ring" || !o.noValidate) continue;
        airRings++;
        assert.ok(
          o.y - o.hy > CRAFT.Y_MAX + 1.4,
          `${p.id}: air ring at y=${o.y.toFixed(1)} can reach the grounded craft band`,
        );
      }
    }
  }
  console.log(`skyhook envelope gate: PASS (${decks} decks, ${airRings} air rings audited)`);
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
for (const id of [
  "precisionLadder", "pulseWeave", "rotorRhythm", "splitDecision", "apexGauntlet",
  "canyonRun", "glassRush", "pinballAlley", "photonGate", "leviathan",
]) {
  assert.ok((counts.get(id) ?? 0) > 0, `${id} never appeared across fixed generation seeds`);
}

// --- Winding course: the corridor drift must live inside the steering
// headroom above the validator's plan (see COURSE constants) -----------------
console.log("\n== winding course: slope + amplitude budget ==");
{
  let worstEarly = 0;
  let worstLate = 0;
  let worstAbs = 0;
  const PROBE_DS = 2;
  for (let i = 0; i < 6; i++) {
    const course = new Course(`course-${i}`);
    assert.ok(Math.abs(course.offsetAt(0)) < 1e-9, "course must launch centered");
    let prev = course.offsetAt(0);
    for (let s = PROBE_DS; s <= 40000; s += PROBE_DS) {
      const v = course.offsetAt(s);
      const slope = Math.abs(v - prev) / PROBE_DS;
      prev = v;
      worstAbs = Math.max(worstAbs, Math.abs(v));
      if (s < 2600) worstEarly = Math.max(worstEarly, slope);
      else worstLate = Math.max(worstLate, slope);
    }
  }
  const flat = new Course(null);
  assert.equal(flat.offsetAt(1234), 0, "trial courses must be dead straight");
  console.log(
    `offset ≤ ${worstAbs.toFixed(1)}m, slope early ≤ ${worstEarly.toFixed(3)}, ` +
    `late ≤ ${worstLate.toFixed(3)}`,
  );
  assert.ok(worstAbs <= COURSE.MAX_OFFSET, `course amplitude exceeds budget (${worstAbs.toFixed(1)}m)`);
  // Early: validator plans 0.25 vs ~0.5 physical — 0.09 of drift is safe.
  assert.ok(worstEarly < 0.09, `early course slope too steep (${worstEarly.toFixed(3)})`);
  // Late: validator plans 0.375 — drift must taper well under the headroom.
  assert.ok(worstLate < 0.045, `late course slope too steep (${worstLate.toFixed(3)})`);
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

// Rhythm resonance (fun-frontier 2.1, mainline): every mover the generator
// emits must ride the beat grid — periods = beat × 2^k, phases on quarter
// cycles. (Geometry safety is by construction: `resonatePattern` re-times
// only, and validation runs after it, so every accepted chunk was proven
// with its final timing.)
console.log("\n== rhythm resonance: mainline beat grid, 2 × 10km ==");
{
  const beat = 60 / RESONANCE.BPM;
  const onGrid = (beats: number) =>
    Math.abs(Math.log2(beats) - Math.round(Math.log2(beats))) < 1e-9;
  const angularOnGrid = (w: number) => w === 0 || onGrid((2 * Math.PI) / (Math.abs(w) * beat));
  const cyclesOnGrid = (w: number) => w === 0 || onGrid(1 / (Math.abs(w) * beat));
  const quarterOf = (v: number, cycle: number) =>
    Math.abs(v / (cycle / 4) - Math.round(v / (cycle / 4))) < 1e-9;
  let movers = 0;
  let chunksTotal = 0;
  for (let seedIndex = 0; seedIndex < 2; seedIndex++) {
    const gen = new TrackGenerator(createRng(`resonance-${seedIndex}`), false);
    const chunks: GeneratedChunk[] = [];
    while (gen.generatedUpTo < 10000) {
      const before = gen.generatedUpTo;
      gen.fill(10000, { chunk: (c) => chunks.push(c) });
      assert.ok(gen.generatedUpTo > before, "resonance generator stalled");
    }
    chunksTotal += chunks.length;
    for (const c of chunks) {
      for (const o of c.obstacles) {
        switch (o.motion) {
          case Motion.SweepX:
            movers++;
            assert.ok(angularOnGrid(o.m0 ?? 0), `sweep rate off grid (${o.m0})`);
            assert.ok(quarterOf(o.m1 ?? 0, 2 * Math.PI), `sweep phase off grid (${o.m1})`);
            break;
          case Motion.Piston:
            movers++;
            assert.ok(cyclesOnGrid(o.m0 ?? 0), `piston rate off grid (${o.m0})`);
            assert.ok(quarterOf(o.m1 ?? 0, 1), `piston phase off grid (${o.m1})`);
            break;
          case Motion.Blink:
            movers++;
            assert.ok(cyclesOnGrid(o.m0 ?? 0), `beam rate off grid (${o.m0})`);
            assert.ok(quarterOf(o.m1 ?? 0, 1), `beam phase off grid (${o.m1})`);
            break;
          case Motion.RotateYaw:
            movers++;
            assert.ok(angularOnGrid(o.m0 ?? 0), `rotor rate off grid (${o.m0})`);
            break;
          case Motion.OrbitXZ:
            movers++;
            assert.ok(angularOnGrid(o.m1 ?? 0), `orbit rate off grid (${o.m1})`);
            assert.ok(quarterOf(o.m2 ?? 0, 2 * Math.PI), `orbit phase off grid (${o.m2})`);
            break;
          case Motion.Pendulum:
            movers++;
            assert.ok(angularOnGrid(o.m2 ?? 0), `pendulum rate off grid (${o.m2})`);
            break;
        }
      }
    }
  }
  assert.ok(movers > 40, `resonance survey needs movers to prove anything (${movers})`);
  console.log(`chunks=${chunksTotal}, movers=${movers} — every rate on the beat grid`);
}

// Deep perception ceiling: the same snapped movers receive deterministic
// rational 3:2 / 5:4 multipliers without changing geometry.
{
  const make = (): PatternResult => ({
    length: 80,
    exitX: 0,
    exitHalf: 10,
    pickups: [],
    obstacles: [
      { kind: "box", x: -8, s: 20, y: 2, hx: 1, hy: 2, hs: 1, motion: Motion.SweepX, m0: 2, m1: 0, m2: 4 },
      { kind: "box", x: -2, s: 35, y: 2, hx: 1, hy: 2, hs: 1, motion: Motion.Piston, m0: 0.5, m1: 0, m2: 4 },
      { kind: "box", x: 4, s: 50, y: 2, hx: 1, hy: 2, hs: 1, motion: Motion.RotateYaw, m0: 2 },
      { kind: "sphere", x: 9, s: 65, y: 5, hx: 1, hy: 1, hs: 1, motion: Motion.Pendulum, m0: 4, m1: 0.5, m2: 2 },
    ],
  });
  const base = make();
  const deep = make();
  resonatePattern(base, RESONANCE.BPM, 0);
  resonatePattern(deep, RESONANCE.BPM, 1);
  const rates = (result: PatternResult) => [
    result.obstacles[0].m0!,
    result.obstacles[1].m0!,
    result.obstacles[2].m0!,
    result.obstacles[3].m2!,
  ];
  const ratios = rates(deep).map((rate, i) => Math.abs(rate / rates(base)[i]));
  assert.deepEqual(ratios, [1.5, 1.25, 1.5, 1.25]);
  assert.deepEqual(
    deep.obstacles.map((o) => [o.x, o.s, o.hx, o.hy, o.hs]),
    base.obstacles.map((o) => [o.x, o.s, o.hx, o.hy, o.hs]),
    "polyrhythm must not alter geometry",
  );
  console.log("deep polyrhythm gate: PASS (3:2 / 5:4, geometry unchanged)");
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
          // Use the first two seams rather than an absolute distance: compound
          // circuits can make one authored phrase longer than 1.2 km.
          if (earlyGapN < 2) {
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
