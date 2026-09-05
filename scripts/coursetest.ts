/** Course readability, steering headroom and lethal edge contracts. */
import assert from "node:assert/strict";
import { COURSE, CRASH, FIXED_DT, TRACK } from "../src/game/core/constants";
import type { GameEvents } from "../src/game/core/events";
import type { InputState } from "../src/game/core/input";
import { resimulate } from "../src/game/core/replay";
import { createRng } from "../src/game/core/rng";
import type { ObstacleSpec } from "../src/game/core/types";
import { SimWorld } from "../src/game/core/world";
import { Course } from "../src/game/track/course";
import { difficultyAt, TrackGenerator } from "../src/game/track/generator";
import { steerToward } from "./pilots";

const input = (): InputState => ({ axis: 0, boost: false, dash: false, restart: false, pause: false });
function emptyWorld(seed: string, carve = false): SimWorld {
  const world = new SimWorld();
  world.start({ seed, mode: "endless", ...(carve ? { lab: ["carve" as const] } : {}) });
  (world as unknown as { generator: null }).generator = null;
  for (const obstacle of world.obstacles) obstacle.active = false;
  for (const pickup of world.pickups) pickup.active = false;
  return world;
}

for (let seed = 0; seed < 16; seed++) {
  const course = new Course(`curve-readability-${seed}`);
  const repeated = new Course(`curve-readability-${seed}`);
  assert.equal(course.offsetAt(0), 0);
  assert.equal(course.offsetAt(-10), 0);
  assert.ok(Math.abs(course.offsetAt(300)) > 5, "a bend must be visible in the opening");
  assert.ok(Math.abs(course.offsetAt(COURSE.RAMP_IN)) >= COURSE.MIN_OFFSET);
  assert.ok(course.offsetAt(COURSE.RAMP_IN) * course.offsetAt(COURSE.RAMP_IN + COURSE.BEND_LENGTH) < 0,
    "successive broad bends must turn in opposite directions");
  let previous = 0;
  for (let s = 1; s <= 40000; s++) {
    const offset = course.offsetAt(s);
    assert.equal(offset, repeated.offsetAt(s), "seeded bends must be deterministic");
    assert.ok(Math.abs(offset) <= COURSE.MAX_OFFSET);
    const slope = Math.abs(offset - previous);
    assert.ok(slope < 0.15, "bends must reserve steering authority for obstacles");
    if (difficultyAt(s) >= COURSE.TAPER_D1) assert.ok(slope < 0.045, "late bends must ease for dense fields");
    previous = offset;
  }
  // Arbitrary access order must produce the same centerline for ghosts and streaming.
  for (const s of [9000, 340, 76000, 1, 1240]) assert.equal(course.offsetAt(s), repeated.offsetAt(s));
  for (const s of [0, COURSE.RAMP_IN, COURSE.RAMP_IN + COURSE.BEND_LENGTH]) {
    const leftSlope = (course.offsetAt(s) - course.offsetAt(s - 0.001)) / 0.001;
    const rightSlope = (course.offsetAt(s + 0.001) - course.offsetAt(s)) / 0.001;
    assert.ok(Math.abs(rightSlope - leftSlope) < 0.00001, "apex tangent must stay continuous");
  }
  const generator = new TrackGenerator(createRng(`curve-readability-${seed}`));
  generator.fill(40000, {
    chunk(chunk) {
      for (const [, x] of chunk.path) {
        assert.ok(Math.abs(x) < TRACK.X_LIMIT, "a validated route must never use a lethal edge");
      }
    },
  });
  const world = emptyWorld(`curve-readability-${seed}`);
  const controls = input();
  let peakAxis = 0;
  for (let tick = 0; tick < 45 / FIXED_DT; tick++) {
    steerToward(world, controls, world.courseOffsetAt(world.distance + 6));
    peakAxis = Math.max(peakAxis, Math.abs(controls.axis));
    world.update(FIXED_DT, controls);
    assert.equal(world.status, "running", "a smooth centerline must be physically steerable");
    assert.ok(Math.abs(world.x - world.courseOffsetAt(world.distance)) < 3);
  }
  assert.ok(peakAxis < 0.65, "following bends alone must leave ample steering authority");
}
assert.equal(new Course(null).offsetAt(12345), 0, "fixed trial courses stay straight");

for (const edge of [-1, 1] as const) {
  for (const mode of ["plain", "shield", "airborne", "carve"] as const) {
    const world = emptyWorld(`edge-${edge}-${mode}`, mode === "carve");
    const controls = input();
    for (let tick = 0; tick < 240; tick++) world.update(FIXED_DT, controls);
    world.x = world.courseOffsetAt(world.distance) + edge * (TRACK.X_LIMIT - 0.02);
    world.latVel = edge * 14;
    if (mode === "shield") { world.hasShield = true; world.iframes = 10; }
    if (mode === "airborne") { world.airborne = true; world.y = 8; world.vy = 2; }
    if (mode === "carve") controls.axis = -edge;
    const crashes: GameEvents["death"][] = [];
    world.events.on("death", (event) => crashes.push(event));
    world.update(FIXED_DT, controls);
    assert.equal(world.status, "dead", `${mode}: either edge must be lethal`);
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0].cause, "edge");
    assert.equal(crashes[0].edge, edge);
    assert.equal(world.stats.deathCause?.edge, edge);
    assert.ok((world.x - world.courseOffsetAt(world.distance)) * edge >= TRACK.X_LIMIT,
      "the ship must keep its position beyond the edge instead of clamping");
    assert.ok(world.deathLatVel * edge > 0, "the wreck must retain its outward momentum");
    assert.equal(world.deathY, crashes[0].y);
    assert.equal(world.deathVy, crashes[0].vy);
    assert.equal(world.stats.pumps, 0, "track edges must never bounce a carve back into play");
    const final = JSON.stringify(world.stats);
    for (let tick = 0; tick < (CRASH.PRESENTATION_SECONDS + 0.2) / FIXED_DT; tick++) world.update(FIXED_DT, controls);
    assert.ok(world.deathTimer >= CRASH.PRESENTATION_SECONDS, "presentation clock must outlive sim freeze");
    assert.equal(JSON.stringify(world.stats), final, "crash animation must not change the result");
    assert.equal(crashes.length, 1, "a crash emits exactly once");
  }
  // A bumper may physically eject the craft even without outward steering.
  const bounced = emptyWorld(`bumper-edge-${edge}`);
  const bounceInput = input();
  for (let tick = 0; tick < 240; tick++) bounced.update(FIXED_DT, bounceInput);
  bounced.x = bounced.courseOffsetAt(bounced.distance) + edge * (TRACK.X_LIMIT - 0.2);
  (bounced as unknown as { spawnObstacle(spec: ObstacleSpec, patternId: string): void }).spawnObstacle({
    kind: "bumper", s: bounced.distance + 0.2, x: edge * (TRACK.X_LIMIT - 2.1),
    y: 1, hx: 2, hy: 2, hs: 2,
  }, "edge-ejection");
  bounced.update(FIXED_DT, bounceInput);
  assert.equal(bounced.stats.bounces, 1);
  assert.equal(bounced.stats.deathCause?.cause, "edge", "a bumper ejection must crash in the same tick");
  assert.equal(bounced.stats.deathCause?.edge, edge);

  // A real input recording must reproduce an edge crash, without test teleports.
  const live = new SimWorld();
  live.start({ mode: "endless", seed: `recorded-edge-${edge}` });
  const controls = input();
  controls.axis = edge;
  for (let tick = 0; tick < 1200 && live.status === "running"; tick++) live.update(FIXED_DT, controls);
  assert.equal(live.stats.deathCause?.cause, "edge");
  const replayed = resimulate(live.getRecording()!, new SimWorld());
  assert.deepEqual(replayed.stats, live.stats);
  assert.equal(replayed.deathLatVel, live.deathLatVel);
}
console.log("Course and edge gates: readable deterministic bends, manageable steering, lethal edges, crash freeze and exact replays passed.");
