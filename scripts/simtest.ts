/**
 * Headless sim smoke test: runs an autopilot craft through generated tracks
 * and reports survival, pattern mix, validation retries and pool usage.
 * Run: npx tsx scripts/simtest.ts
 */
import { SimWorld } from "../src/game/core/world";
import type { InputState } from "../src/game/core/input";
import { FIXED_DT, TRACK, STEER, CRAFT } from "../src/game/core/constants";
import { blockedRanges } from "../src/game/track/validator";
import { Motion } from "../src/game/core/types";

function autopilot(world: SimWorld, input: InputState): void {
  // Look ahead, find the best gap at each of a few horizons, steer toward it.
  const craftS = world.distance;
  const horizons = [18, 34, 55];
  let targetX = world.x;
  let found = false;

  for (const h of horizons) {
    const s = craftS + h;
    // Collect blocked intervals near this horizon slice.
    const blocked: [number, number][] = [];
    for (const o of world.obstacles) {
      if (!o.active || !o.collidable) continue;
      const sExt = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx + 3;
      if (Math.abs(o.cs - s) > sExt + 6) continue;
      const restY = o.motion === Motion.FallY ? o.m1 : o.cy;
      if (restY - o.hy > CRAFT.Y_MAX || restY + o.hy < CRAFT.Y_MIN) continue;
      for (const r of blockedRanges({
        kind: o.kind, s: o.s, x: o.x, y: o.y, hx: o.hx, hy: o.hy, hs: o.hs,
        yaw: o.yaw, motion: o.motion, m0: o.m0, m1: o.m1, m2: o.m2,
        inner: o.inner, collidable: o.collidable,
      })) {
        blocked.push(r);
      }
    }
    blocked.sort((a, b) => a[0] - b[0]);
    // Find gaps.
    const gaps: [number, number][] = [];
    let cursor = -TRACK.X_LIMIT;
    for (const [b0, b1] of blocked) {
      if (b0 > cursor + 2.2) gaps.push([cursor, b0]);
      cursor = Math.max(cursor, b1);
    }
    if (cursor < TRACK.X_LIMIT - 2.2) gaps.push([cursor, TRACK.X_LIMIT]);
    if (gaps.length === 0) continue;
    // Pick reachable gap closest to current x.
    const reach = world.speed * STEER.RATIO * (h / Math.max(world.speed, 1)) * 0.85;
    let best: number | null = null;
    let bestCost = Infinity;
    for (const [g0, g1] of gaps) {
      const gx = Math.min(Math.max(world.x, g0 + 1.4), g1 - 1.4);
      const cost = Math.abs(gx - world.x) > reach ? Math.abs(gx - world.x) * 10 : Math.abs(gx - world.x);
      if (cost < bestCost) {
        bestCost = cost;
        best = gx;
      }
    }
    if (best !== null && !found) {
      targetX = best;
      found = true;
    }
  }

  const err = targetX - world.x;
  const maxLat = Math.max(10, world.speed) * STEER.RATIO;
  const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
  input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
  input.boost = false;
}

let totalDeaths = 0;
const runs = 6;
for (let r = 0; r < runs; r++) {
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  const seed = `test-${r}`;
  world.start(seed, false);
  let killer = "";
  world.events.on("death", () => {
    // Find nearest collidable obstacle to blame.
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
  const targetTime = 180; // 3 minutes of sim.
  let steps = 0;
  const maxSteps = Math.floor(targetTime / FIXED_DT);
  while (world.status === "running" && steps < maxSteps) {
    autopilot(world, input);
    world.update(FIXED_DT, input);
    steps++;
  }
  const active = world.obstacles.filter((o) => o.active).length;
  const activeP = world.pickups.filter((p) => p.active).length;
  if (world.status === "dead") totalDeaths++;
  console.log(
    `run ${r}: ${world.status.padEnd(7)} dist=${world.distance.toFixed(0).padStart(6)}m ` +
    `score=${Math.floor(world.score).toString().padStart(7)} speed=${world.speed.toFixed(1)} ` +
    `nearMiss=${world.stats.nearMisses} shards=${world.stats.shards} ` +
    `activeObs=${active} activePickups=${activeP}` +
    (killer ? ` killer: ${killer}` : ""),
  );
}
console.log(`\ndeaths: ${totalDeaths}/${runs} (autopilot is imperfect; some deaths ok, all-death = broken)`);

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
