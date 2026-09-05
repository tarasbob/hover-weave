/**
 * v8: broad seeded S bends and lethal track edges replace the gentle wander
 * and lateral barrier. Collision results now capture wreck motion. Previous
 * input streams require their original simulation and cannot be replayed here.
 *
 * Input recording + replay (roadmap 3.1).
 *
 * The sim is deterministic at a fixed 120 Hz, so a run is fully described by
 * its seed and the per-step (axis, boost) stream. The stream is quantized
 * (axis to 1/127 steps — the sim itself consumes the quantized value, which
 * is what makes replays bit-exact) and RLE-compressed: keyboard play holds
 * values for hundreds of steps, so a full run is a few KB.
 */

import { FIXED_DT } from "./constants";
import type { HeatId } from "./heat";
import type { LabId } from "./lab";
import type { InputState } from "./input";
import type { GameMode, RunConfig } from "./modes";
import type { SimWorld } from "./world";

/**
 * v7: first-flight weave encounters replace the repeated empty opening.
 * Endless/daily/sprint course streams change; v6 ghosts must be discarded.
 * Fixed trial geometry and calibration remain unchanged.
 *
 * v6: the double jump (fun-frontier 6.2) — a mid-air boost tap now fires an
 * impulse, the sky cadence guarantee and kicker patterns reshaped every
 * endless course, and SOFT_VY moved — so v5 streams no longer re-simulate.
 *
 * v5: skyhook ramps went mainline (fun-frontier 6.1) — ramp patterns joined
 * the generation pools (shifting every endless course at a given seed) and
 * the craft gained vertical state (ride/launch/dive/flare), so v4 streams no
 * longer re-simulate.
 *
 * v4: boost steering authority now follows continuous thrust charge and
 * carve pump strength follows reversal quality, so old input streams can
 * produce different trajectories.
 *
 * v3: rhythm resonance went mainline (fun-frontier 2.1) — every mover now
 * rides the 116 BPM beat grid and perfects grade resonant on every run, so
 * v2 streams no longer re-simulate. (v2: the winding course, glass/bumper/
 * beam obstacles, the Leviathan, and run events.)
 */
export const REPLAY_VERSION = 8;

/** Axis quantization levels per side (index -127..127). */
export const AXIS_LEVELS = 127;

/**
 * RLE stream cap (numbers, i.e. pairs × 2). Bounds memory/localStorage for
 * degenerate ultra-long runs; a recording that hits it is marked incomplete
 * and never persisted as a ghost.
 */
const MAX_RLE_NUMBERS = 240_000;

/** Quantize a raw axis to the exact value the sim consumes and records. */
export function quantizeAxis(axis: number): number {
  const a = axis < -1 ? -1 : axis > 1 ? 1 : axis;
  return Math.round(a * AXIS_LEVELS) / AXIS_LEVELS;
}

/**
 * Pack a (quantized) axis + boost + dash into one small integer (0..1022).
 * The dash bit (512) is only ever set on Phase Dash lab runs — the sim masks
 * it otherwise — so plain-run streams are byte-identical to pre-dash builds.
 */
export function packInput(axis: number, boost: boolean, dash = false): number {
  return (
    (Math.round(quantizeAxis(axis) * AXIS_LEVELS) + AXIS_LEVELS) |
    (boost ? 256 : 0) |
    (dash ? 512 : 0)
  );
}

export function unpackAxis(packed: number): number {
  return ((packed & 255) - AXIS_LEVELS) / AXIS_LEVELS;
}

export function unpackBoost(packed: number): boolean {
  return (packed & 256) !== 0;
}

export function unpackDash(packed: number): boolean {
  return (packed & 512) !== 0;
}

export interface RunRecording {
  v: number;
  seed: string;
  mode: GameMode;
  /** Trial roster id (mode === "trial" only). */
  trialId?: string;
  /** Heat stack the run was flown under (endless only; omitted = none). */
  heat?: HeatId[];
  /**
   * Lab prototype stack (endless only; omitted = none). Carried so lab runs
   * re-simulate exactly — but they are never eligible as PB ghosts.
   */
  lab?: LabId[];
  /** Total fixed steps recorded (steps taken while the run was alive). */
  steps: number;
  /** False if the stream was truncated by the size cap (not replayable). */
  complete: boolean;
  /** RLE stream: [packedInput, runLength, packedInput, runLength, ...]. */
  data: number[];
  /** Result summary (for PB comparison / listings without re-simming). */
  score: number;
  distance: number;
  /** Epoch ms when the run ended. */
  at: number;
}

/** The RunConfig a recording replays under (recordings never carry skipTo). */
export function recordingConfig(rec: RunRecording): RunConfig {
  const config: RunConfig = { mode: rec.mode, seed: rec.seed };
  if (rec.trialId !== undefined) config.trialId = rec.trialId;
  if (rec.heat && rec.heat.length > 0) config.heat = [...rec.heat];
  if (rec.lab && rec.lab.length > 0) config.lab = [...rec.lab];
  return config;
}

/**
 * May this recording serve as a PB ghost? Current version, complete stream,
 * and no lab stack — lab prototypes are unranked sandboxes and never persist.
 */
export function ghostEligible(rec: RunRecording | null | undefined): rec is RunRecording {
  return Boolean(
    rec &&
      rec.v === REPLAY_VERSION &&
      rec.mode &&
      rec.complete &&
      rec.steps > 0 &&
      (!rec.lab || rec.lab.length === 0),
  );
}

/** Per-fixed-step recorder owned by the sim. */
export class InputRecorder {
  private data: number[] = [];
  private lastPacked = -1;
  private enabled = false;
  steps = 0;
  complete = true;

  reset(enabled: boolean): void {
    this.data.length = 0;
    this.lastPacked = -1;
    this.steps = 0;
    this.enabled = enabled;
    this.complete = true;
  }

  /** Record one fixed step. `axis` must already be quantized, `dash` masked. */
  record(axis: number, boost: boolean, dash = false): void {
    if (!this.enabled || !this.complete) return;
    const packed = packInput(axis, boost, dash);
    if (packed === this.lastPacked && this.data.length > 0) {
      this.data[this.data.length - 1]++;
    } else {
      if (this.data.length >= MAX_RLE_NUMBERS) {
        this.complete = false;
        return;
      }
      this.data.push(packed, 1);
      this.lastPacked = packed;
    }
    this.steps++;
  }

  toRecording(config: RunConfig, score: number, distance: number): RunRecording | null {
    if (!this.enabled || this.steps === 0) return null;
    const rec: RunRecording = {
      v: REPLAY_VERSION,
      seed: config.seed,
      mode: config.mode,
      steps: this.steps,
      complete: this.complete,
      data: [...this.data],
      score,
      distance,
      at: Date.now(),
    };
    if (config.mode === "trial" && config.trialId !== undefined) rec.trialId = config.trialId;
    if (config.heat && config.heat.length > 0) rec.heat = [...config.heat];
    if (config.lab && config.lab.length > 0) rec.lab = [...config.lab];
    return rec;
  }
}

/** Streaming reader over a recording's RLE data. */
export class ReplayCursor {
  private i = 0;
  private packed = 0;
  private left = 0;

  constructor(private readonly rec: RunRecording) {}

  reset(): void {
    this.i = 0;
    this.left = 0;
  }

  /** Write the next recorded step into `input`; false once exhausted. */
  next(input: InputState): boolean {
    if (this.left === 0) {
      if (this.i >= this.rec.data.length) return false;
      this.packed = this.rec.data[this.i];
      this.left = this.rec.data[this.i + 1];
      this.i += 2;
    }
    this.left--;
    input.axis = unpackAxis(this.packed);
    input.boost = unpackBoost(this.packed);
    input.dash = unpackDash(this.packed);
    return true;
  }
}

/**
 * Re-simulate a recording on the given world (one fixed step per recorded
 * frame — `update(FIXED_DT)` runs exactly one step). Reproduces the original
 * run bit-exactly: same stats, same events, same death (or sprint finish).
 */
export function resimulate(
  rec: RunRecording,
  world: SimWorld,
  onStep?: (world: SimWorld, step: number) => void,
): SimWorld {
  world.recordInputs = false;
  world.start(recordingConfig(rec));
  const cursor = new ReplayCursor(rec);
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  let step = 0;
  while (cursor.next(input)) {
    world.update(FIXED_DT, input);
    step++;
    onStep?.(world, step);
  }
  return world;
}

const FLIGHT_FORMAT = "hover-weave-flight";

interface FlightEnvelope {
  format: typeof FLIGHT_FORMAT;
  recording: RunRecording;
  /** Automatically selected high-input-density witness window. */
  highlight: FlightHighlight;
}

export interface FlightHighlight {
  startStep: number;
  endStep: number;
}

/**
 * Pick a compact witness window without re-simulating: reversals, modulation,
 * and boost transitions are weighted above passive holds.
 */
export function selectFlightHighlight(
  rec: RunRecording,
  seconds = 20,
): FlightHighlight {
  const window = Math.max(1, Math.round(seconds / FIXED_DT));
  const segments: {
    start: number;
    end: number;
    passive: number;
    edge: number;
    prefix: number;
  }[] = [];
  let prevAxis = 0;
  let prevBoost = false;
  let step = 0;
  let total = 0;
  for (let i = 0; i < rec.data.length; i += 2) {
    const packed = rec.data[i];
    const run = rec.data[i + 1];
    const axis = unpackAxis(packed);
    const boost = unpackBoost(packed);
    const passive = Math.abs(axis) * 0.04;
    const edge =
      Math.abs(axis - prevAxis) * 2 +
      (boost !== prevBoost ? 1.5 : 0) +
      passive;
    segments.push({ start: step, end: step + run, passive, edge, prefix: total });
    total += edge + Math.max(0, run - 1) * passive;
    step += run;
    prevAxis = axis;
    prevBoost = boost;
  }
  const prefixAt = (at: number): number => {
    const target = Math.max(0, Math.min(step, at));
    if (target <= 0 || segments.length === 0) return 0;
    if (target >= step) return total;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].end < target) lo = mid + 1;
      else hi = mid;
    }
    const segment = segments[lo];
    const consumed = Math.max(0, target - segment.start);
    return (
      segment.prefix +
      (consumed > 0 ? segment.edge + Math.max(0, consumed - 1) * segment.passive : 0)
    );
  };
  const candidates = new Set<number>([Math.min(window, step), step]);
  for (const segment of segments) {
    for (const boundary of [segment.start + 1, segment.end]) {
      candidates.add(Math.max(0, Math.min(step, boundary)));
      candidates.add(Math.max(0, Math.min(step, boundary + window)));
    }
  }
  let bestSum = -1;
  let bestEnd = Math.min(window, step);
  for (const end of candidates) {
    const sum = prefixAt(end) - prefixAt(end - window);
    if (sum > bestSum) {
      bestSum = sum;
      bestEnd = end;
    }
  }
  return {
    startStep: Math.max(0, bestEnd - window),
    endStep: Math.min(rec.steps, bestEnd),
  };
}

/** Portable, human-shareable wrapper around the deterministic input stream. */
export function serializeFlight(rec: RunRecording): string {
  if (!ghostEligible(rec)) {
    throw new Error("Only complete, current-version ranked flights can be exported");
  }
  const envelope: FlightEnvelope = {
    format: FLIGHT_FORMAT,
    recording: rec,
    highlight: selectFlightHighlight(rec),
  };
  return JSON.stringify(envelope);
}

/** Parse and strictly validate an imported `.flight` payload. */
export function parseFlight(text: string): RunRecording {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Invalid flight file");
  const envelope = value as Partial<FlightEnvelope>;
  if (envelope.format !== FLIGHT_FORMAT) throw new Error("Unknown flight format");
  const rec = envelope.recording;
  if (!rec || !ghostEligible(rec)) {
    throw new Error("Flight is incomplete, unranked, or from an incompatible version");
  }
  if (
    typeof rec.seed !== "string" ||
    !["endless", "daily", "sprint", "trial"].includes(rec.mode) ||
    !Number.isFinite(rec.score) ||
    !Number.isFinite(rec.distance) ||
    !Array.isArray(rec.data) ||
    rec.data.length % 2 !== 0
  ) {
    throw new Error("Flight metadata is malformed");
  }
  let steps = 0;
  for (let i = 0; i < rec.data.length; i += 2) {
    const packed = rec.data[i];
    const run = rec.data[i + 1];
    if (
      !Number.isInteger(packed) ||
      packed < 0 ||
      packed > 1023 ||
      !Number.isInteger(run) ||
      run <= 0
    ) {
      throw new Error("Flight input stream is malformed");
    }
    steps += run;
  }
  if (steps !== rec.steps) throw new Error("Flight input length does not match its summary");
  const copy: RunRecording = {
    ...rec,
    data: [...rec.data],
  };
  if (rec.heat) copy.heat = [...rec.heat];
  else delete copy.heat;
  delete copy.lab;
  return copy;
}

export function flightFilename(rec: RunRecording): string {
  const safeMode = rec.mode.replace(/[^a-z0-9-]/gi, "-");
  return `hover-weave-${safeMode}-${Math.round(rec.distance)}m.flight`;
}
