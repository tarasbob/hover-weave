/** Offline only: bake a surviving real-input route; no pilot executes in the browser. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { resimulate } from "../src/game/core/replay";
import { SimWorld } from "../src/game/core/world";
import { autopilot, lookaheadPilot } from "./pilots";

const seconds = 140;
let baked = false;
for (let candidate = 0; candidate < 40 && !baked; candidate++) {
  const seed = `render-route-v1-${candidate}`;
  const world = new SimWorld();
  world.start({ seed, mode: "endless" });
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const memory = { targetX: 0 };
  let maxObstacles = 0;
  const biomes = new Set<number>();
  const patterns = new Set<string>();
  const sections: { seconds: number; distance: number; biome: number; activeObstacles: number }[] = [];
  for (let step = 0; step < seconds / FIXED_DT && world.status === "running"; step++) {
    if (candidate < 20) autopilot(world, input);
    else lookaheadPilot(world, input, memory);
    world.update(FIXED_DT, input);
    biomes.add(world.biomeIndex);
    if (step % 120 === 0) {
      const active = world.obstacles.filter((o) => o.active);
      maxObstacles = Math.max(maxObstacles, active.length);
      for (const obstacle of active) patterns.add(obstacle.patternId);
      sections.push({ seconds: world.time, distance: world.distance, biome: world.biomeIndex, activeObstacles: active.length });
    }
  }
  console.log(`${seed}: ${world.time.toFixed(1)}s ${world.distance.toFixed(0)}m ${world.status}`);
  if (world.status !== "running" || biomes.size < 2) continue;
  const recording = world.getRecording()!;
  recording.at = 0;
  const replayed = resimulate(recording, new SimWorld());
  assert.deepEqual(replayed.stats, world.stats);
  const fixture = {
    id: "dense-biomes-v1", label: "Dense sections and biome transitions",
    generatedBy: candidate < 20 ? "offline greedy pilot" : "offline lookahead pilot",
    seconds, maxObstacles, biomes: [...biomes], patterns: [...patterns].sort(), sections, recording,
  };
  writeFileSync(new URL("../src/game/profiling/route.json", import.meta.url), JSON.stringify(fixture) + "\n");
  baked = true;
}
assert.ok(baked, "No real surviving route found; do not remove hazards or falsify duration to satisfy the benchmark");
