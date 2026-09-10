/** Deterministic work-budget regressions; optional timings are diagnostic only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CRAFT, FIXED_DT, MAX_STEPS_PER_FRAME } from "../src/game/core/constants";
import { Emitter } from "../src/game/core/events";
import { GhostDriver } from "../src/game/core/ghost";
import { parseFlight, resimulate } from "../src/game/core/replay";
import { createRng } from "../src/game/core/rng";
import { EntityPools } from "../src/game/core/simulation/entityPools";
import { ObstacleSystem } from "../src/game/core/simulation/obstacleSystem";
import { RunAnalysis } from "../src/game/core/simulation/runAnalysis";
import { emptyStats } from "../src/game/core/simulation/runStats";
import { Motion, type ObstacleSpec, type RunStatus } from "../src/game/core/types";
import { SimWorld } from "../src/game/core/world";
import { Course } from "../src/game/track/course";
import { TrackGenerator } from "../src/game/track/generator";
import { corridorLanes, validatePattern } from "../src/game/track/validator";

// Distant geometry must not pay for collision/despawn yaw math. A long box
// whose center is ahead must still hit, and an orbit may not despawn merely
// because its current center fell behind the recycling line.
{
  const pools = new EntityPools();
  const state = {
    time: 0, distance: 0, speed: 90, x: 0, y: CRAFT.HOVER_HEIGHT,
    airborne: false, boostCharge: 0, iframes: 0, status: "running" as RunStatus,
    obstacles: pools.obstacles, events: new Emitter(), dangerFactor: 1,
    flowPoints: 0, boosting: false, deathX: 0, deathSpeed: 0,
    course: new Course(null), stats: emptyStats(),
  };
  let hits = 0;
  const system = new ObstacleSystem(state, pools, new RunAnalysis(state, () => 90), {
    onHit: () => { hits++; }, onShatter() {}, onBounce() {}, onPassConfirmed() {},
  });
  for (let i = 0; i < 512; i++) {
    pools.spawnObstacle({ kind: "box", s: 1000 + i, x: 0, y: 1, hx: 2, hy: 2, hs: 2, yaw: 0.34 }, "distant", state);
  }
  const sin = Math.sin, cos = Math.cos;
  let trigCalls = 0;
  try {
    Math.sin = (x) => { trigCalls++; return sin(x); };
    Math.cos = (x) => { trigCalls++; return cos(x); };
    system.update(FIXED_DT, true);
  } finally {
    Math.sin = sin;
    Math.cos = cos;
  }
  assert.equal(trigCalls, 0, "far static geometry should require no trigonometric collision work");
  assert.equal(hits, 0);
  assert.equal(state.dangerFactor, 1);
  pools.spawnObstacle({ kind: "box", s: 10, x: 0, y: 1, hx: 20, hy: 2, hs: 1, yaw: Math.PI / 2 }, "long", state);
  pools.spawnObstacle({ kind: "box", s: -80, x: 0, y: 1, hx: 2, hy: 2, hs: 2, motion: Motion.OrbitXZ, m0: 100 }, "orbit", state);
  pools.spawnObstacle({ kind: "box", s: -100, x: 0, y: 1, hx: 2, hy: 2, hs: 2 }, "expired", state);
  system.update(FIXED_DT, true);
  assert.equal(hits, 1, "broad rejection must preserve long rotated-box contacts");
  assert.equal(pools.obstacles[513].active, true, "an orbit's future forward extent keeps its slot alive");
  assert.equal(pools.obstacles[514].active, false, "fully passed static geometry still recycles");
}

// Curve work should scale with obstacles + slices, not their product. Long
// overlapping footprints exercise the loop where repeated samples accumulated.
{
  const course = new Course("core-perf");
  const obstacles: ObstacleSpec[] = Array.from({ length: 120 }, (_, i) => ({
    kind: "box", s: 560 + i % 7, x: 28, y: 1, hx: 1, hy: 2, hs: 70,
  }));
  let calls = 0;
  const result = validatePattern(obstacles, 500, 200, corridorLanes(0, 4), 28, true, 0.7, 0,
    (s) => { calls++; return course.offsetAt(s); });
  assert.ok(result.slices?.length);
  assert.ok(calls <= 120 + 4 * 51 + 2 * 7, `curve sampling repeated inside footprints: ${calls} calls`);
}

function generatedFingerprint(): string {
  const course = new Course("core-perf");
  const generator = new TrackGenerator(createRng("core-perf"), false, null, undefined, (s) => course.offsetAt(s));
  const hash = createHash("sha256");
  generator.fill(15_000, { chunk: (chunk) => { hash.update(JSON.stringify(chunk)); } });
  return hash.digest("hex");
}
// Captured before the optimization: includes exact geometry, validator path,
// pickups, pattern choices, and RNG-dependent retry/fallback bookkeeping.
assert.equal(generatedFingerprint(), "e2c0308d7a649d5fc8cf2e55d70d515f165187adeb1a6ec58392a2580aab0179");

const recording = parseFlight(readFileSync(new URL("../src/game/competition/fixtures/sprint-v9.flight", import.meta.url), "utf8"));
{
  const ghost = new GhostDriver();
  ghost.arm(recording);
  const target = FIXED_DT * MAX_STEPS_PER_FRAME * 4;
  assert.equal(ghost.isReady(target), false);
  assert.equal(ghost.poseAt(target), null);
  assert.equal(ghost.deltaTo(10, target), null);
  ghost.sync(target);
  assert.ok(ghost.world!.time <= FIXED_DT * MAX_STEPS_PER_FRAME * 2 + 1e-9,
    "re-enabling a ghost must retain the fixed catchup budget");
  assert.equal(ghost.isReady(target), false);
  ghost.sync(target);
  assert.equal(ghost.isReady(target), true);
  assert.ok(ghost.poseAt(target));
  assert.equal(ghost.deltaTo(10, target), 10 - ghost.world!.distance);
  while (!ghost.finished) ghost.sync(recording.steps * FIXED_DT);
  assert.equal(ghost.isReady(recording.steps * FIXED_DT + 30), true,
    "completed ghosts remain valid distance markers after their recording ends");
  assert.ok(ghost.poseAt(recording.steps * FIXED_DT + 30));
  ghost.arm(null);
  assert.equal(ghost.isReady(0), false);
  assert.equal(ghost.poseAt(0), null);
}
console.log("Core performance: conservative contacts, linear curve sampling, exact course fingerprint, bounded ghost catchup passed.");

if (process.argv.includes("--benchmark")) {
  const median = (times: number[]) => times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const world = new SimWorld();
  for (let i = 0; i < 4; i++) resimulate(recording, world);
  const simulation = [], generation = [];
  for (let i = 0; i < 15; i++) {
    const started = performance.now();
    resimulate(recording, world);
    simulation.push(performance.now() - started);
  }
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    generatedFingerprint();
    generation.push(performance.now() - started);
  }
  console.log(JSON.stringify({
    replaySteps: recording.steps,
    replayMedianMs: median(simulation),
    generationWithFingerprintMedianMs: median(generation.slice(2)),
  }, null, 2));
}
