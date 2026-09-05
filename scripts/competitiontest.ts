import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { serializeFlight } from "../src/game/core/replay";
import { SimWorld } from "../src/game/core/world";
import {
  competitionCourseKey, competitionRunConfig, COMPETITION_SEASONS,
  selectCompetitionCourse, VERIFICATION_LIMITS,
} from "../src/game/competition/manifest";
import { verifyFlightInWorker } from "../src/game/competition/server";
import { VerificationError, verifyCompetitionFlight, type VerificationCode } from "../src/game/competition/verify";
import { autopilot } from "./pilots";

const receivedAt = Date.UTC(2026, 8, 5, 12);
const selection = { seasonId: "2026-preview-v9", courseId: "trial-slalomGates" };
const { season, course, courseKey } = selectCompetitionCourse(selection);

function record(courseId: string, pilot = false): { world: SimWorld; payload: string } {
  const chosen = selectCompetitionCourse({ ...selection, courseId }).course;
  const world = new SimWorld();
  world.start(competitionRunConfig(chosen));
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  for (let step = 0; step < chosen.maxSteps && world.status === "running"; step++) {
    if (pilot) autopilot(world, input);
    world.update(FIXED_DT, input);
  }
  assert.notEqual(world.status, "running", `${courseId}: fixture must be terminal`);
  const recording = world.getRecording();
  assert.ok(recording);
  return { world, payload: serializeFlight(recording) };
}

const { world, payload } = record(selection.courseId);
type Envelope = ReturnType<typeof JSON.parse>;
function changed(mutate: (value: Envelope) => void): string {
  const value = JSON.parse(payload);
  mutate(value);
  return JSON.stringify(value);
}

function rejects(text: string, code: VerificationCode, label: string): void {
  assert.throws(() => verifyCompetitionFlight(text, selection, receivedAt),
    (error) => error instanceof VerificationError && error.code === code, label);
}

async function main(): Promise<void> {
  const result = verifyCompetitionFlight(payload, selection, receivedAt);
  assert.equal(result.score, world.stats.score);
  assert.equal(result.distance, world.stats.distance);
  assert.equal(result.terminal, "dead");
  assert.equal(result.duration, result.steps * FIXED_DT);
  assert.equal(result.courseKey, courseKey);
  assert.equal(result.receivedAt, receivedAt);
  assert.deepEqual([result.steps, result.score, result.distance], [782, 441, 219.9782198540227],
    "v9-r1 neutral trial fingerprint: changing rules requires version review");
  assert.deepEqual(await verifyFlightInWorker(payload, selection, { receivedAt }), result,
    "isolated Node worker must reproduce the deterministic result");

  rejects(changed((v) => { v.recording.score++; }), "summary", "claimed score tampering");
  rejects(changed((v) => { v.recording.distance += 0.000001; }), "summary", "even small distance tampering");
  rejects(changed((v) => { v.recording.seed = "cheaper-course"; }), "course", "seed substitution");
  rejects(changed((v) => { v.recording.mode = "endless"; }), "course", "mode substitution");
  rejects(changed((v) => { v.recording.trialId = "__proto__"; }), "course", "trial substitution");
  rejects(changed((v) => { delete v.recording.trialId; }), "course", "missing trial");
  rejects(changed((v) => { v.recording.v--; }), "payload", "old replay version");
  rejects(changed((v) => { v.recording.v = 700; }), "payload", "future replay version");
  rejects(changed((v) => { v.recording.complete = "true"; }), "payload", "truthy incomplete flag");
  rejects(changed((v) => { v.recording.complete = false; }), "payload", "truncated local recorder");
  rejects(changed((v) => { v.recording.skipTo = 9000; }), "payload", "skip-to bypass");
  rejects(changed((v) => { v.recording.lab = ["surge"]; }), "course", "Lab physics");
  rejects(changed((v) => { v.recording.lab = {}; }), "course", "malformed Lab stack");
  rejects(changed((v) => { v.recording.heat = ["tinHull"]; }), "course", "modifier substitution");
  rejects(changed((v) => { v.recording.heat = ""; }), "course", "malformed modifier stack");
  rejects(changed((v) => { v.recording.heat = null; }), "course", "null modifier stack");
  rejects(changed((v) => { v.recording.at = -1; }), "payload", "invalid timestamp");
  rejects(changed((v) => { v.recording.score = -1; }), "payload", "negative score");
  rejects(changed((v) => { v.recording.distance = null; }), "payload", "nonfinite distance");
  rejects(changed((v) => { v.highlight.endStep = v.recording.steps + 1; }), "payload", "highlight outside recording");
  rejects(changed((v) => { v.format = "another-format"; }), "payload", "wrong envelope");
  rejects("null", "payload", "null payload");
  rejects("{", "payload", "broken JSON");
  rejects(payload.replace('"recording":{', '"recording":{"__proto__":{},'), "payload", "unknown prototype field");
  rejects(" ".repeat(VERIFICATION_LIMITS.bytes + 1), "payload", "bounded bytes before parsing");
  rejects(changed((v) => { v.recording.data[0] = 255; }), "stream", "out-of-range quantized axis");
  rejects(changed((v) => { v.recording.data[0] = 511; }), "stream", "out-of-range boosted axis");
  rejects(changed((v) => { v.recording.data[0] |= 512; }), "stream", "unranked dash bit");
  rejects(changed((v) => { v.recording.data[0] = -1; }), "stream", "negative packed input");
  rejects(changed((v) => { v.recording.data[0] = 1.5; }), "stream", "fractional packed input");
  rejects(changed((v) => { v.recording.data[1] = 0; }), "stream", "zero RLE length");
  rejects(changed((v) => { v.recording.data[1] = -1; }), "stream", "negative RLE length");
  rejects(changed((v) => { v.recording.data[1] = 0.5; }), "stream", "fractional RLE length");
  rejects(changed((v) => { v.recording.data[1] = Number.MAX_SAFE_INTEGER; }), "stream", "RLE expansion denial of service");
  rejects(changed((v) => { v.recording.data.push(0); }), "stream", "odd RLE length");
  rejects(changed((v) => { v.recording.steps++; }), "stream", "step-summary mismatch");
  rejects(changed((v) => { v.recording.steps = VERIFICATION_LIMITS.steps + 1; }), "stream", "bounded simulation work");
  rejects(changed((v) => { v.recording.data = Array(VERIFICATION_LIMITS.rleNumbers + 2).fill(1); }), "stream", "bounded pair count");
  rejects(changed((v) => {
    v.recording.data = [127, 1]; v.recording.steps = 1;
    v.highlight = { startStep: 0, endStep: 1 };
  }), "nonterminal", "surviving prefix cannot be a result");
  rejects(changed((v) => {
    v.recording.steps++; v.recording.data[v.recording.data.length - 1]++;
  }), "trailing-input", "extra tick after terminal state");
  rejects(changed((v) => {
    v.recording.data = [127, 1, 127, v.recording.steps - 1];
  }), "stream", "noncanonical adjacent RLE pairs");

  const rewritten = verifyCompetitionFlight(changed((v) => {
    v.recording.at = 0; v.highlight = { startStep: 0, endStep: 0 };
  }), selection, receivedAt);
  assert.equal(rewritten.runId, result.runId, "client time/highlight cannot evade deduplication");
  assert.equal(rewritten.receivedAt, receivedAt, "client timestamp is not receipt time");
  for (const time of [season.opensAt - 1, season.closesAt]) {
    assert.throws(() => verifyCompetitionFlight(payload, selection, time),
      (error) => error instanceof VerificationError && error.code === "season-closed");
  }
  assert.equal(verifyCompetitionFlight(payload, selection, season.opensAt).verified, true);
  assert.throws(() => verifyCompetitionFlight(payload, { ...selection, seasonId: "unknown" }, receivedAt));
  assert.throws(() => verifyCompetitionFlight(payload, { ...selection, courseId: "unknown" }, receivedAt));
  assert.notEqual(competitionCourseKey({ ...season, id: "2027" }, course), courseKey);
  assert.notEqual(competitionCourseKey({ ...season, revision: 2 }, course), courseKey);
  assert.notEqual(competitionCourseKey({ ...season, simulationVersion: "hover-weave-v8-r1" }, course), courseKey);
  assert.notEqual(competitionCourseKey({ ...season, replayVersion: 10 }, course), courseKey);
  assert.notEqual(competitionCourseKey(season, { ...course, revision: 2 }), courseKey);
  assert.notEqual(competitionCourseKey(season, { ...course, seed: "different" }), courseKey);
  assert.notEqual(competitionCourseKey(season, { ...course, heat: ["tinHull"] }), courseKey);
  assert.notEqual(competitionCourseKey(season, { ...course, maxSteps: 100 }), courseKey);
  assert.equal(new Set(COMPETITION_SEASONS.flatMap((item) =>
    item.courses.map((entry) => competitionCourseKey(item, entry)))).size,
    COMPETITION_SEASONS.reduce((count, item) => count + item.courses.length, 0));
  for (const seasonId of ["2026-preview", "2026-preview-v8"]) {
    assert.throws(() => selectCompetitionCourse({ ...selection, seasonId }),
      /archived simulation/, `${seasonId}: historical policy cannot silently use v9 physics`);
  }
  assert.ok(Object.isFrozen(season) && Object.isFrozen(course) && Object.isFrozen(course.heat));

  // Static synthetic fixture: validates a genuine finish without regenerating
  // the slow TAS pilot, and fails if this version's course/physics silently drift.
  for (const version of [7, 8]) {
    const oldSprint = readFileSync(new URL(`../src/game/competition/fixtures/sprint-v${version}.flight`, import.meta.url), "utf8");
    rejects(oldSprint, "payload", `v${version} input streams require their original simulation`);
  }
  const sprintPayload = readFileSync(new URL("../src/game/competition/fixtures/sprint-v9.flight", import.meta.url), "utf8");
  const sprintSelection = { ...selection, courseId: "sprint-2026-w36" };
  const finished = verifyCompetitionFlight(sprintPayload, sprintSelection, receivedAt);
  assert.deepEqual([finished.terminal, finished.steps, finished.duration, finished.score, finished.distance],
    ["finished", 21600, 180, 52025, 10886.403309815998]);
  const sprintPrefix = JSON.parse(sprintPayload);
  sprintPrefix.recording.steps--;
  const prefixData = sprintPrefix.recording.data;
  if (--prefixData[prefixData.length - 1] === 0) prefixData.splice(-2);
  sprintPrefix.highlight.endStep = Math.min(sprintPrefix.highlight.endStep, sprintPrefix.recording.steps);
  assert.throws(() => verifyCompetitionFlight(JSON.stringify(sprintPrefix), sprintSelection, receivedAt),
    (error) => error instanceof VerificationError && error.code === "nonterminal", "tick before sprint finish is not terminal");

  for (const courseId of ["daily-2026-09-05", "endless-reference", "heat-reference", "sprint-2026-w36"]) {
    const sample = record(courseId, courseId === "sprint-2026-w36");
    const verified = verifyCompetitionFlight(sample.payload, { ...selection, courseId }, receivedAt);
    assert.equal(verified.score, sample.world.stats.score);
    assert.equal(verified.distance, sample.world.stats.distance);
    if (courseId === "heat-reference") {
      const altered = JSON.parse(sample.payload);
      altered.recording.heat.reverse();
      assert.throws(() => verifyCompetitionFlight(JSON.stringify(altered), { ...selection, courseId }, receivedAt),
        (error) => error instanceof VerificationError && error.code === "course");
    }
    console.log(`${courseId}: ${verified.terminal}, ${verified.steps} ticks, ${Math.round(verified.distance)} m`);
  }
  await assert.rejects(verifyFlightInWorker(payload, selection, { receivedAt, timeoutMs: 1 }),
    (error) => error instanceof VerificationError && error.code === "timeout", "host kills over-budget worker");
  await assert.rejects(verifyFlightInWorker(changed((v) => { v.recording.score++; }), selection, { receivedAt }),
    (error) => error instanceof VerificationError && error.code === "summary", "worker propagates rejection");
  const workers = [
    verifyFlightInWorker(payload, selection, { receivedAt }),
    verifyFlightInWorker(payload, selection, { receivedAt }),
  ];
  await assert.rejects(verifyFlightInWorker(payload, selection, { receivedAt }),
    (error) => error instanceof VerificationError && error.code === "unavailable", "bounded worker concurrency");
  assert.deepEqual(await Promise.all(workers), [result, result]);
  console.log("Competition verification: canonical results, strict hostile-input rejection, course/season isolation and bounded workers passed.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
