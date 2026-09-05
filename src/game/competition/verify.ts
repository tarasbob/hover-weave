/** Node-only implementation. Untrusted callers use verifyFlightInWorker. */
import { createHash } from "node:crypto";
import { FIXED_DT } from "../core/constants";
import type { InputState } from "../core/input";
import { unpackAxis, unpackBoost, type RunRecording } from "../core/replay";
import { SimWorld } from "../core/world";
import {
  competitionRunConfig, selectCompetitionCourse, VERIFICATION_LIMITS, VERIFIER_VERSION,
  type CompetitionCourse, type CompetitionSelection,
} from "./manifest";

export type VerificationCode = "payload" | "course" | "season-closed" | "stream" |
  "nonterminal" | "trailing-input" | "summary" | "timeout" | "unavailable";

export class VerificationError extends Error {
  constructor(readonly code: VerificationCode, message: string) { super(message); }
}

export interface VerifiedFlight {
  verified: true;
  verifierVersion: number;
  seasonId: string;
  seasonRevision: number;
  courseId: string;
  courseRevision: number;
  courseKey: string;
  simulationVersion: string;
  replayVersion: number;
  /** Stable over equivalent exports: excludes client timestamps and highlight. */
  runId: string;
  score: number;
  distance: number;
  steps: number;
  duration: number;
  terminal: "dead" | "finished";
  /** Trusted receipt time, not the timestamp from the uploaded recording. */
  receivedAt: number;
}

function fail(code: VerificationCode, message: string): never {
  throw new VerificationError(code, message);
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("payload", `Malformed ${label}`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("payload", `Unknown ${label} field`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Validate before creating a world or expanding the RLE stream. */
export function validateCompetitionFlight(text: string, selected: CompetitionCourse, replayVersion: number): RunRecording {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > VERIFICATION_LIMITS.bytes) {
    fail("payload", "Flight exceeds the 2 MiB payload limit");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("payload", "Flight is not valid JSON"); }
  const envelope = object(parsed, ["format", "recording", "highlight"], "envelope");
  if (envelope.format !== "hover-weave-flight") fail("payload", "Unknown flight format");
  const rec = object(envelope.recording, [
    "v", "seed", "mode", "trialId", "heat", "lab", "steps", "complete", "data", "score", "distance", "at",
  ], "recording");
  if (rec.v !== replayVersion || rec.complete !== true) fail("payload", "Incomplete or incompatible recording");
  if (!integer(rec.steps, 1, Math.min(selected.maxSteps, VERIFICATION_LIMITS.steps))) fail("stream", "Run exceeds the course step limit");
  if (!integer(rec.score, 0, Number.MAX_SAFE_INTEGER) ||
    typeof rec.distance !== "number" || !Number.isFinite(rec.distance) || rec.distance < 0 ||
    !integer(rec.at, 0, Number.MAX_SAFE_INTEGER)) fail("payload", "Malformed result metadata");
  if (rec.mode !== selected.mode || rec.seed !== selected.seed || rec.trialId !== selected.trialId) {
    fail("course", "Recording does not match the server-owned mode, seed, and trial");
  }
  if (rec.lab !== undefined && (!Array.isArray(rec.lab) || rec.lab.length !== 0)) fail("course", "Lab runs are unranked");
  const heat = rec.heat === undefined ? [] : rec.heat;
  if (!Array.isArray(heat) || heat.length !== selected.heat.length ||
    heat.some((id, i) => typeof id !== "string" || id !== selected.heat[i])) {
    fail("course", "Recording does not match the canonical modifier stack");
  }
  const highlight = object(envelope.highlight, ["startStep", "endStep"], "highlight");
  if (!integer(highlight.startStep, 0, rec.steps) ||
    !integer(highlight.endStep, highlight.startStep, rec.steps)) fail("payload", "Malformed highlight bounds");
  if (!Array.isArray(rec.data) || rec.data.length === 0 || rec.data.length % 2 !== 0 ||
    rec.data.length > VERIFICATION_LIMITS.rleNumbers) fail("stream", "Malformed or oversized input stream");
  let steps = 0;
  for (let i = 0; i < rec.data.length; i += 2) {
    const packed = rec.data[i];
    const run = rec.data[i + 1];
    // Low byte 255 is not a quantized axis. Dash is not a ranked input.
    if (!integer(packed, 0, 510) || (packed & 255) === 255 ||
      !integer(run, 1, rec.steps) || (i > 0 && rec.data[i - 2] === packed)) {
      fail("stream", "Input contains an invalid encoding or noncanonical run");
    }
    steps += run;
    if (steps > rec.steps) fail("stream", "Input length exceeds its declared step count");
  }
  if (steps !== rec.steps) fail("stream", "Input length does not match its declared step count");
  // No unchecked config fields, getters, prototypes, or client objects enter the sim.
  return {
    v: replayVersion, ...competitionRunConfig(selected),
    steps: rec.steps, complete: true, data: rec.data as number[],
    score: rec.score, distance: rec.distance, at: rec.at,
  };
}

/**
 * Synchronous core for the isolated worker and deterministic tests. Receipt time
 * is supplied by the trusted host. Never expose this on a request event loop.
 */
export function verifyCompetitionFlight(text: string, selection: CompetitionSelection, receivedAt = Date.now()): VerifiedFlight {
  let policy: ReturnType<typeof selectCompetitionCourse>;
  try { policy = selectCompetitionCourse(selection); }
  catch (error) { fail("course", error instanceof Error ? error.message : "Unknown course"); }
  const { season, course, courseKey } = policy;
  if (!integer(receivedAt, season.opensAt, season.closesAt - 1)) fail("season-closed", "Season is not accepting submissions at server receipt time");
  const rec = validateCompetitionFlight(text, course, season.replayVersion);
  const deadline = performance.now() + VERIFICATION_LIMITS.wallTimeMs;
  const world = new SimWorld();
  world.recordInputs = false;
  world.start(competitionRunConfig(course));
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  let steps = 0;
  for (let i = 0; i < rec.data.length; i += 2) {
    input.axis = unpackAxis(rec.data[i]);
    input.boost = unpackBoost(rec.data[i]);
    for (let left = rec.data[i + 1]; left > 0; left--) {
      if (world.status !== "running") fail("trailing-input", "Input continues after the first terminal tick");
      if (steps % 120 === 0 && performance.now() > deadline) fail("timeout", "Verification exceeded its time budget");
      world.update(FIXED_DT, input);
      steps++;
    }
  }
  const terminal = world.status;
  if (terminal !== "dead" && terminal !== "finished") fail("nonterminal", "Recording ends before death or the sprint finish");
  if (!Number.isSafeInteger(world.stats.score) || !Number.isFinite(world.stats.distance) ||
    rec.score !== world.stats.score || rec.distance !== world.stats.distance) {
    fail("summary", "Claimed score or distance does not match authoritative simulation");
  }
  return {
    verified: true, verifierVersion: VERIFIER_VERSION,
    seasonId: season.id, seasonRevision: season.revision,
    courseId: course.id, courseRevision: course.revision, courseKey,
    simulationVersion: season.simulationVersion, replayVersion: season.replayVersion,
    runId: createHash("sha256").update(JSON.stringify([courseKey, steps, rec.data])).digest("hex"),
    score: world.stats.score, distance: world.stats.distance, steps,
    duration: steps * FIXED_DT, terminal, receivedAt,
  };
}
