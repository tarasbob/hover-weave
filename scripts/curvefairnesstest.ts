/** Curved routes must spend steering on the road as well as the obstacles. */
import assert from "node:assert/strict";
import { FIXED_DT, TRACK } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { createRng } from "../src/game/core/rng";
import type { ObstacleSpec } from "../src/game/core/types";
import { SimWorld } from "../src/game/core/world";
import { Course } from "../src/game/track/course";
import { TrackGenerator, type GeneratedChunk } from "../src/game/track/generator";
import { TRIALS, trialSeed } from "../src/game/track/trials";
import {
  CURVED_PATH_SLOPE,
  corridorLanes,
  validatePattern,
  xToLane,
} from "../src/game/track/validator";
import { steerToward } from "./pilots";

function gate(s: number, x: number): ObstacleSpec[] {
  return [-1, 1].map((side) => ({
    kind: "box", s, x: x + side * 18, y: 1, hx: 16, hy: 3, hs: 1,
  }));
}

// The same local dodge that is possible on a straight cannot be promised
// while a bend is already consuming half of the craft's steering authority.
const gates = [...gate(4, 0), ...gate(40, 10)];
assert.ok(validatePattern(gates, 0, 44, corridorLanes(0, 0), 0, false, 0.9).ok);
assert.equal(
  validatePattern(gates, 0, 44, corridorLanes(0, 0), 0, false, 0.9, 0, (s) => s * 0.25).ok,
  false,
  "a route requiring a hard dodge and a hard turn together must be rejected",
);

// Obstacles are rigid in world space. Their near/far ends occupy different
// local lanes on a bend, which a center-only offset would fail to account for.
const longBox: ObstacleSpec = { kind: "box", s: 20, x: 0, y: 1, hx: 2, hy: 3, hs: 12 };
const aroundBox = validatePattern(
  [longBox], 0, 40, corridorLanes(-20, 0), 0, true, 0, 0, (s) => s * 0.3,
);
assert.ok(aroundBox.ok);
const near = aroundBox.slices!.find((slice) => slice.s === 8)!;
const far = aroundBox.slices!.find((slice) => slice.s === 32)!;
assert.equal(near.blocked[xToLane(6)], 1, "the box's near end reaches into positive local lanes");
assert.equal(near.blocked[xToLane(-3)], 0);
assert.equal(far.blocked[xToLane(-6)], 1, "the box's far end reaches into negative local lanes");
assert.equal(far.blocked[xToLane(3)], 0);

function chunksThrough(generator: TrackGenerator, target: number): GeneratedChunk[] {
  const chunks: GeneratedChunk[] = [];
  while (generator.generatedUpTo < target) generator.fill(target, { chunk: (chunk) => chunks.push(chunk) });
  return chunks;
}

// Even a supplied course callback must not alter authored trial geometry,
// solved paths, rewards, retry draws, or the downstream random stream.
for (const trial of TRIALS.slice(0, 3)) {
  const seed = trialSeed(trial.id);
  const original = new TrackGenerator(createRng(seed), true, trial);
  const withCourse = new TrackGenerator(createRng(seed), true, trial, undefined, (s) => s * 2);
  assert.deepEqual(chunksThrough(withCourse, 8000), chunksThrough(original, 8000));
}

let chunks = 0;
let fallbacks = 0;
let retries = 0;
let peakSlope = 0;
let demandingSegments = 0;
for (let seedIndex = 0; seedIndex < 12; seedIndex++) {
  const seed = `curve-proof-${seedIndex}`;
  const course = new Course(seed);
  const generator = new TrackGenerator(createRng(seed), false, null, undefined, (s) => course.offsetAt(s));
  for (const chunk of chunksThrough(generator, 40000)) {
    chunks++;
    assert.ok(chunk.path.length > 1, "every emitted chunk must retain a solved route");
    for (let i = 0; i < chunk.path.length; i++) {
      const [s, x] = chunk.path[i];
      assert.ok(Math.abs(x) < TRACK.X_LIMIT, "the safe route cannot occupy a lethal edge");
      if (i === 0) continue;
      const [prevS, prevX] = chunk.path[i - 1];
      const bendSlope = Math.abs(course.offsetAt(s) - course.offsetAt(prevS)) / (s - prevS);
      const localSlope = Math.abs(x - prevX) / (s - prevS);
      const slope = bendSlope + localSlope;
      peakSlope = Math.max(peakSlope, slope);
      if (bendSlope > 0.2 && localSlope > 0) demandingSegments++;
      assert.ok(slope <= CURVED_PATH_SLOPE + 1e-9,
        `${seed}/${chunk.patternId}: bend and dodge together exceed steering at ${s}`);
    }
  }
  fallbacks += generator.fallbacks;
  retries += generator.rejections;
}
assert.ok(demandingSegments > 20, "the survey must exercise dodges inside substantial turns");
assert.ok(fallbacks / chunks < 0.03, `curves replaced too many patterns with breathers (${fallbacks}/${chunks})`);
assert.ok(retries / chunks < 0.5, "curved generation must retain healthy pattern variety");

/** Interpolate the generated safe line in world space, using no teleports. */
function routeX(world: SimWorld, s: number): number {
  const chunk = world.debugChunks.find((candidate) => candidate.path.at(-1)![0] >= s)
    ?? world.debugChunks.at(-1)!;
  let previous = chunk.path[0];
  for (let i = 1; i < chunk.path.length; i++) {
    const point = chunk.path[i];
    if (point[0] >= s) {
      const t = Math.max(0, (s - previous[0]) / (point[0] - previous[0]));
      return previous[1] + (point[1] - previous[1]) * t + world.courseOffsetAt(s);
    }
    previous = point;
  }
  return previous[1] + world.courseOffsetAt(s);
}

// A real-world controller smoke test complements the discrete route proof.
// This simple follower can still miss abrupt dodges or independent chunk
// joins, so it is a survival floor, not a claim that every path is effortless.
let totalDistance = 0;
let longRuns = 0;
for (let seedIndex = 0; seedIndex < 12; seedIndex++) {
  const world = new SimWorld();
  world.collectDebug = true;
  world.start({ mode: "endless", seed: `curve-proof-${seedIndex}` });
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  for (let tick = 0; tick < 400 / FIXED_DT && world.status === "running" && world.distance < 12000; tick++) {
    steerToward(world, input, routeX(world, world.distance + Math.max(4, world.speed * 0.18)));
    world.update(FIXED_DT, input);
  }
  assert.ok(world.distance > 800, `seed ${seedIndex}: a guided ship must survive the first complete turn`);
  assert.notEqual(world.stats.deathCause?.cause, "edge", "a route follower must retain control through turns");
  totalDistance += world.distance;
  if (world.distance > 4000) longRuns++;
}
assert.ok(totalDistance / 12 > 2500, "curves must allow sustained obstacle runs under real steering dynamics");
assert.ok(longRuns >= 2, "the controller must negotiate multiple alternating bends with obstacles");
console.log(
  `Curved fairness: ${chunks} chunks, ${(100 * fallbacks / chunks).toFixed(1)}% breathers, ` +
  `combined slope ≤ ${peakSlope.toFixed(3)}; 12 real-world route runs average ${(totalDistance / 12).toFixed(0)} m.`,
);
