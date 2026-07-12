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
import { SimWorld } from "../src/game/core/world";
import type { InputState } from "../src/game/core/input";
import { CRAFT, FIXED_DT, STEER, TRACK } from "../src/game/core/constants";
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
    }
    steps++;
  }
  peakActive = Math.max(peakActive, runPeak);
  if (world.status === "dead") totalDeaths++;
  totalDist += world.distance;
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
  `peak active obstacles=${peakActive} (render pools: box 512 / pillar 256 / crystal 256)`,
);

// Determinism check.
{
  const a = new SimWorld();
  const b = new SimWorld();
  const input: InputState = { axis: 0.3, boost: false, restart: false, pause: false };
  a.start("determinism", false);
  b.start("determinism", false);
  for (let i = 0; i < 12000; i++) {
    input.axis = Math.sin(i * 0.01) * 0.8;
    a.update(FIXED_DT, input);
    b.update(FIXED_DT, input);
  }
  const same = a.distance === b.distance && a.score === b.score && a.x === b.x;
  console.log(`determinism: ${same ? "PASS" : "FAIL"} (dist=${a.distance.toFixed(2)} vs ${b.distance.toFixed(2)})`);
}
