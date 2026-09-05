import assert from "node:assert/strict";
import { FIXED_DT } from "../../src/game/core/constants";
import { resimulate, type RunRecording } from "../../src/game/core/replay";
import { SimWorld } from "../../src/game/core/world";
import { ProfileDistribution, PROFILE_LIMITS } from "../../src/game/profiling/metrics";
import { PROFILE_ROUTE, ProfileRouteDriver } from "../../src/game/profiling/route";

const distribution = new ProfileDistribution();
for (let i = 0; i < 100_000; i++) distribution.add(i < 99_000 ? 10 : 50);
distribution.add(Number.NaN);
distribution.add(-1);
assert.equal(distribution.snapshot().samples, 100_000, "the full capture contributes, not only its final rolling window");
assert.equal(distribution.snapshot().p95Ms, 10);
assert.equal(distribution.snapshot().p99Ms, 10);
assert.equal(distribution.snapshot().over33_33Ms, 1000);
distribution.add(2000);
assert.equal(distribution.snapshot().maxMs, 2000, "long stalls must remain visible");
assert.equal(distribution.snapshot().overflowSamples, 1);
assert.equal(PROFILE_LIMITS.maxSeconds, 900);

assert.ok(PROFILE_ROUTE.seconds >= 60);
assert.ok(PROFILE_ROUTE.biomes.length >= 3, "route includes multiple real biome transitions");
assert.ok(PROFILE_ROUTE.patterns.length > 10, "route exercises diverse generated sections");
const expected = resimulate(PROFILE_ROUTE.recording as RunRecording, new SimWorld());
assert.equal(expected.status, "running");
assert.equal(expected.distance, PROFILE_ROUTE.recording.distance);
assert.equal(expected.stats.score, PROFILE_ROUTE.recording.score);
for (const refresh of [30, 60, 144, 240]) {
  const world = new SimWorld();
  const driver = new ProfileRouteDriver(world);
  for (let frame = 0; frame < PROFILE_ROUTE.seconds * refresh; frame++) driver.advance(1 / refresh);
  assert.equal(driver.failed, null, `${refresh} Hz must retain the real route`);
  assert.equal(driver.totalSteps, PROFILE_ROUTE.recording.steps);
  assert.equal(driver.loops, 0);
  assert.deepEqual(world.stats, expected.stats, `${refresh} Hz plays the exact recorded fixed-step inputs`);
  driver.advance(FIXED_DT);
  assert.equal(driver.loops, 1, "thermal routes repeat without input/history growth");
  assert.equal(driver.totalSteps, PROFILE_ROUTE.recording.steps + 1);
  assert.equal(world.time, FIXED_DT);
}
console.log("Profiling: full-capture tails, real multi-biome route, exact 30/60/144/240 Hz playback, and thermal-loop reset passed");
