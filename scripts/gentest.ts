/**
 * Generator statistics: pattern mix, validation retry/fallback rates.
 * Run: npx tsx scripts/gentest.ts
 */
import { createRng } from "../src/game/core/rng";
import { TrackGenerator, difficultyAt, speedAt } from "../src/game/track/generator";
import { FIELD_PATTERNS, NORMAL_PATTERNS } from "../src/game/track/patterns";
import { SETPIECES } from "../src/game/track/setpieces";
import { mutatePattern } from "../src/game/track/mutators";
import { validatePattern, corridorLanes } from "../src/game/track/validator";
import type { BuildCtx } from "../src/game/core/types";

// Per-pattern validation rate with a consistent entry corridor.
console.log("== standalone validation rates, mutators on (100 tries each) ==");
for (const p of [...NORMAL_PATTERNS, ...FIELD_PATTERNS, ...SETPIECES]) {
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
    mutatePattern(rng, built, s0, p.category, entryX);
    const v = validatePattern(
      built.obstacles, s0, built.length,
      corridorLanes(entryX, entryHalf), 26,
    );
    if (v.ok) ok++;
  }
  console.log(`${p.id.padEnd(20)} ${ok}%`);
}

// Full-chain generation mix.
console.log("\n== chained generation mix over 30km ==");
const counts = new Map<string, number>();
let totalObstacles = 0;
const gen = new TrackGenerator(createRng("mix"), false);
gen.fill(30000, {
  chunk: (c) => {
    counts.set(c.patternId, (counts.get(c.patternId) ?? 0) + 1);
    totalObstacles += c.obstacles.length;
  },
});
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [id, n] of sorted) console.log(`${id.padEnd(20)} ${n}`);
console.log(
  `total obstacles: ${totalObstacles}, rejections=${gen.rejections}, fallbacks=${gen.fallbacks}, ` +
  `difficulty@30km=${difficultyAt(30000).toFixed(2)}`,
);
