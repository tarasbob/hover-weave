/**
 * Headless sim smoke test: a conservative band-scan autopilot (avoids the
 * full worst-case envelope of every mover, like the validator plans with)
 * plus determinism and pool-pressure checks.
 *
 * Fairness itself is enforced at generation time — every accepted chunk is
 * proven passable by the reachability solver (see gentest.ts). Bot deaths
 * here reflect bot skill (it cannot time gaps through movers like a human);
 * the metric that matters is that distances stay reasonable and nothing
 * degenerates (all runs dying instantly = broken generation).
 *
 * Run: npx tsx scripts/simtest.ts
 */
import assert from "node:assert/strict";
import {
  SimWorld,
  obstacleTrailingEdge,
  precisionRewardAt,
} from "../src/game/core/world";
import type { InputState } from "../src/game/core/input";
import { CRAFT, FIXED_DT, POOL_SIZES, STEER, TRACK } from "../src/game/core/constants";
import { blockedRanges } from "../src/game/track/validator";
import { Motion, type ObstacleSpec } from "../src/game/core/types";

function specOf(o: SimWorld["obstacles"][number]): ObstacleSpec {
  return {
    kind: o.kind, s: o.s, x: o.x, y: o.y, hx: o.hx, hy: o.hy, hs: o.hs,
    yaw: o.yaw, motion: o.motion, m0: o.m0, m1: o.m1, m2: o.m2,
    inner: o.inner, collidable: o.collidable,
  };
}

function autopilot(world: SimWorld, input: InputState): void {
  const craftS = world.distance;
  const bandStart = craftS + 2;
  const bandEnd = craftS + 10 + Math.max(world.speed, 20) * 1.35;

  const blocked: [number, number][] = [];
  for (const o of world.obstacles) {
    if (!o.active || !o.collidable) continue;
    const sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx + 2;
    if (o.cs + sExt < bandStart || o.cs - sExt > bandEnd) continue;
    const restY = o.motion === Motion.FallY ? o.m1 : o.cy;
    const vHalf = o.kind === "ring" ? o.hx : o.hy;
    if (restY - vHalf > CRAFT.Y_MAX || restY + vHalf < CRAFT.Y_MIN) continue;
    for (const r of blockedRanges(specOf(o))) blocked.push(r);
  }
  blocked.sort((a, b) => a[0] - b[0]);

  const gaps: [number, number][] = [];
  let cursor = -TRACK.X_LIMIT;
  for (const [b0, b1] of blocked) {
    if (b0 > cursor + 2) gaps.push([cursor, b0]);
    cursor = Math.max(cursor, b1);
  }
  if (cursor < TRACK.X_LIMIT - 2) gaps.push([cursor, TRACK.X_LIMIT]);

  let targetX = world.x;
  if (gaps.length > 0) {
    let bestCost = Infinity;
    for (const [g0, g1] of gaps) {
      const gx = Math.min(Math.max(world.x, g0 + 1.2), g1 - 1.2);
      const width = g1 - g0;
      const cost = Math.abs(gx - world.x) - Math.min(width, 10) * 0.4;
      if (cost < bestCost) {
        bestCost = cost;
        targetX = gx;
      }
    }
  }

  const err = targetX - world.x;
  const maxLat = Math.max(10, world.speed) * STEER.RATIO;
  const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
  input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
  input.boost = false;
}

let totalDeaths = 0;
let totalDist = 0;
let peakActive = 0;
let minDist = Infinity;
const peakByKind = new Map<string, number>();
let peakShards = 0;
let peakShields = 0;
const runs = 8;
for (let r = 0; r < runs; r++) {
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const seed = `test-${r}`;
  world.start(seed, false);
  let killer = "";
  world.events.on("death", () => {
    let best = Infinity;
    for (const o of world.obstacles) {
      if (!o.active || !o.collidable) continue;
      const d2 = (o.cx - world.x) ** 2 + (o.cs - world.distance) ** 2;
      if (d2 < best) {
        best = d2;
        killer = `${o.kind} motion=${o.motion} at s=${o.cs.toFixed(0)}`;
      }
    }
  });

  const targetTime = 180;
  let steps = 0;
  let runPeak = 0;
  const maxSteps = Math.floor(targetTime / FIXED_DT);
  while (world.status === "running" && steps < maxSteps) {
    autopilot(world, input);
    world.update(FIXED_DT, input);
    if (steps % 60 === 0) {
      const active = world.obstacles.filter((o) => o.active).length;
      if (active > runPeak) runPeak = active;
      const byKind = new Map<string, number>();
      for (const obstacle of world.obstacles) {
        if (obstacle.active) byKind.set(obstacle.kind, (byKind.get(obstacle.kind) ?? 0) + 1);
      }
      for (const [kind, count] of byKind) {
        peakByKind.set(kind, Math.max(peakByKind.get(kind) ?? 0, count));
      }
      peakShards = Math.max(
        peakShards,
        world.pickups.filter((pickup) => pickup.active && pickup.type === "shard").length,
      );
      peakShields = Math.max(
        peakShields,
        world.pickups.filter((pickup) => pickup.active && pickup.type === "shield").length,
      );
    }
    steps++;
  }
  peakActive = Math.max(peakActive, runPeak);
  if (world.status === "dead") totalDeaths++;
  totalDist += world.distance;
  minDist = Math.min(minDist, world.distance);
  assert.equal(world.stats.obstacleDrops, 0, `${seed} exhausted the obstacle pool`);
  assert.equal(world.stats.pickupDrops, 0, `${seed} exhausted the pickup pool`);
  console.log(
    `run ${r}: ${world.status.padEnd(7)} dist=${world.distance.toFixed(0).padStart(6)}m ` +
    `score=${Math.floor(world.score).toString().padStart(7)} speed=${world.speed.toFixed(1)} ` +
    `nearMiss=${world.stats.nearMisses} shards=${world.stats.shards} ` +
    `peakActive=${runPeak}` +
    (killer ? ` killer: ${killer}` : ""),
  );
}
console.log(
  `\ndeaths: ${totalDeaths}/${runs}, avg dist=${Math.round(totalDist / runs)}m, ` +
  `peak active obstacles=${peakActive} (render pools: box ${POOL_SIZES.box} / ` +
  `pillar ${POOL_SIZES.pillar} / crystal ${POOL_SIZES.crystal})`,
);
const avgDist = totalDist / runs;
assert.ok(minDist > 450, `opening is too punishing for the conservative bot (${minDist.toFixed(0)}m)`);
assert.ok(avgDist > 900, `average survival collapsed to ${avgDist.toFixed(0)}m`);
assert.ok(avgDist < 9000, `challenge curve is too gentle (${avgDist.toFixed(0)}m average)`);
assert.ok(peakActive < 500, `active obstacle pressure is unexpectedly high (${peakActive})`);
for (const kind of ["box", "pillar", "crystal", "sphere", "ring"] as const) {
  assert.ok(
    (peakByKind.get(kind) ?? 0) < POOL_SIZES[kind],
    `${kind} render pool lacks headroom (${peakByKind.get(kind)}/${POOL_SIZES[kind]})`,
  );
}
assert.ok(peakShards < POOL_SIZES.shard, `shard render pool lacks headroom (${peakShards})`);
assert.ok(peakShields < POOL_SIZES.shield, `shield render pool lacks headroom (${peakShields})`);

// Determinism check.
{
  const a = new SimWorld();
  const b = new SimWorld();
  const eventsA: unknown[] = [];
  const eventsB: unknown[] = [];
  const wire = (world: SimWorld, out: unknown[]) => {
    world.events.on("nearMiss", (event) => out.push(["nearMiss", event]));
    world.events.on("shard", (event) => out.push(["shard", event]));
    world.events.on("flowTier", (event) => out.push(["flowTier", event]));
    world.events.on("biome", (event) => out.push(["biome", event]));
    world.events.on("death", (event) => out.push(["death", event]));
  };
  wire(a, eventsA);
  wire(b, eventsB);
  const input: InputState = { axis: 0.3, boost: false, restart: false, pause: false };
  a.start("determinism", false);
  b.start("determinism", false);
  for (let i = 0; i < 12000; i++) {
    input.axis = Math.sin(i * 0.01) * 0.8;
    a.update(FIXED_DT, input);
    b.update(FIXED_DT, input);
  }
  assert.equal(a.distance, b.distance);
  assert.equal(a.score, b.score);
  assert.equal(a.x, b.x);
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(eventsA, eventsB);
  console.log(`determinism: PASS (dist=${a.distance.toFixed(2)} vs ${b.distance.toFixed(2)})`);
}

// Focused mastery-economy checks.
{
  const perfect = precisionRewardAt(0.1);
  const razor = precisionRewardAt(0.45);
  const close = precisionRewardAt(1);
  assert.equal(perfect.grade, "perfect");
  assert.equal(razor.grade, "razor");
  assert.equal(close.grade, "close");
  assert.ok(perfect.baseScore > razor.baseScore && razor.baseScore > close.baseScore);
  assert.ok(perfect.flowPoints > razor.flowPoints && razor.flowPoints > close.flowPoints);

  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  world.start("combo-economy", false);
  const shards = world.pickups.filter((pickup) => pickup.active && pickup.type === "shard");
  assert.ok(shards.length >= 2, "fixed combo seed did not generate enough shards");
  const startEnergy = world.energy;
  for (const shard of shards.slice(0, 2)) {
    shard.s = world.distance;
    shard.x = world.x;
    world.update(FIXED_DT, input);
  }
  assert.equal(world.shardCombo, 2);
  assert.equal(world.stats.bestShardCombo, 2);
  assert.ok(world.energy > startEnergy + 10, "shard combo did not add bonus energy");
  assert.ok(world.flowDecayGrace < 3, "Flow grace should remain bounded");
}

console.log("simulation assertions: PASS");

// Fixed-step partitioning must not grant slow motion at low render FPS.
{
  const smooth = new SimWorld();
  const chunky = new SimWorld();
  const input: InputState = { axis: 0.2, boost: false, restart: false, pause: false };
  smooth.start("frame-partition", false);
  chunky.start("frame-partition", false);
  for (let i = 0; i < 120; i++) smooth.update(FIXED_DT, input);
  for (let i = 0; i < 10; i++) chunky.update(0.1, input);
  assert.equal(chunky.time, smooth.time);
  assert.equal(chunky.distance, smooth.distance);
  assert.equal(chunky.x, smooth.x);
}

// A fatal collision freezes score/resources and cannot also collect a shard.
{
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const makeDeathProbe = (seed: string) => {
    const world = new SimWorld();
    world.start(seed, false);
    world.clearField();
    Object.assign(world.obstacles[0], {
      active: true,
      kind: "box",
      s: 0,
      x: 0,
      y: 1,
      hx: 2,
      hy: 2,
      hs: 2,
      yaw: 0,
      motion: Motion.None,
      collidable: true,
      cx: 0,
      cy: 1,
      cs: 0,
      cyaw: 0,
      nearMissed: false,
      nearMissClearance: Infinity,
      patternId: "deathFreeze",
    });
    Object.assign(world.pickups[0], {
      active: true,
      type: "shard",
      s: 0,
      x: 0,
      y: 1.3,
      seeking: false,
      magnetic: true,
    });
    world.score = 100;
    return world;
  };

  const world = makeDeathProbe("death-freeze");
  let deaths = 0;
  let shards = 0;
  world.events.on("death", () => deaths++);
  world.events.on("shard", () => shards++);
  world.update(FIXED_DT, input);
  assert.equal(world.status, "dead");
  assert.equal(world.score, 100);
  assert.equal(world.stats.score, 100);
  assert.equal(world.stats.shards, 0);
  assert.equal(deaths, 1);
  assert.equal(shards, 0);
  assert.equal(world.pickups[0].active, true);

  const fixedDeath = makeDeathProbe("death-partition");
  const chunkyDeath = makeDeathProbe("death-partition");
  for (let i = 0; i < 12; i++) fixedDeath.update(FIXED_DT, input);
  chunkyDeath.update(0.1, input);
  assert.ok(Math.abs(chunkyDeath.time - fixedDeath.time) < 1e-12);
  assert.ok(Math.abs(chunkyDeath.deathTimer - fixedDeath.deathTimer) < 1e-12);
  assert.ok(Math.abs(chunkyDeath.speed - fixedDeath.speed) < 1e-12);
}

// Moving geometry must be fully behind before a precision pass can settle.
{
  const probe = new SimWorld().obstacles[0];
  Object.assign(probe, {
    cs: 100,
    s: 100,
    hx: 8,
    hs: 0.5,
    cyaw: 0,
    motion: Motion.RotateYaw,
    m0: 2,
  });
  assert.ok(obstacleTrailingEdge(probe) > probe.cs + probe.hs + 7);
  probe.motion = Motion.OrbitXZ;
  probe.m0 = 9;
  assert.equal(obstacleTrailingEdge(probe), 117);
}

console.log("edge-case assertions: PASS");
