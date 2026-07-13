/**
 * Headless sim smoke test: a conservative band-scan autopilot (avoids the
 * full worst-case envelope of every mover, like the validator plans with)
 * plus determinism, pool-pressure, and risk-economy acceptance checks.
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
  GRADE_MIN_INTENSITY,
  SimWorld,
  gradeSection,
  obstacleTrailingEdge,
  precisionRewardAt,
} from "../src/game/core/world";
import { GhostDriver } from "../src/game/core/ghost";
import {
  ghostEligible,
  packInput,
  quantizeAxis,
  resimulate,
  unpackAxis,
  unpackBoost,
  unpackDash,
} from "../src/game/core/replay";
import type { InputState } from "../src/game/core/input";
import {
  DASH,
  ENERGY,
  FIXED_DT,
  onBeatAt,
  POOL_SIZES,
  RESONANCE,
  RESONANCE_BEAT,
  SPRINT_MODE,
  STEER,
  SURGE,
  THREAD,
  TRACK,
} from "../src/game/core/constants";
import { heatScoreMult, normalizeHeat, resolveHeat, NO_HEAT, type HeatId } from "../src/game/core/heat";
import { normalizeLab, resolveLab, NO_LAB, type LabId } from "../src/game/core/lab";
import type { RunConfig } from "../src/game/core/modes";
import { questsForDay, QUESTS_PER_DAY, type QuestSample } from "../src/game/core/quests";
import { RATING, ratingTier, runPerformance, updateRating, RATING_TIERS } from "../src/game/core/rating";
import { createRng } from "../src/game/core/rng";
import { Motion, type ObstacleSpec, type PatternResult } from "../src/game/core/types";
import { TrackGenerator } from "../src/game/track/generator";
import { resonatePattern } from "../src/game/track/mutators";
import { MEDAL_ORDER, TRIALS, medalFor, nextMedalFor, trialSeed } from "../src/game/track/trials";
import { corridorLanes, validatePattern } from "../src/game/track/validator";
import { autopilot, lookaheadPilot, scanGaps, steerToward, superhumanPilot } from "./pilots";

const endless = (seed: string): RunConfig => ({ mode: "endless", seed });

// --- Conservative-bot survival + pool pressure + first-2km economy gate ----

// Pre-Phase-1 baselines (conservative bot, no boost). The risk-economy
// rebalance must keep the novice-proxy line within ±10% on average.
const BASELINE_800: Record<string, number> = {
  "test-0": 3615, "test-1": 3041, "test-2": 3473, "test-3": 3375,
  "test-4": 3571, "test-5": 3227, "test-6": 2627, "test-7": 3232,
};
const BASELINE_2KM: Record<string, number> = {
  "test-3": 4706, "test-5": 4890, "test-6": 4041,
};

let totalDeaths = 0;
let totalDist = 0;
let peakActive = 0;
let minDist = Infinity;
const peakByKind = new Map<string, number>();
let peakShards = 0;
let peakShields = 0;
const score800: Record<string, number> = {};
const score2km: Record<string, number> = {};
const runs = 8;
for (let r = 0; r < runs; r++) {
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const seed = `test-${r}`;
  world.start(endless(seed));
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
    if (score800[seed] === undefined && world.distance >= 800) {
      score800[seed] = Math.floor(world.score);
    }
    if (score2km[seed] === undefined && world.distance >= 2000) {
      score2km[seed] = Math.floor(world.score);
    }
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

// Floor check (roadmap Phase 1): the conservative line through the opening
// must score like it did before the risk economy landed.
{
  const drifts: number[] = [];
  for (const [seed, base] of Object.entries(BASELINE_800)) {
    const now = score800[seed];
    assert.ok(now !== undefined, `${seed} no longer reaches 800m`);
    const drift = now / base - 1;
    drifts.push(drift);
    assert.ok(
      Math.abs(drift) < 0.15,
      `${seed} first-800m score drifted ${(drift * 100).toFixed(1)}% (${base} -> ${now})`,
    );
  }
  for (const [seed, base] of Object.entries(BASELINE_2KM)) {
    const now = score2km[seed];
    assert.ok(now !== undefined, `${seed} no longer reaches 2km`);
    const drift = now / base - 1;
    drifts.push(drift);
    assert.ok(
      Math.abs(drift) < 0.15,
      `${seed} first-2km score drifted ${(drift * 100).toFixed(1)}% (${base} -> ${now})`,
    );
  }
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  assert.ok(
    Math.abs(avgDrift) < 0.1,
    `novice-proxy scoring drifted ${(avgDrift * 100).toFixed(1)}% on average`,
  );
  console.log(`first-2km economy gate: PASS (avg drift ${(avgDrift * 100).toFixed(1)}%)`);
}

// --- Boost uptime: the risk loop must reward grazing, not shard-hoarding ---
// Hard-pattern gauntlet: narrowGates-style rows every 28m, each with a tight
// needle gap (thread + double razor for a committed line) and a wide safe
// lane (no precision income). The economy must let the tight line sustain
// near-perpetual boost while the safe lane cannot.
{
  const TIGHT_X = -10;
  const TIGHT_HALF = 1.3; // hull clearance 0.55 -> razor on both sides
  const SAFE_X = 21;
  const buildGauntlet = (world: SimWorld): void => {
    world.clearField();
    // Stop the procedural generator from streaming real chunks over the course.
    (world as unknown as { generator: null }).generator = null;
    let idx = 0;
    const wall = (s: number, x0: number, x1: number) => {
      const hx = (x1 - x0) / 2;
      const x = (x0 + x1) / 2;
      Object.assign(world.obstacles[idx++], {
        active: true, kind: "box",
        s, x, y: 2, hx, hy: 3, hs: 1, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0,
        collidable: true,
        cx: x, cy: 2, cs: s, cyaw: 0,
        state: 0, landed: false,
        nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
        patternId: "gauntlet",
      });
    };
    for (let r = 0; r < 220; r++) {
      const s = 60 + r * 28;
      wall(s, -TRACK.X_PATTERN, TIGHT_X - TIGHT_HALF);
      wall(s, TIGHT_X + TIGHT_HALF, SAFE_X - 5);
      wall(s, SAFE_X + 5, TRACK.X_PATTERN);
    }
  };

  const gauntletRun = (targetX: number, seconds: number) => {
    const world = new SimWorld();
    world.start(endless("gauntlet"));
    buildGauntlet(world);
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    const maxSteps = Math.floor(seconds / FIXED_DT);
    for (let i = 0; i < maxSteps && world.status === "running"; i++) {
      const err = targetX - world.x;
      const maxLat = Math.max(10, world.speed) * STEER.RATIO;
      const desiredVel = Math.sign(err) * Math.min(Math.abs(err) * 4, maxLat);
      input.axis = Math.max(-1, Math.min(1, (desiredVel - world.latVel) * 0.3));
      input.boost = world.boosting ? true : world.energy > 14;
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running", "gauntlet line must not crash");
    return world;
  };

  const tight = gauntletRun(TIGHT_X, 75);
  const tightUptime = tight.stats.boostTime / tight.stats.duration;
  console.log(
    `gauntlet tight line: uptime=${(tightUptime * 100).toFixed(0)}% ` +
    `dist=${tight.distance.toFixed(0)}m score=${Math.floor(tight.score)} ` +
    `nearMiss=${tight.stats.nearMisses} threads=${tight.stats.threads} ` +
    `razor=${tight.stats.razorPasses}`,
  );
  assert.ok(
    tightUptime > 0.8,
    `tight line cannot sustain boost through hard patterns (${(tightUptime * 100).toFixed(0)}%, want >80%)`,
  );
  assert.ok(tight.stats.threads > 40, `tight line should thread every gate (${tight.stats.threads})`);

  const safe = gauntletRun(SAFE_X, 75);
  const safeUptime = safe.stats.boostTime / safe.stats.duration;
  console.log(
    `gauntlet safe line:  uptime=${(safeUptime * 100).toFixed(0)}% ` +
    `dist=${safe.distance.toFixed(0)}m score=${Math.floor(safe.score)} ` +
    `nearMiss=${safe.stats.nearMisses}`,
  );
  assert.ok(
    tight.score > safe.score * 8,
    `the tight line must dwarf the safe line (${Math.floor(tight.score)} vs ${Math.floor(safe.score)})`,
  );
  assert.ok(
    safeUptime < 0.15,
    `safe lane must not sustain boost through hard patterns (${(safeUptime * 100).toFixed(0)}%)`,
  );
  assert.equal(safe.stats.nearMisses, 0, "safe lane must not graze");

  // On real seeds, a center-line shard-collecting bot stays a visitor to
  // boost, not a resident.
  const safeRuns: number[] = [];
  for (let r = 0; r < 4; r++) {
    const world = new SimWorld();
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    world.start(endless(`test-${r}`));
    const maxSteps = Math.floor(150 / FIXED_DT);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      autopilot(world, input, { boost: true });
      world.update(FIXED_DT, input);
      steps++;
    }
    safeRuns.push(world.stats.boostTime / Math.max(1e-6, world.stats.duration));
  }
  const safeAvg = safeRuns.reduce((a, b) => a + b, 0) / safeRuns.length;
  console.log(`real-track safe bot: avg uptime=${(safeAvg * 100).toFixed(0)}%`);
  assert.ok(
    safeAvg < 0.35,
    `real-track center-line play sustains boost too easily (${(safeAvg * 100).toFixed(0)}%)`,
  );
  console.log("boost economy gate: PASS");
}

// Determinism check.
{
  const a = new SimWorld();
  const b = new SimWorld();
  const eventsA: unknown[] = [];
  const eventsB: unknown[] = [];
  const wire = (world: SimWorld, out: unknown[]) => {
    world.events.on("nearMiss", (event) => out.push(["nearMiss", event]));
    world.events.on("thread", (event) => out.push(["thread", event]));
    world.events.on("shard", (event) => out.push(["shard", event]));
    world.events.on("flowTier", (event) => out.push(["flowTier", event]));
    world.events.on("biome", (event) => out.push(["biome", event]));
    world.events.on("sectionGrade", (event) => out.push(["sectionGrade", event]));
    world.events.on("death", (event) => out.push(["death", event]));
  };
  wire(a, eventsA);
  wire(b, eventsB);
  const input: InputState = { axis: 0.3, boost: false, dash: false, restart: false, pause: false };
  a.start(endless("determinism"));
  b.start(endless("determinism"));
  for (let i = 0; i < 12000; i++) {
    input.axis = Math.sin(i * 0.01) * 0.8;
    input.boost = i % 900 < 300;
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

// --- Phase 3: input recording + replay (roadmap 3.1) -------------------------
// A recorded run must re-simulate bit-exactly: same stats, same score, same
// death — the roadmap's determinism metric ("replay re-simulation reproduces
// recorded stats exactly").
{
  // Quantization round-trips: replaying a recording re-quantizes the axis,
  // so quantizeAxis must be idempotent and packing lossless.
  for (const axis of [-1, -0.73, -1 / 3, 0, 0.05, 0.4999, 0.999, 1]) {
    const q = quantizeAxis(axis);
    assert.equal(quantizeAxis(q), q, `quantizeAxis must be idempotent (${axis})`);
    for (const boost of [false, true]) {
      const packed = packInput(axis, boost);
      assert.equal(unpackAxis(packed), q, `axis pack round-trip (${axis})`);
      assert.equal(unpackBoost(packed), boost, `boost pack round-trip (${axis})`);
    }
  }

  // Record a full bot run to death (boost on: exercises the energy loop and
  // the boost bit; the bot's continuous axis exercises quantization).
  const live = new SimWorld();
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  live.start(endless("replay-exact"));
  const liveEvents: unknown[] = [];
  live.events.on("nearMiss", (e) => liveEvents.push(["nearMiss", e]));
  live.events.on("thread", (e) => liveEvents.push(["thread", e]));
  live.events.on("sectionGrade", (e) => liveEvents.push(["sectionGrade", e]));
  live.events.on("death", (e) => liveEvents.push(["death", e]));
  const maxSteps = Math.floor(240 / FIXED_DT);
  for (let i = 0; i < maxSteps && live.status === "running"; i++) {
    autopilot(live, input, { boost: true });
    live.update(FIXED_DT, input);
  }
  assert.equal(live.status, "dead", "replay probe run must end at a wall");
  const rec = live.getRecording();
  assert.ok(rec, "a finished run must produce a recording");
  assert.ok(rec.complete, "probe recording must fit the RLE cap");
  assert.equal(rec.seed, "replay-exact");
  assert.equal(rec.score, live.stats.score);
  let rleSteps = 0;
  for (let i = 1; i < rec.data.length; i += 2) rleSteps += rec.data[i];
  assert.equal(rleSteps, rec.steps, "RLE run lengths must sum to the step count");

  const replayed = new SimWorld();
  const replayEvents: unknown[] = [];
  replayed.events.on("nearMiss", (e) => replayEvents.push(["nearMiss", e]));
  replayed.events.on("thread", (e) => replayEvents.push(["thread", e]));
  replayed.events.on("sectionGrade", (e) => replayEvents.push(["sectionGrade", e]));
  replayed.events.on("death", (e) => replayEvents.push(["death", e]));
  resimulate(rec, replayed);
  assert.equal(replayed.status, "dead", "replay must reproduce the death");
  assert.equal(replayed.distance, live.distance, "replay distance must be exact");
  assert.equal(replayed.score, live.score, "replay score must be exact");
  assert.equal(replayed.x, live.x, "replay lateral position must be exact");
  assert.deepEqual(replayed.stats, live.stats, "replay stats must be identical");
  assert.deepEqual(replayEvents, liveEvents, "replay event stream must be identical");
  assert.equal(replayed.getRecording(), null, "replay worlds must not re-record");

  // Size: human-style input (held keys, sparse changes) stays a few KB.
  const keyed = new SimWorld();
  keyed.start(endless("replay-size"));
  const keyInput: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const keySteps = Math.floor(180 / FIXED_DT); // 3-minute run
  for (let i = 0; i < keySteps && keyed.status === "running"; i++) {
    // Direction changes every ~0.4 s, boost toggles every ~2 s — a busy human.
    const phase = Math.floor(i / 48) % 3;
    keyInput.axis = phase === 0 ? -1 : phase === 1 ? 1 : 0;
    keyInput.boost = i % 240 < 90;
    keyed.update(FIXED_DT, keyInput);
  }
  const keyRec = keyed.getRecording();
  assert.ok(keyRec && keyRec.complete);
  const keyBytes = JSON.stringify(keyRec).length;
  assert.ok(
    keyBytes < 32_000,
    `keyboard-style recording must stay a few KB (${(keyBytes / 1024).toFixed(1)} KB)`,
  );
  // Continuous analog input (bot stream) is the worst case — bounded, not tiny.
  const botBytes = JSON.stringify(rec).length;
  assert.ok(
    botBytes < 1_500_000,
    `continuous recording must stay bounded (${(botBytes / 1024).toFixed(0)} KB)`,
  );
  console.log(
    `replay gate: PASS (exact re-sim at ${live.distance.toFixed(0)}m; ` +
    `keyboard rec ${(keyBytes / 1024).toFixed(1)} KB, bot rec ${(botBytes / 1024).toFixed(0)} KB)`,
  );

  // Ghost lockstep (roadmap 3.2): a GhostDriver synced in ragged render-frame
  // slices must land exactly where the straight re-sim landed.
  const ghost = new GhostDriver();
  ghost.arm(rec);
  assert.ok(ghost.active, "ghost must arm from a complete recording");
  const totalTime = rec.steps * FIXED_DT;
  let clock = 0;
  let frame = 0;
  while (clock < totalTime + 0.1) {
    clock += 1 / 60 + (frame % 7) * 0.003; // deliberately uneven frames
    ghost.sync(clock);
    frame++;
  }
  assert.ok(ghost.finished, "ghost must exhaust the recording");
  assert.equal(ghost.world?.status, "dead", "ghost must die where the run died");
  assert.equal(ghost.world?.distance, replayed.distance, "ghost distance must be exact");
  assert.equal(ghost.world?.stats.score, replayed.stats.score, "ghost score must be exact");
  assert.equal(ghost.deltaTo(replayed.distance), 0, "ghost delta must close to zero");
  console.log("ghost lockstep gate: PASS");
}

// --- Phase 3: section grades (roadmap 3.4) -----------------------------------
{
  // Unit calibration: an elite line through a hard chunk grades S, an
  // edge-hugging cruise grades C, and grades are monotone in engagement.
  const elite = gradeSection({
    intensity: 4,
    events: 14, // ~threaded every gate across 120 m
    traversed: 120,
    flowUptime: 0.95,
    avgSpeed: 120,
    baseSpeed: 85,
  });
  assert.equal(elite.grade, "S", `elite line must grade S (${elite.composite.toFixed(2)})`);

  const hug = gradeSection({
    intensity: 4,
    events: 0,
    traversed: 120,
    flowUptime: 0,
    avgSpeed: 82,
    baseSpeed: 85,
  });
  assert.equal(hug.grade, "C", `edge-hugging must grade C (${hug.composite.toFixed(2)})`);

  const cautious = gradeSection({
    intensity: 3,
    events: 3,
    traversed: 120,
    flowUptime: 0.4,
    avgSpeed: 86,
    baseSpeed: 85,
  });
  assert.ok(
    cautious.composite > hug.composite && cautious.composite < elite.composite,
    "grades must be monotone in line quality",
  );
  // Same play against a harder chunk must never grade higher.
  const sameLineHarder = gradeSection({
    intensity: 5,
    events: 3,
    traversed: 120,
    flowUptime: 0.4,
    avgSpeed: 86,
    baseSpeed: 85,
  });
  assert.ok(sameLineHarder.composite <= cautious.composite, "intensity must raise the bar");

  // Integration: a real bot run produces ordered, sane sections and — since
  // it dies — an aggregate line rating.
  const world = new SimWorld();
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  world.start(endless("test-0"));
  const emitted: { patternId: string; grade: string }[] = [];
  world.events.on("sectionGrade", (e) => emitted.push(e));
  const maxSteps = Math.floor(180 / FIXED_DT);
  for (let i = 0; i < maxSteps && world.status === "running"; i++) {
    autopilot(world, input);
    world.update(FIXED_DT, input);
  }
  assert.equal(world.status, "dead");
  const sections = world.stats.sections;
  assert.ok(sections.length >= 3, `bot run must traverse sections (${sections.length})`);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    assert.ok(["S", "A", "B", "C"].includes(s.grade));
    assert.ok(s.composite >= 0 && s.composite <= 1, "composite must be normalized");
    assert.ok(s.s1 > s.s0);
    if (i > 0) assert.ok(s.s0 >= sections[i - 1].s0, "sections must be in track order");
  }
  const graded = sections.filter((s) => s.intensity >= GRADE_MIN_INTENSITY);
  assert.equal(
    emitted.length,
    graded.length,
    "every graded section must emit exactly one event",
  );
  if (graded.length > 0) {
    assert.ok(world.stats.lineRating !== null, "a run with graded sections gets a line rating");
  }
  console.log(
    `section grade gate: PASS (${sections.length} sections, ` +
    `${graded.length} graded, line rating ${world.stats.lineRating ?? "n/a"})`,
  );

  // Forensics snapshot (roadmap 3.3): the kill-cam data is complete.
  const f = world.buildForensics();
  assert.ok(f, "a dead world must produce forensics");
  assert.ok(f.trace.length > 10, "forensics must include the flown line");
  const lastSample = f.trace[f.trace.length - 1];
  assert.ok(
    Math.abs(lastSample.s - f.deathS) < 2,
    `the trace must end at the impact (${lastSample.s.toFixed(1)} vs ${f.deathS.toFixed(1)})`,
  );
  for (let i = 1; i < f.trace.length; i++) {
    assert.ok(f.trace[i].s >= f.trace[i - 1].s, "trace must be chronological");
  }
  assert.ok(f.obstacles.length > 0, "forensics must include the killing geometry");
  assert.ok(
    f.obstacles.some((o) => Math.abs(o.s - f.deathS) < 30),
    "forensics obstacles must cover the impact zone",
  );
  assert.ok(f.path.length > 0, "forensics must include the validator's solved path");
  assert.ok(f.deathSpeed > 0, "death speed must be captured before crash deceleration");
  const alive = new SimWorld();
  alive.start(endless("forensics-alive"));
  assert.equal(alive.buildForensics(), null, "forensics only exist after death");
  console.log(
    `forensics gate: PASS (trace ${f.trace.length} samples, ` +
    `${f.obstacles.length} obstacles, ${f.path.length} path segments)`,
  );
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
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  world.start(endless("combo-economy"));
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

// Uncapped Flow: gains push past the old cap; superlinear decay pulls back.
{
  const decayRateAt = (points: number): number => {
    const world = new SimWorld();
    world.start(endless("flow-uncap"));
    world.clearField();
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    world.flowPoints = points;
    world.update(FIXED_DT, input); // Settle flowTier for this level.
    world.flowPoints = points;
    world.flowTimer = 100; // Deep past the grace window.
    const before = world.flowPoints;
    world.update(FIXED_DT, input);
    return (before - world.flowPoints) / FIXED_DT;
  };

  const over = decayRateAt(40);
  const under = decayRateAt(20);
  assert.ok(under > 0, "flow must decay below the soft cap too");
  assert.ok(
    over > under * 4,
    `overcap decay should be superlinear (${over.toFixed(2)}/s vs ${under.toFixed(2)}/s)`,
  );

  // Flow points are genuinely uncapped now: a long graze chain pushes past 28.
  const world = new SimWorld();
  world.start(endless("flow-uncap-gain"));
  world.clearField();
  world.flowPoints = 27.9;
  world.flowTimer = 0;
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  world.update(FIXED_DT, input);
  const probe = world.obstacles[0];
  Object.assign(probe, {
    active: true, kind: "box",
    s: world.distance + 6, x: -1.2 - 3, hx: 3, hs: 0.5, y: 1, hy: 2, yaw: 0,
    motion: Motion.None, collidable: true,
    cx: -1.2 - 3, cy: 1, cs: world.distance + 6, cyaw: 0,
    state: 0, landed: false,
    nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
    patternId: "flowUncap",
  });
  for (let i = 0; i < 240 && world.stats.nearMisses === 0; i++) {
    world.update(FIXED_DT, input);
  }
  assert.equal(world.stats.nearMisses, 1);
  assert.ok(
    world.stats.maxFlowPoints > 28.5,
    `flow should exceed the old cap (peaked at ${world.stats.maxFlowPoints.toFixed(1)})`,
  );
}

console.log("simulation assertions: PASS");

// --- Thread the needle -------------------------------------------------------
// Synthetic gates driven through with a straight line: threads must fire on
// opposite-side pairs inside the window and never on single edges or
// same-side chains.
{
  const runProbe = (
    obstacles: Partial<SimWorld["obstacles"][number]>[],
  ): { world: SimWorld; threads: number; threadEvents: { scoreAward: number; tightness: number }[] } => {
    const world = new SimWorld();
    world.start(endless("thread-probe"));
    world.clearField();
    obstacles.forEach((spec, i) => {
      Object.assign(world.obstacles[i], {
        active: true,
        kind: "box",
        y: 1, hy: 2,
        yaw: 0,
        motion: Motion.None,
        collidable: true,
        cyaw: 0,
        state: 0, landed: false,
        nearMissed: false,
        nearMissClearance: Infinity,
        nearMissSide: 0,
        patternId: "threadProbe",
        ...spec,
        cx: spec.x, cy: 1, cs: spec.s,
      });
    });
    const threadEvents: { scoreAward: number; tightness: number }[] = [];
    world.events.on("thread", (e) => threadEvents.push(e));
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    for (let i = 0; i < 600 && world.status === "running"; i++) {
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running", "thread probe must not crash");
    return { world, threads: world.stats.threads, threadEvents };
  };

  // Hull edges at ±1.55 -> clearance 0.8 per side: double graze -> thread.
  const gate = (s: number, gapHalf: number, side: 1 | -1 | 0 = 0) => {
    const walls: Partial<SimWorld["obstacles"][number]>[] = [];
    if (side <= 0) walls.push({ s, x: -gapHalf - 3, hx: 3, hs: 1 });
    if (side >= 0) walls.push({ s, x: gapHalf + 3, hx: 3, hs: 1 });
    return walls;
  };

  const needle = runProbe(gate(30, 1.55));
  assert.equal(needle.threads, 1, "narrow gate must pay exactly one thread");
  assert.equal(needle.world.stats.nearMisses, 2, "both walls of the needle graze");
  assert.ok(needle.threadEvents[0].scoreAward > 0);
  assert.ok(needle.threadEvents[0].tightness > 0.5);

  // Wider gate: no grazes (clearance ~1.85 > near-miss), still a thread.
  const pressed = runProbe(gate(30, 2.6));
  assert.equal(pressed.threads, 1, "pressed pass pair must still thread");
  assert.equal(pressed.world.stats.nearMisses, 0, "pressed passes are not grazes");
  assert.ok(
    pressed.threadEvents[0].scoreAward < needle.threadEvents[0].scoreAward,
    "looser needles pay less",
  );

  // Single edge: a graze on one side only — never a thread.
  const single = runProbe(gate(30, 1.55, -1));
  assert.equal(single.threads, 0, "single-edge graze must never thread");
  assert.equal(single.world.stats.nearMisses, 1);

  // Same-side staggered pair: two grazes, no thread.
  const sameSide = runProbe([
    { s: 30, x: -1.55 - 3, hx: 3, hs: 1 },
    { s: 38, x: -1.55 - 3, hx: 3, hs: 1 },
  ]);
  assert.equal(sameSide.threads, 0, "same-side chain must never thread");
  assert.equal(sameSide.world.stats.nearMisses, 2);

  // Opposite sides but too far apart along-track: no thread.
  const farApart = runProbe([
    { s: 30, x: -1.55 - 3, hx: 3, hs: 1 },
    { s: 30 + THREAD.WINDOW + 8, x: 1.55 + 3, hx: 3, hs: 1 },
  ]);
  assert.equal(farApart.threads, 0, "window must bound thread pairing");
  assert.equal(farApart.world.stats.nearMisses, 2);

  // Wide-open pass (clearance beyond THREAD.CLEARANCE): nothing at all.
  const wide = runProbe(gate(30, 4.2));
  assert.equal(wide.threads, 0);
  assert.equal(wide.world.stats.nearMisses, 0);

  console.log("thread assertions: PASS");
}

// Grazes fund boost: a razor pass pays energy (and more of it while boosting).
{
  const grazeEnergy = (boosting: boolean): number => {
    const world = new SimWorld();
    world.start(endless("graze-energy"));
    world.clearField();
    Object.assign(world.obstacles[0], {
      active: true, kind: "box",
      s: 30, x: -1.2 - 3, hx: 3, hs: 1, y: 1, hy: 2, yaw: 0,
      motion: Motion.None, collidable: true,
      cx: -1.2 - 3, cy: 1, cs: 30, cyaw: 0,
      state: 0, landed: false,
      nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
      patternId: "grazeEnergy",
    });
    const input: InputState = { axis: 0, boost: boosting, dash: false, restart: false, pause: false };
    let award = 0;
    world.events.on("nearMiss", (e) => {
      award = e.energyAward;
      assert.equal(world.boosting, boosting, "probe must pay out in the intended boost state");
    });
    for (let i = 0; i < 600 && world.status === "running"; i++) {
      world.energy = Math.max(world.energy, 60); // Keep the tank from running dry.
      world.update(FIXED_DT, input);
    }
    assert.equal(world.status, "running");
    assert.equal(world.stats.nearMisses, 1, "graze-energy probe must graze exactly once");
    return award;
  };
  const idleAward = grazeEnergy(false);
  const boostAward = grazeEnergy(true);
  assert.ok(Math.abs(idleAward - ENERGY.GRAZE_RAZOR) < 1e-9, `razor graze pays energy (${idleAward})`);
  assert.ok(
    Math.abs(boostAward - ENERGY.GRAZE_RAZOR * ENERGY.BOOST_REFUND) < 1e-9,
    `boosting refund multiplies graze energy (${boostAward})`,
  );
}

// Fixed-step partitioning must not grant slow motion at low render FPS.
{
  const smooth = new SimWorld();
  const chunky = new SimWorld();
  const input: InputState = { axis: 0.2, boost: false, dash: false, restart: false, pause: false };
  smooth.start(endless("frame-partition"));
  chunky.start(endless("frame-partition"));
  for (let i = 0; i < 120; i++) smooth.update(FIXED_DT, input);
  for (let i = 0; i < 10; i++) chunky.update(0.1, input);
  assert.equal(chunky.time, smooth.time);
  assert.equal(chunky.distance, smooth.distance);
  assert.equal(chunky.x, smooth.x);
}

// A fatal collision freezes score/resources and cannot also collect a shard.
{
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const makeDeathProbe = (seed: string) => {
    const world = new SimWorld();
    world.start(endless(seed));
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
      nearMissSide: 0,
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

// --- Phase 2 wall calibration ------------------------------------------------
// The treadmill must never stop: every bot tier has to die (no immortal
// line), and better play has to buy meaningfully more distance — stable,
// distinct walls per tier. Greedy reads one band, lookahead plans across
// two, superhuman tracks the validator's solved path and is limited only by
// steering bandwidth against overdrive speed/density.
{
  type Tier = "greedy" | "lookahead" | "superhuman";
  const TIER_CAP_S: Record<Tier, number> = {
    greedy: 400,
    lookahead: 700,
    superhuman: 1600,
  };

  // Deep-overdrive pool pressure: the wall runs are where the speed-scaled
  // horizon maxes out, so render-pool headroom must be measured here, not
  // just on the 720 m-horizon conservative runs.
  const wallPeakByKind = new Map<string, number>();
  let wallPeakShards = 0;

  const runTier = (tier: Tier, seed: string): number => {
    const world = new SimWorld();
    world.start(endless(seed));
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    const laneMem = { targetX: 0 };
    const maxSteps = Math.floor(TIER_CAP_S[tier] / FIXED_DT);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      if (tier === "greedy") autopilot(world, input);
      else if (tier === "lookahead") lookaheadPilot(world, input, laneMem);
      else superhumanPilot(world, input);
      world.update(FIXED_DT, input);
      if (steps % 120 === 0) {
        const byKind = new Map<string, number>();
        for (const o of world.obstacles) {
          if (o.active) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
        }
        for (const [kind, count] of byKind) {
          wallPeakByKind.set(kind, Math.max(wallPeakByKind.get(kind) ?? 0, count));
        }
        wallPeakShards = Math.max(
          wallPeakShards,
          world.pickups.filter((p) => p.active && p.type === "shard").length,
        );
      }
      steps++;
    }
    assert.equal(
      world.status,
      "dead",
      `${tier}/${seed} must hit a wall before ${TIER_CAP_S[tier]}s of sim ` +
      `(still alive at ${world.distance.toFixed(0)}m — the treadmill capped out)`,
    );
    assert.equal(world.stats.obstacleDrops, 0, `${tier}/${seed} exhausted the obstacle pool`);
    assert.equal(world.stats.pickupDrops, 0, `${tier}/${seed} exhausted the pickup pool`);
    return world.distance;
  };

  const seeds = ["wall-0", "wall-1", "wall-2", "wall-3", "wall-4", "wall-5"];
  // Calibrated 2026-07 (Phase 2 landing; superhuman recalibrated at Phase 3
  // when input quantization landed — the sim consumes a 1/127-step axis now,
  // which nudged the chaotic rollout searcher into a new equilibrium). The
  // sim is deterministic, so these reproduce exactly until tuning constants
  // move — the loose band catches real difficulty regressions either way.
  const WALL_BASELINE: Record<Tier, number> = {
    greedy: 1133,
    lookahead: 2686,
    superhuman: 31547,
  };
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length / 2;
    return s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
  };
  /** Robust stability measure: spread of the seeds left after trimming the
   *  single best and worst run (bots are noisy; the band is the wall). */
  const trimmedSpread = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b).slice(1, -1);
    return s[s.length - 1] / s[0];
  };

  const walls: Record<Tier, number[]> = { greedy: [], lookahead: [], superhuman: [] };
  for (const tier of ["greedy", "lookahead", "superhuman"] as Tier[]) {
    for (const seed of seeds) walls[tier].push(runTier(tier, seed));
    const sorted = [...walls[tier]].sort((a, b) => a - b);
    console.log(
      `wall ${tier.padEnd(10)} ${sorted.map((d) => d.toFixed(0).padStart(6)).join(" ")}  ` +
      `median=${median(walls[tier]).toFixed(0)}m`,
    );
  }

  // Walls are medians over fixed seeds — fully deterministic, so the bands
  // are exactly reproducible; per-seed spread for the heuristic tiers is
  // track luck, bounded loosely to catch degenerate regressions.
  const g = median(walls.greedy);
  const l = median(walls.lookahead);
  const s = median(walls.superhuman);
  assert.ok(
    l > g * 1.5,
    `lookahead wall (${l.toFixed(0)}m) must clear greedy (${g.toFixed(0)}m) by ≥1.5×`,
  );
  assert.ok(
    s > l * 1.5,
    `superhuman wall (${s.toFixed(0)}m) must clear lookahead (${l.toFixed(0)}m) by ≥1.5×`,
  );
  assert.ok(
    s > 8000,
    `superhuman wall (${s.toFixed(0)}m) should die in overdrive territory (>8km) — ` +
    "otherwise Phase 2 scaling is never exercised",
  );
  for (const tier of ["greedy", "lookahead", "superhuman"] as Tier[]) {
    assert.ok(
      trimmedSpread(walls[tier]) < 4.5,
      `${tier} wall is unstable across seeds (trimmed spread ×${trimmedSpread(walls[tier]).toFixed(2)})`,
    );
    const drift = median(walls[tier]) / WALL_BASELINE[tier];
    assert.ok(
      drift > 0.55 && drift < 1.8,
      `${tier} wall drifted ×${drift.toFixed(2)} from its calibrated band ` +
      `(${median(walls[tier]).toFixed(0)}m vs ${WALL_BASELINE[tier]}m)`,
    );
  }

  const wallPools = [...wallPeakByKind.entries()]
    .map(([kind, count]) => `${kind} ${count}/${POOL_SIZES[kind as keyof typeof POOL_SIZES]}`)
    .join(", ");
  console.log(`deep-overdrive render pool peaks: ${wallPools}, shards ${wallPeakShards}`);
  for (const kind of ["box", "pillar", "crystal", "sphere", "ring"] as const) {
    assert.ok(
      (wallPeakByKind.get(kind) ?? 0) < POOL_SIZES[kind],
      `${kind} render pool lacks headroom at max horizon ` +
      `(${wallPeakByKind.get(kind)}/${POOL_SIZES[kind]})`,
    );
  }
  assert.ok(
    wallPeakShards < POOL_SIZES.shard,
    `shard render pool lacks headroom at max horizon (${wallPeakShards})`,
  );
  console.log("wall calibration gate: PASS");
}

// --- Phase 4.2: sprint mode ---------------------------------------------------
// A sprint run that survives its horizon must finish on an exact, replayable
// step: same stats from a re-sim, same finish from a lockstepped ghost, and a
// hard freeze of score/distance at the line.
{
  const config: RunConfig = { mode: "sprint", seed: "sprint-gate" };
  const live = new SimWorld();
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const finishes: { score: number; distance: number }[] = [];
  live.events.on("finish", (e) => finishes.push(e));
  live.start(config);
  assert.equal(live.timeLimit, SPRINT_MODE.DURATION);
  // Superhuman is the only tier that reliably outlives 180 s of real track.
  const maxSteps = Math.floor((SPRINT_MODE.DURATION + 30) / FIXED_DT);
  for (let i = 0; i < maxSteps && live.status === "running"; i++) {
    superhumanPilot(live, input);
    live.update(FIXED_DT, input);
  }
  assert.equal(live.status, "finished", "sprint pilot must survive to the horizon");
  assert.equal(finishes.length, 1, "finish must fire exactly once");
  assert.equal(finishes[0].score, live.stats.score);
  assert.equal(live.stats.deathCause, null, "a finished run has no death cause");
  assert.equal(live.stats.mode, "sprint");
  assert.ok(
    live.stats.duration >= SPRINT_MODE.DURATION - 1e-6 &&
      live.stats.duration <= SPRINT_MODE.DURATION + FIXED_DT + 1e-6,
    `finish must land on the crossing step (${live.stats.duration.toFixed(4)}s)`,
  );

  // The line is the line: nothing accrues after the finish.
  const scoreAtLine = live.score;
  const distanceAtLine = live.distance;
  for (let i = 0; i < 400; i++) live.update(FIXED_DT, input);
  assert.equal(live.score, scoreAtLine, "score must freeze at the finish line");
  assert.equal(live.distance, distanceAtLine, "distance must freeze at the finish line");
  assert.equal(live.buildForensics(), null, "a finished run has no kill-cam");

  // Bit-exact re-simulation of the finish (the finishing step is recorded).
  const rec = live.getRecording();
  assert.ok(rec && rec.complete, "sprint run must produce a complete recording");
  assert.equal(rec.mode, "sprint");
  const replayed = new SimWorld();
  resimulate(rec, replayed);
  assert.equal(replayed.status, "finished", "replay must reproduce the finish");
  assert.deepEqual(replayed.stats, live.stats, "replayed sprint stats must be identical");

  // Ghost lockstep across ragged frames lands on the same finish.
  const ghost = new GhostDriver();
  ghost.arm(rec);
  assert.ok(ghost.active);
  const totalTime = rec.steps * FIXED_DT;
  let clock = 0;
  let frame = 0;
  while (clock < totalTime + 0.1) {
    clock += 1 / 60 + (frame % 7) * 0.003;
    ghost.sync(clock);
    frame++;
  }
  assert.ok(ghost.finished, "sprint ghost must exhaust the recording");
  assert.equal(ghost.world?.status, "finished", "ghost must finish where the run finished");
  assert.equal(ghost.world?.distance, live.distance, "ghost finish distance must be exact");
  console.log(
    `sprint gate: PASS (finished at ${live.distance.toFixed(0)}m, ` +
    `score ${live.stats.score.toLocaleString()}, duration ${live.stats.duration.toFixed(3)}s)`,
  );
}

// --- Phase 4.1: trials --------------------------------------------------------
{
  // Structural sanity across the whole roster.
  const seen = new Set<string>();
  for (const trial of TRIALS) {
    assert.ok(!seen.has(trial.id), `duplicate trial id ${trial.id}`);
    seen.add(trial.id);
    let prev = 0;
    for (const medal of MEDAL_ORDER) {
      assert.ok(
        trial.medals[medal] > prev,
        `${trial.id} medals must strictly increase (${medal})`,
      );
      prev = trial.medals[medal];
    }
    assert.ok(trial.medals.bronze >= 250, `${trial.id} bronze must not be trivial`);
    assert.ok(trial.skills.length > 0, `${trial.id} must declare skills`);
    // Escalation: the trial curve must outrun the ambient treadmill where
    // medals live, and its difficulty must saturate by the ramp's end.
    assert.equal(medalFor(trial, trial.medals.gold), "gold");
    assert.equal(medalFor(trial, trial.medals.bronze - 1), null);
    assert.equal(nextMedalFor(trial, trial.medals.author)?.medal ?? null, null);
    assert.equal(nextMedalFor(trial, 0)?.medal, "bronze");
    assert.ok(trial.difficultyAt(1400) > 0.999, `${trial.id} difficulty must saturate`);
    assert.ok(trial.speedAt(2000) > 80, `${trial.id} speed must escalate`);
  }

  // Calibration gates on three representative trials (deterministic seeds:
  // exact until tuning moves; loose drift bands catch real regressions).
  // Baselines from scripts/trialcal.ts, 2026-07.
  const TRIAL_WALLS: Record<string, { greedy: number; lookahead: number }> = {
    slalomGates: { greedy: 589, lookahead: 932 },
    pistonCorridor: { greedy: 2689, lookahead: 5336 },
    splitDecision: { greedy: 198, lookahead: 918 },
  };
  const CAP_S = { greedy: 240, lookahead: 300 } as const;
  for (const [trialId, baseline] of Object.entries(TRIAL_WALLS)) {
    const trial = TRIALS.find((t) => t.id === trialId)!;
    for (const tier of ["greedy", "lookahead"] as const) {
      const world = new SimWorld();
      world.start({ mode: "trial", seed: trialSeed(trialId), trialId });
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      const mem = { targetX: 0 };
      const chunks = new Map<number, string>();
      const maxSteps = Math.floor(CAP_S[tier] / FIXED_DT);
      for (let i = 0; i < maxSteps && world.status === "running"; i++) {
        if (tier === "greedy") autopilot(world, input);
        else lookaheadPilot(world, input, mem);
        world.update(FIXED_DT, input);
        if (i % 30 === 0) {
          for (const c of world.chunkLog) chunks.set(c.s0, c.patternId);
        }
      }
      assert.equal(
        world.status,
        "dead",
        `${trialId}/${tier} must hit a wall (alive at ${world.distance.toFixed(0)}m)`,
      );
      assert.equal(world.stats.mode, "trial");
      assert.equal(world.stats.trialId, trialId);
      // The trial loops its pattern: chunks are the forced pattern, with the
      // validator's breather fallback as the only other id, and rarely.
      let fallbacks = 0;
      for (const [s0, id] of chunks) {
        assert.ok(
          id === trialId || id === "openField",
          `${trialId}/${tier} generated a foreign chunk ${id} at ${s0.toFixed(0)}m`,
        );
        if (id !== trialId) fallbacks++;
      }
      assert.ok(
        fallbacks / Math.max(1, chunks.size) < 0.15,
        `${trialId}/${tier} breather-fallback share too high (${fallbacks}/${chunks.size})`,
      );
      const drift = world.distance / baseline[tier];
      assert.ok(
        drift > 0.55 && drift < 1.8,
        `${trialId}/${tier} wall drifted ×${drift.toFixed(2)} ` +
        `(${world.distance.toFixed(0)}m vs ${baseline[tier]}m)`,
      );
    }
    // Gold sits in the bot walls' neighborhood; author is aspirational.
    assert.ok(
      trial.medals.gold > baseline.lookahead * 0.5 &&
        trial.medals.gold < baseline.lookahead * 1.7,
      `${trialId} gold (${trial.medals.gold}m) detached from the lookahead wall ` +
      `(${baseline.lookahead}m)`,
    );
    assert.ok(trial.medals.author > baseline.lookahead, `${trialId} author must beat the bots`);
  }

  // A trial run records and re-simulates bit-exactly, like every other mode.
  const live = new SimWorld();
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  live.start({ mode: "trial", seed: trialSeed("slalomGates"), trialId: "slalomGates" });
  const maxSteps = Math.floor(240 / FIXED_DT);
  for (let i = 0; i < maxSteps && live.status === "running"; i++) {
    autopilot(live, input, { boost: true });
    live.update(FIXED_DT, input);
  }
  assert.equal(live.status, "dead");
  const rec = live.getRecording();
  assert.ok(rec && rec.complete, "trial run must produce a recording");
  assert.equal(rec.mode, "trial");
  assert.equal(rec.trialId, "slalomGates");
  const replayed = new SimWorld();
  resimulate(rec, replayed);
  assert.deepEqual(replayed.stats, live.stats, "replayed trial stats must be identical");
  console.log("trial gate: PASS (roster structure, walls, purity, replay exactness)");
}

// --- Phase 4.3: heat modifiers -------------------------------------------------
{
  // Canonicalization + identity: no heat resolves to exact identity knobs.
  assert.deepEqual(normalizeHeat(undefined), []);
  assert.deepEqual(normalizeHeat(["tinHull", "noMagnet", "tinHull", "bogus"]), [
    "noMagnet",
    "tinHull",
  ]);
  assert.equal(resolveHeat([]), NO_HEAT);
  assert.equal(NO_HEAT.scoreMult, 1);
  assert.ok(Math.abs(heatScoreMult(["noMagnet", "tinHull"]) - 1.1 * 1.35) < 1e-12);

  // An explicit empty stack is the same run as no stack at all (bit-exact).
  {
    const plain = new SimWorld();
    const empty = new SimWorld();
    plain.start(endless("heat-identity"));
    empty.start({ mode: "endless", seed: "heat-identity", heat: [] });
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    for (let i = 0; i < 2400; i++) {
      input.axis = Math.sin(i * 0.013) * 0.7;
      plain.update(FIXED_DT, input);
      empty.update(FIXED_DT, input);
    }
    assert.deepEqual(empty.stats, plain.stats, "empty heat stack must be a plain run");
  }

  // Sim-side stacks that do not touch generation (noMagnet + tinHull) leave
  // the track and the flown line identical — passive score scales by exactly
  // the stack multiplier on an empty field.
  {
    const mult = heatScoreMult(["noMagnet", "tinHull"]);
    const cruise = (heat: HeatId[]): number => {
      const world = new SimWorld();
      world.start({ mode: "endless", seed: "heat-cruise", heat });
      world.clearField();
      (world as unknown as { generator: null }).generator = null;
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      for (let i = 0; i < 3600; i++) world.update(FIXED_DT, input);
      assert.equal(world.status, "running");
      return world.score;
    };
    const plain = cruise([]);
    const heated = cruise(["noMagnet", "tinHull"]);
    assert.ok(
      Math.abs(heated / plain - mult) < 1e-9,
      `heat must scale passive score by the stack (${(heated / plain).toFixed(6)} vs ${mult})`,
    );
  }

  // No Magnet: a magnetic shard 3 m off the line is a free catch on a plain
  // run and stays uncollected under heat.
  {
    const magnetProbe = (heat: HeatId[]): number => {
      const world = new SimWorld();
      world.start({ mode: "endless", seed: "heat-magnet", heat });
      world.clearField();
      (world as unknown as { generator: null }).generator = null;
      Object.assign(world.pickups[0], {
        active: true, type: "shard", s: 40, x: 3, y: 1.3,
        seeking: false, magnetic: true, spawnTime: 0,
      });
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      for (let i = 0; i < 600; i++) world.update(FIXED_DT, input);
      return world.stats.shards;
    };
    assert.equal(magnetProbe([]), 1, "plain magnet must reel in the offset shard");
    assert.equal(magnetProbe(["noMagnet"]), 0, "No Magnet must not seek");
  }

  // Tin Hull: even a held shield cannot absorb — contact is death.
  {
    const hullProbe = (heat: HeatId[]): { status: string; shieldBreaks: number } => {
      const world = new SimWorld();
      world.start({ mode: "endless", seed: "heat-hull", heat });
      world.clearField();
      (world as unknown as { generator: null }).generator = null;
      world.hasShield = true;
      Object.assign(world.obstacles[0], {
        active: true, kind: "box",
        s: 30, x: 0, y: 1, hx: 2, hy: 2, hs: 2, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0, collidable: true,
        cx: 0, cy: 1, cs: 30, cyaw: 0,
        state: 0, landed: false,
        nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
        patternId: "heatHull",
      });
      let shieldBreaks = 0;
      world.events.on("shieldBreak", () => shieldBreaks++);
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      for (let i = 0; i < 400 && world.status === "running"; i++) {
        world.update(FIXED_DT, input);
      }
      return { status: world.status, shieldBreaks };
    };
    const plain = hullProbe([]);
    assert.equal(plain.shieldBreaks, 1, "plain shield must absorb the hit");
    assert.equal(plain.status, "running");
    const tin = hullProbe(["tinHull"]);
    assert.equal(tin.shieldBreaks, 0, "Tin Hull must not absorb");
    assert.equal(tin.status, "dead", "Tin Hull contact must be fatal");
  }

  // Generation-side heat: measured over the same three seeds' first 10 km
  // (shield drips are rare events — a single seed is too noisy to gate).
  {
    const survey = (heat: HeatId[]) => {
      let obstacles = 0;
      let shields = 0;
      let moverSpeedSum = 0;
      let movers = 0;
      let gapSum = 0;
      let gaps = 0;
      for (let seedIdx = 0; seedIdx < 3; seedIdx++) {
        const gen = new TrackGenerator(
          createRng(`heat-gen-${seedIdx}`),
          false,
          null,
          resolveHeat(normalizeHeat(heat)),
        );
        let prevS1 = 0;
        while (gen.generatedUpTo < 10000) {
          gen.fill(10000, {
            chunk: (c) => {
              obstacles += c.obstacles.length;
              for (const o of c.obstacles) {
                if (o.motion === Motion.SweepX || o.motion === Motion.RotateYaw || o.motion === Motion.Piston) {
                  moverSpeedSum += Math.abs(o.m0 ?? 0);
                  movers++;
                }
              }
              for (const p of c.pickups) if (p.type === "shield") shields++;
              if (prevS1 > 0) {
                gapSum += c.s0 - prevS1;
                gaps++;
              }
              prevS1 = c.s1;
            },
          });
        }
      }
      return {
        obstacles,
        shields,
        moverSpeed: moverSpeedSum / Math.max(1, movers),
        seam: gapSum / Math.max(1, gaps),
      };
    };
    const plain = survey([]);
    const scarce = survey(["scarceShields"]);
    const dense = survey(["denseField"]);
    const fast = survey(["fastMovers"]);
    assert.ok(plain.shields >= 8, `plain track must drip shields (${plain.shields})`);
    assert.ok(
      scarce.shields < plain.shields * 0.55,
      `Scarce Shields must thin the drip (${scarce.shields} vs ${plain.shields})`,
    );
    assert.ok(
      dense.obstacles > plain.obstacles * 1.05,
      `Dense Field must add geometry (${dense.obstacles} vs ${plain.obstacles})`,
    );
    assert.ok(
      dense.seam < plain.seam * 0.9,
      `Dense Field must shrink seams (${dense.seam.toFixed(1)}m vs ${plain.seam.toFixed(1)}m)`,
    );
    assert.ok(
      fast.moverSpeed > plain.moverSpeed * 1.08,
      `Fast Movers must speed movers (${fast.moverSpeed.toFixed(2)} vs ${plain.moverSpeed.toFixed(2)})`,
    );
    console.log(
      `heat generation survey: shields ${plain.shields}->${scarce.shields}, ` +
      `obstacles ${plain.obstacles}->${dense.obstacles}, ` +
      `seam ${plain.seam.toFixed(1)}m->${dense.seam.toFixed(1)}m, ` +
      `mover speed ${plain.moverSpeed.toFixed(2)}->${fast.moverSpeed.toFixed(2)}`,
    );
  }

  // Narrow Gaps: the validator accepts a tighter corridor under the bias —
  // the guaranteed line gets razor-thin, exactly as advertised. Full-width
  // walls with one center gap, entered from a funneled corridor (as real
  // patterns do — a wide-open entry could never fairly reach one needle).
  {
    const gapWalls = (gap: number): ObstacleSpec[] => {
      const edge = gap / 2;
      const XP = TRACK.X_PATTERN;
      return [
        { kind: "box", s: 2020, x: -(XP + edge) / 2, y: 2, hx: (XP - edge) / 2, hy: 3, hs: 1 },
        { kind: "box", s: 2020, x: (XP + edge) / 2, y: 2, hx: (XP - edge) / 2, hy: 3, hs: 1 },
      ];
    };
    const entry = corridorLanes(0, 4);
    const tight = 3.2; // Passable only with the Narrow Gaps slack reduction.
    const plainV = validatePattern(gapWalls(tight), 2000, 60, entry, 20, false, 0.5, 0);
    const heatV = validatePattern(gapWalls(tight), 2000, 60, entry, 20, false, 0.5, 0.12);
    assert.equal(plainV.ok, false, "baseline slack must reject the razor gap");
    assert.equal(heatV.ok, true, "Narrow Gaps must accept the razor gap");
  }

  // Heated runs replay bit-exactly (the recording carries the stack) and are
  // deterministic across twin worlds.
  {
    const heat = normalizeHeat(["denseField", "fastMovers", "narrowGaps", "tinHull"]);
    const config: RunConfig = { mode: "endless", seed: "heat-replay", heat };
    const live = new SimWorld();
    live.start(config);
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    const maxSteps = Math.floor(240 / FIXED_DT);
    for (let i = 0; i < maxSteps && live.status === "running"; i++) {
      autopilot(live, input, { boost: true });
      live.update(FIXED_DT, input);
    }
    assert.equal(live.status, "dead", "full-stack heat run should find a wall");
    assert.deepEqual(live.stats.heat, heat, "stats must carry the canonical stack");
    const rec = live.getRecording();
    assert.ok(rec && rec.complete);
    assert.deepEqual(rec.heat, heat, "recording must carry the stack");
    const replayed = new SimWorld();
    resimulate(rec, replayed);
    assert.deepEqual(replayed.stats, live.stats, "heated replay must be bit-exact");
    console.log(
      `heat gate: PASS (full stack died at ${live.distance.toFixed(0)}m, ` +
      `×${live.heatFx.scoreMult.toFixed(2)} score)`,
    );
  }
}

// --- Phase 4.4: pilot rating ---------------------------------------------------
{
  // Monotone in distance, anchored to the calibrated walls.
  let prev = -1;
  for (const d of [50, 150, 400, 1133, 2000, 2686, 5000, 8000, 20000, 31547, 100000]) {
    const p = runPerformance(d);
    assert.ok(p >= prev, `runPerformance must be monotone (${d}m)`);
    assert.ok(p >= RATING.FLOOR && p <= RATING.CEIL, "performance must stay clamped");
    prev = p;
  }
  assert.ok(Math.abs(runPerformance(1133) - 1200) < 1, "greedy wall anchor");
  assert.ok(Math.abs(runPerformance(2686) - 1700) < 1, "lookahead wall anchor");
  assert.ok(Math.abs(runPerformance(31547) - 3000) < 1, "superhuman wall anchor");
  assert.ok(Number.isFinite(runPerformance(0)) && Number.isFinite(runPerformance(1e9)));

  // Elo-ish convergence: repeated identical runs settle at the performance;
  // the provisional phase moves faster than the settled phase.
  let rating: number = RATING.START;
  const deltas: number[] = [];
  for (let runs = 0; runs < 40; runs++) {
    const next = updateRating(rating, runs, 2686);
    deltas.push(Math.abs(next - rating));
    rating = next;
  }
  assert.ok(
    Math.abs(rating - 1700) < 60,
    `rating must converge to the run performance (${rating})`,
  );
  assert.ok(
    deltas[0] > deltas[RATING.PROVISIONAL_RUNS + 4] || deltas[RATING.PROVISIONAL_RUNS + 4] === 0,
    "provisional runs must move the needle faster",
  );

  // Tiers are ordered and total.
  for (let i = 1; i < RATING_TIERS.length; i++) {
    assert.ok(RATING_TIERS[i].min > RATING_TIERS[i - 1].min);
  }
  assert.equal(ratingTier(0).name, "DRIFTER");
  assert.equal(ratingTier(runPerformance(31547)).name, "WEAVER");
  console.log(`rating gate: PASS (convergence at ${rating}, ${ratingTier(rating).name})`);
}

// --- Phase 4.5: daily quests ---------------------------------------------------
{
  // Deterministic per day, three distinct templates.
  const dayA = questsForDay("2026-07-13");
  const dayA2 = questsForDay("2026-07-13");
  assert.deepEqual(
    dayA.map((q) => q.id),
    dayA2.map((q) => q.id),
    "the day's quest set must be stable",
  );
  assert.equal(dayA.length, QUESTS_PER_DAY);
  assert.equal(new Set(dayA.map((q) => q.id.split(":")[0])).size, QUESTS_PER_DAY);

  // Rotation: the pool is broad enough that a week of keys varies.
  const sets = new Set<string>();
  for (let d = 10; d < 17; d++) {
    sets.add(questsForDay(`2026-07-${d}`).map((q) => q.id).join("|"));
  }
  assert.ok(sets.size >= 4, `daily quests must rotate (${sets.size}/7 distinct sets)`);

  // Progress functions read a run correctly (synthetic sample).
  const world = new SimWorld();
  world.start(endless("quest-probe"));
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const maxSteps = Math.floor(200 / FIXED_DT);
  for (let i = 0; i < maxSteps && world.status === "running"; i++) {
    autopilot(world, input, { boost: true });
    world.update(FIXED_DT, input);
  }
  assert.equal(world.status, "dead");
  for (const sec of world.stats.sections) {
    assert.ok(
      sec.boostUptime >= 0 && sec.boostUptime <= 1,
      "section boost uptime must be normalized",
    );
  }
  const sample: QuestSample = {
    stats: world.stats,
    counters: { riskShards: 2, fastPerfects: 1 },
  };
  for (let d = 1; d <= 28; d++) {
    for (const q of questsForDay(`2026-07-${String(d).padStart(2, "0")}`)) {
      const p = q.progress(sample);
      assert.ok(Number.isFinite(p) && p >= 0, `quest ${q.id} progress must be sane`);
      assert.ok(q.target > 0, `quest ${q.id} target must be positive`);
      assert.ok(q.label.length > 8, `quest ${q.id} needs a human label`);
    }
  }
  console.log("quest gate: PASS (stable rotation, sane progress functions)");
}

// --- Phase 5: lab prototypes (5.1 surge windows) ------------------------------
{
  // Canonicalization + identity: no lab resolves to all-off flags.
  assert.deepEqual(normalizeLab(undefined), []);
  assert.deepEqual(normalizeLab(["surge", "surge", "bogus"]), ["surge"]);
  assert.equal(resolveLab([]), NO_LAB);
  assert.equal(NO_LAB.surge, false);
  assert.equal(resolveLab(["surge"]).surge, true);

  // An explicit empty lab stack is the same run as no stack at all — and a
  // plain run's recording carries no lab field (persisted ghosts unchanged,
  // byte for byte).
  {
    const plain = new SimWorld();
    const empty = new SimWorld();
    plain.start(endless("lab-identity"));
    empty.start({ mode: "endless", seed: "lab-identity", lab: [] });
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    for (let i = 0; i < 2400; i++) {
      input.axis = Math.sin(i * 0.013) * 0.7;
      input.boost = i % 300 < 120;
      plain.update(FIXED_DT, input);
      empty.update(FIXED_DT, input);
    }
    assert.deepEqual(empty.stats, plain.stats, "empty lab stack must be a plain run");
    const rec = plain.getRecording();
    assert.ok(rec, "identity probe must record");
    assert.ok(!("lab" in rec), "plain recordings must not grow a lab field");
    assert.ok(ghostEligible(rec), "plain recordings stay ghost-eligible");
  }

  // Surge windows pay exactly SURGE.WINDOW of free boost per perfect pass.
  // Controlled field: one hand-placed perfect-graze box; boost held all run.
  // Both arms play identically until the pass, so the boost-time delta is
  // the window itself.
  {
    const perfectBox = (world: SimWorld, s: number): void => {
      // Hull clearance 0.15 m (< PERFECT_CLEARANCE 0.24) at x = 0.
      Object.assign(world.obstacles[0], {
        active: true, kind: "box",
        s, x: 1.9, y: 1, hx: 1, hy: 2, hs: 0.5, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0, collidable: true,
        cx: 1.9, cy: 1, cs: s, cyaw: 0,
        state: 0, landed: false,
        nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
        patternId: "labSurge",
      });
    };
    const surgeProbe = (lab: LabId[]) => {
      const world = new SimWorld();
      world.start({ mode: "endless", seed: "lab-surge", lab });
      world.clearField();
      (world as unknown as { generator: null }).generator = null;
      perfectBox(world, 40);
      let surges = 0;
      world.events.on("surge", (e) => {
        assert.equal(e.window, SURGE.WINDOW);
        surges++;
      });
      const input: InputState = { axis: 0, boost: true, dash: false, restart: false, pause: false };
      for (let i = 0; i < 840; i++) world.update(FIXED_DT, input);
      assert.equal(world.status, "running", "surge probe must survive its lone box");
      assert.equal(world.stats.perfectPasses, 1, "the probe box must land a perfect pass");
      return { surges, boostTime: world.stats.boostTime };
    };
    const plain = surgeProbe([]);
    const surged = surgeProbe(["surge"]);
    assert.equal(plain.surges, 0, "surge must never fire with the lab off");
    assert.ok(surged.surges >= 1, "a perfect pass must open a surge window");
    const delta = surged.boostTime - plain.boostTime;
    assert.ok(
      Math.abs(delta - SURGE.WINDOW) < 0.05,
      `surge must pay exactly the window of free boost (Δ ${delta.toFixed(3)}s vs ${SURGE.WINDOW}s)`,
    );

    // Ignition on an empty meter: with energy pinned to zero every step,
    // boost cannot light before the window and must run exactly through it.
    const world = new SimWorld();
    world.start({ mode: "endless", seed: "lab-surge-zero", lab: ["surge"] });
    world.clearField();
    (world as unknown as { generator: null }).generator = null;
    perfectBox(world, 50);
    let surgeStep = -1;
    world.events.on("surge", () => {
      if (surgeStep < 0) surgeStep = step;
    });
    const input: InputState = { axis: 0, boost: true, dash: false, restart: false, pause: false };
    let step = 0;
    let boostSteps = 0;
    let boostedBeforeSurge = false;
    let boostedAtZeroEnergy = false;
    for (step = 0; step < 1200; step++) {
      world.energy = 0;
      world.update(FIXED_DT, input);
      if (world.boosting) {
        boostSteps++;
        if (surgeStep < 0) boostedBeforeSurge = true;
        if (world.energy <= 0) boostedAtZeroEnergy = true;
      }
    }
    assert.ok(surgeStep > 0, "the zero-energy probe must land its perfect pass");
    assert.equal(world.status, "running");
    assert.ok(!boostedBeforeSurge, "an empty meter must not ignite without a surge");
    assert.ok(boostedAtZeroEnergy, "a surge must ignite the boost on an empty meter");
    const windowSteps = Math.round(SURGE.WINDOW / FIXED_DT);
    assert.ok(
      Math.abs(boostSteps - windowSteps) <= 3,
      `zero-energy boost must last the window (${boostSteps} vs ${windowSteps} steps)`,
    );
    assert.ok(!world.boosting, "boost must die with the window on an empty meter");
    console.log(
      `surge gate: PASS (free window Δ ${delta.toFixed(3)}s; ` +
      `empty-meter ignition ${boostSteps} steps)`,
    );
  }

  // Lab runs replay bit-exactly (the recording carries the stack) and are
  // never eligible as PB ghosts. The greedy bot flies gap centers and never
  // grazes, so the probe uses a "grazer" line instead: hug the nearest gap
  // edge ~0.2 m inside the conservative envelope — on real track that yields
  // perfect passes (and usually a death), both of which the replay must
  // reproduce. Scanned deterministic seeds: the chosen run must surge.
  {
    const grazer = (world: SimWorld, input: InputState): void => {
      const craftS = world.distance;
      const gaps = scanGaps(world, craftS + 2, craftS + 10 + Math.max(world.speed, 20) * 1.35);
      let target = world.x;
      let bestCost = Infinity;
      for (const [g0, g1] of gaps) {
        const center = Math.min(Math.max(world.x, g0 + 1.2), g1 - 1.2);
        const cost = Math.abs(center - world.x) - Math.min(g1 - g0, 10) * 0.4;
        if (cost < bestCost) {
          bestCost = cost;
          // The envelope edge already carries radius + slack of margin;
          // 0.2 m inside it is perfect-pass clearance on static geometry.
          target = Math.abs(world.x - g0) <= Math.abs(world.x - g1) ? g0 - 0.2 : g1 + 0.2;
        }
      }
      steerToward(world, input, target);
      input.boost = world.boosting ? true : world.energy > 14;
    };

    let chosen: string | null = null;
    const maxSteps = Math.floor(240 / FIXED_DT);
    for (let i = 0; i < 6 && !chosen; i++) {
      const seed = `lab-replay-${i}`;
      const live = new SimWorld();
      live.start({ mode: "endless", seed, lab: ["surge"] });
      let surges = 0;
      live.events.on("surge", () => surges++);
      const liveEvents: unknown[] = [];
      live.events.on("nearMiss", (e) => liveEvents.push(["nearMiss", e]));
      live.events.on("surge", (e) => liveEvents.push(["surge", e]));
      live.events.on("death", (e) => liveEvents.push(["death", e]));
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      for (let s = 0; s < maxSteps && live.status === "running"; s++) {
        grazer(live, input);
        live.update(FIXED_DT, input);
      }
      if (surges === 0) continue;
      chosen = seed;

      assert.deepEqual(live.stats.lab, ["surge"], "stats must carry the canonical lab stack");
      const rec = live.getRecording();
      assert.ok(rec && rec.complete, "lab probe must record completely");
      assert.deepEqual(rec.lab, ["surge"], "recording must carry the lab stack");
      assert.ok(!ghostEligible(rec), "lab recordings must never be ghost-eligible");

      const replayed = new SimWorld();
      const replayEvents: unknown[] = [];
      replayed.events.on("nearMiss", (e) => replayEvents.push(["nearMiss", e]));
      replayed.events.on("surge", (e) => replayEvents.push(["surge", e]));
      replayed.events.on("death", (e) => replayEvents.push(["death", e]));
      resimulate(rec, replayed);
      assert.deepEqual(replayed.stats, live.stats, "lab replay must be bit-exact");
      assert.deepEqual(replayEvents, liveEvents, "lab replay event stream must be identical");
      console.log(
        `lab replay gate: PASS (${seed} ${live.status} at ${live.distance.toFixed(0)}m ` +
        `with ${surges} surges, ${live.stats.perfectPasses} perfects; ` +
        `re-sim exact, ghost-ineligible)`,
      );
    }
    assert.ok(chosen, "a scanned seed must produce a surge-active lab run");
  }
}

// --- Phase 5: lab prototypes (5.3 phase dash) ---------------------------------
{
  // The dash bit (512) packs and round-trips without disturbing axis/boost.
  for (const axis of [-1, -0.4, 0, 0.7, 1]) {
    for (const boost of [false, true]) {
      for (const dash of [false, true]) {
        const packed = packInput(axis, boost, dash);
        assert.equal(unpackAxis(packed), quantizeAxis(axis));
        assert.equal(unpackBoost(packed), boost);
        assert.equal(unpackDash(packed), dash);
      }
      // Two-argument packing (every pre-dash call site) never sets the bit.
      assert.equal(unpackDash(packInput(axis, boost)), false);
    }
  }

  // Masking: without the flag a held dash key is inert and the recording is
  // byte-identical to a run that never touched it — persisted ghosts cannot
  // grow the bit.
  {
    const run = (dashKey: boolean) => {
      const world = new SimWorld();
      world.start(endless("dash-mask"));
      const input: InputState = { axis: 0, boost: false, dash: dashKey, restart: false, pause: false };
      for (let i = 0; i < 2400 && world.status === "running"; i++) {
        input.axis = Math.sin(i * 0.011) * 0.8;
        input.boost = i % 400 < 150;
        world.update(FIXED_DT, input);
      }
      return world;
    };
    const clean = run(false);
    const held = run(true);
    assert.deepEqual(held.stats, clean.stats, "a held dash key must be inert without the flag");
    assert.deepEqual(
      held.getRecording()?.data,
      clean.getRecording()?.data,
      "the dash bit must be masked out of plain recordings",
    );
  }

  const dashWorld = (lab: LabId[]): SimWorld => {
    const world = new SimWorld();
    world.start({ mode: "endless", seed: "lab-dash", lab });
    world.clearField();
    (world as unknown as { generator: null }).generator = null;
    return world;
  };
  const freshInput = (): InputState => ({
    axis: 0, boost: false, dash: false, restart: false, pause: false,
  });

  // Displacement, price, cooldown, and direction — measured step-exactly.
  {
    const world = dashWorld(["dash"]);
    const dashes: { x: number; dir: number }[] = [];
    world.events.on("dash", (e) => dashes.push(e));
    const input = freshInput();
    for (let i = 0; i < 240; i++) world.update(FIXED_DT, input);
    world.energy = 60;

    input.axis = 1;
    input.dash = true;
    world.update(FIXED_DT, input); // Rising edge: the burst starts this step.
    assert.equal(world.stats.dashes, 1, "dash must fire on the rising edge");
    assert.equal(dashes[0].dir, 1, "dash direction must follow the held axis");
    assert.ok(Math.abs(world.energy - (60 - DASH.ENERGY)) < 1e-9, "dash must cost its price");

    input.axis = 0;
    input.dash = false;
    const burstSteps = Math.ceil(DASH.TIME / FIXED_DT);
    for (let i = 0; i < burstSteps - 1; i++) world.update(FIXED_DT, input);
    // The burst applies its fixed rate for whole steps: ceil(T/dt) of them.
    const expected = DASH.DISTANCE * ((burstSteps * FIXED_DT) / DASH.TIME);
    const moved = world.x - dashes[0].x;
    assert.ok(
      Math.abs(moved - expected) < 0.05,
      `dash displacement must be the authored burst (${moved.toFixed(2)} vs ${expected.toFixed(2)})`,
    );
    assert.ok(world.dashTimer === 0, "burst must be over");
    assert.ok(
      Math.abs(world.latVel) <= (DASH.DISTANCE / DASH.TIME) * DASH.EXIT_MOMENTUM + 1e-9,
      "burst must end as a reposition, not a fling",
    );

    // Cooldown: an immediate second press is refused, a post-cooldown one fires.
    world.energy = 60;
    input.axis = 1;
    input.dash = true;
    world.update(FIXED_DT, input);
    assert.equal(world.stats.dashes, 1, "cooldown must gate the second dash");
    assert.ok(Math.abs(world.energy - 60) < 1e-9, "a refused dash must cost nothing");
    input.dash = false;
    for (let i = 0; i < Math.ceil(DASH.COOLDOWN / FIXED_DT) + 2; i++) {
      world.update(FIXED_DT, input);
    }
    world.energy = 60;
    input.axis = -1;
    input.dash = true;
    world.update(FIXED_DT, input);
    input.dash = false;
    assert.equal(world.stats.dashes, 2, "dash must fire again after the cooldown");
    assert.equal(dashes[1].dir, -1, "second dash must follow the new direction");
  }

  // Refusals: no direction, no fuel, no flag.
  {
    const neutral = dashWorld(["dash"]);
    const input = freshInput();
    for (let i = 0; i < 240; i++) neutral.update(FIXED_DT, input);
    neutral.energy = 60;
    input.dash = true; // axis stays 0 — no direction, no dash
    neutral.update(FIXED_DT, input);
    assert.equal(neutral.stats.dashes, 0, "a neutral axis must refuse the dash");
    assert.ok(Math.abs(neutral.energy - 60) < 1e-9);

    const broke = dashWorld(["dash"]);
    const brokeInput = freshInput();
    for (let i = 0; i < 240; i++) broke.update(FIXED_DT, brokeInput);
    broke.energy = DASH.ENERGY - 1;
    brokeInput.axis = 1;
    brokeInput.dash = true;
    broke.update(FIXED_DT, brokeInput);
    assert.equal(broke.stats.dashes, 0, "an underfunded dash must be refused");

    const off = dashWorld([]);
    const offInput = freshInput();
    for (let i = 0; i < 240; i++) off.update(FIXED_DT, offInput);
    off.energy = 60;
    offInput.axis = 1;
    offInput.dash = true;
    off.update(FIXED_DT, offInput);
    assert.equal(off.stats.dashes, 0, "dash must be inert without its flag");
    assert.ok(Math.abs(off.energy - 60) < 1e-9);
  }

  // No i-frames: dashing into a wall is death, exactly as advertised.
  {
    const world = dashWorld(["dash"]);
    Object.assign(world.obstacles[0], {
      active: true, kind: "box",
      s: 70, x: 6.5, y: 1, hx: 1, hy: 2, hs: 40, yaw: 0,
      motion: Motion.None, m0: 0, m1: 0, m2: 0, collidable: true,
      cx: 6.5, cy: 1, cs: 70, cyaw: 0,
      state: 0, landed: false,
      nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
      patternId: "dashWall",
    });
    const input = freshInput();
    while (world.status === "running" && world.distance < 55) {
      world.update(FIXED_DT, input);
    }
    world.energy = 60;
    input.axis = 1;
    input.dash = true;
    for (let i = 0; i < 30 && world.status === "running"; i++) {
      world.update(FIXED_DT, input);
    }
    assert.equal(world.stats.dashes, 1, "the wall probe must actually dash");
    assert.equal(world.status, "dead", "no i-frames: a dash into a wall must kill");
    assert.equal(world.stats.deathCause?.patternId, "dashWall");
    console.log("dash gate: PASS (burst, price, cooldown, refusals, lethal wall)");
  }
}

// --- Phase 5: lab prototypes (5.4 rhythm resonance) ----------------------------
{
  // Beat-window boundaries (pure).
  assert.equal(onBeatAt(0), true);
  assert.equal(onBeatAt(RESONANCE_BEAT), true);
  assert.equal(onBeatAt(RESONANCE_BEAT * 7.5), false);
  assert.equal(onBeatAt(RESONANCE_BEAT * 3 + RESONANCE.WINDOW - 1e-4), true);
  assert.equal(onBeatAt(RESONANCE_BEAT * 3 + RESONANCE.WINDOW + 1e-4), false);
  assert.equal(onBeatAt(RESONANCE_BEAT * 5 - RESONANCE.WINDOW + 1e-4), true);

  // resonatePattern: rates land on the beat grid (period = beat × 2^k),
  // phases on quarter cycles, amplitudes/lengths/radii untouched.
  {
    const box = (
      s: number,
      motion: ObstacleSpec["motion"],
      m0: number,
      m1: number,
      m2: number,
    ): ObstacleSpec => ({
      kind: "box", s, x: 0, y: 1, hx: 1, hy: 1, hs: 1, motion, m0, m1, m2,
    });
    const result: PatternResult = {
      length: 100, exitX: 0, exitHalf: 10, pickups: [],
      obstacles: [
        box(10, Motion.SweepX, 0.57, 1.1, 3.3),
        box(20, Motion.Piston, 0.83, 0.37, -4),
        box(30, Motion.RotateYaw, 1.7, 0.4, 0),
        box(40, Motion.OrbitXZ, 5, 0.9, 2.2),
        box(50, Motion.Pendulum, 6, 0.8, 1.3),
        box(60, Motion.None, 0.123, 0.456, 0.789),
      ],
    };
    resonatePattern(result, RESONANCE.BPM);
    const beat = RESONANCE_BEAT;
    const onGrid = (beats: number) =>
      Math.abs(Math.log2(beats) - Math.round(Math.log2(beats))) < 1e-9;
    const quarter = (v: number, cycle: number) =>
      Math.abs(v / (cycle / 4) - Math.round(v / (cycle / 4))) < 1e-9;
    const [sweep, piston, rotor, orbit, pend, still] = result.obstacles;
    assert.ok(onGrid((2 * Math.PI) / (Math.abs(sweep.m0!) * beat)), "sweep rate on grid");
    assert.ok(quarter(sweep.m1!, 2 * Math.PI), "sweep phase on quarter turns");
    assert.equal(sweep.m2, 3.3, "sweep amplitude untouched");
    assert.ok(onGrid(1 / (Math.abs(piston.m0!) * beat)), "piston rate on grid (cycles)");
    assert.ok(quarter(piston.m1!, 1), "piston phase on quarter cycles");
    assert.equal(piston.m2, -4, "piston throw untouched");
    assert.ok(onGrid((2 * Math.PI) / (Math.abs(rotor.m0!) * beat)), "rotor rate on grid");
    assert.equal(rotor.m1, 0.4, "rotor initial yaw untouched");
    assert.equal(orbit.m0, 5, "orbit radius untouched");
    assert.ok(onGrid((2 * Math.PI) / (Math.abs(orbit.m1!) * beat)), "orbit rate on grid");
    assert.ok(quarter(orbit.m2!, 2 * Math.PI), "orbit phase on quarter turns");
    assert.equal(pend.m0, 6, "pendulum length untouched");
    assert.equal(pend.m1, 0.8, "pendulum swing untouched");
    assert.ok(onGrid((2 * Math.PI) / (Math.abs(pend.m2!) * beat)), "pendulum rate on grid");
    assert.deepEqual(
      [still.m0, still.m1, still.m2],
      [0.123, 0.456, 0.789],
      "static obstacles untouched",
    );
  }

  // Live grading: on a controlled field of perfect passes, the resonant flag
  // must equal the beat grid at the confirmation step, resonant awards must
  // pay exactly ×BONUS over the flag-off twin, and both outcomes must occur.
  {
    const probe = (lab: LabId[]) => {
      const world = new SimWorld();
      world.start({ mode: "endless", seed: "lab-resonant", lab });
      world.clearField();
      (world as unknown as { generator: null }).generator = null;
      for (let i = 0; i < 12; i++) {
        Object.assign(world.obstacles[i], {
          active: true, kind: "box",
          s: 40 + i * 37, x: 1.9, y: 1, hx: 1, hy: 2, hs: 0.5, yaw: 0,
          motion: Motion.None, m0: 0, m1: 0, m2: 0, collidable: true,
          cx: 1.9, cy: 1, cs: 40 + i * 37, cyaw: 0,
          state: 0, landed: false,
          nearMissed: false, nearMissClearance: Infinity, nearMissSide: 0,
          patternId: "labResonance",
        });
      }
      const events: { resonant: boolean; onBeat: boolean; scoreAward: number; grade: string }[] =
        [];
      world.events.on("nearMiss", (e) =>
        events.push({
          resonant: e.resonant,
          onBeat: onBeatAt(world.time),
          scoreAward: e.scoreAward,
          grade: e.grade,
        }),
      );
      const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
      for (let i = 0; i < 2600 && world.status === "running"; i++) world.update(FIXED_DT, input);
      assert.equal(world.status, "running", "resonant probe must survive its boxes");
      assert.equal(events.length, 12, "every probe box must confirm a pass");
      return { events, stats: world.stats };
    };
    const off = probe([]);
    const on = probe(["resonance"]);
    for (const e of off.events) assert.equal(e.resonant, false, "no resonance without the flag");
    assert.equal(off.stats.resonantPasses, 0);
    let resonants = 0;
    on.events.forEach((e, i) => {
      assert.equal(
        e.resonant,
        e.grade === "perfect" && e.onBeat,
        "resonant flag must match the beat grid at confirmation",
      );
      if (e.resonant) {
        resonants++;
        assert.ok(
          Math.abs(e.scoreAward - off.events[i].scoreAward * RESONANCE.BONUS) <= 1,
          `resonant award must be ×${RESONANCE.BONUS} (${e.scoreAward} vs ${off.events[i].scoreAward})`,
        );
      } else {
        assert.equal(e.scoreAward, off.events[i].scoreAward, "off-beat awards must be unchanged");
      }
    });
    assert.ok(
      resonants >= 1 && resonants < on.events.length,
      `probe must sample both outcomes (${resonants}/${on.events.length} resonant)`,
    );
    assert.equal(on.stats.resonantPasses, resonants);
    console.log(`resonance gate: PASS (grid boundaries, ${resonants}/12 resonant, ×1.25 exact)`);
  }
}

// --- Phase 5: full lab stack replay -------------------------------------------
// Everything at once — surge + dash + resonance on a real generated track,
// with dash taps in the stream: the recording must re-simulate bit-exactly
// (the dash bit rides in the pack) and stay ghost-ineligible.
{
  const config: RunConfig = {
    mode: "endless",
    seed: "lab-full",
    lab: normalizeLab(["resonance", "dash", "surge"]),
  };
  const live = new SimWorld();
  live.start(config);
  const liveEvents: unknown[] = [];
  live.events.on("nearMiss", (e) => liveEvents.push(["nearMiss", e]));
  live.events.on("thread", (e) => liveEvents.push(["thread", e]));
  live.events.on("surge", (e) => liveEvents.push(["surge", e]));
  live.events.on("dash", (e) => liveEvents.push(["dash", e]));
  live.events.on("death", (e) => liveEvents.push(["death", e]));
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const maxSteps = Math.floor(240 / FIXED_DT);
  for (let i = 0; i < maxSteps && live.status === "running"; i++) {
    // Alternate boost-on/off phases (5 s each): off-phases let the meter
    // climb past the dash price, so periodic taps actually fire.
    autopilot(live, input, { boost: Math.floor(i / 600) % 2 === 1 });
    // Tap dash every ~1.7 s with a forced direction so presses are honest
    // rising edges that sometimes catch a funded meter.
    input.dash = i % 200 === 0 && i > 0;
    if (input.dash) input.axis = input.axis >= 0 ? 1 : -1;
    live.update(FIXED_DT, input);
  }
  assert.deepEqual(live.stats.lab, ["dash", "resonance", "surge"], "canonical full stack");
  assert.ok(live.stats.dashes >= 1, `full-stack probe must dash (${live.stats.dashes})`);
  const rec = live.getRecording();
  assert.ok(rec && rec.complete, "full-stack run must record");
  assert.deepEqual(rec.lab, ["dash", "resonance", "surge"], "recording carries the stack");
  // (Kept out of assert.ok: the type guard would narrow `rec` to never.)
  const eligible = ghostEligible(rec);
  assert.equal(eligible, false, "full-stack recordings must never be ghosts");
  let dashBits = 0;
  for (let i = 0; i < rec.data.length; i += 2) if (unpackDash(rec.data[i])) dashBits++;
  assert.ok(dashBits >= 1, "the dash bit must actually ride in the stream");

  const replayed = new SimWorld();
  const replayEvents: unknown[] = [];
  replayed.events.on("nearMiss", (e) => replayEvents.push(["nearMiss", e]));
  replayed.events.on("thread", (e) => replayEvents.push(["thread", e]));
  replayed.events.on("surge", (e) => replayEvents.push(["surge", e]));
  replayed.events.on("dash", (e) => replayEvents.push(["dash", e]));
  replayed.events.on("death", (e) => replayEvents.push(["death", e]));
  resimulate(rec, replayed);
  assert.deepEqual(replayed.stats, live.stats, "full-stack replay must be bit-exact");
  assert.deepEqual(replayEvents, liveEvents, "full-stack event stream must be identical");
  console.log(
    `full lab stack gate: PASS (${live.status} at ${live.distance.toFixed(0)}m, ` +
    `${live.stats.dashes} dashes, ${live.stats.resonantPasses} resonant, ` +
    `${live.stats.perfectPasses} perfects; re-sim exact)`,
  );
}
