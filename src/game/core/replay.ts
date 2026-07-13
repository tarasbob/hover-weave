/**
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

export const REPLAY_VERSION = 1;

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

/** Pack a (quantized) axis + boost flag into one small integer (0..510). */
export function packInput(axis: number, boost: boolean): number {
  return (Math.round(quantizeAxis(axis) * AXIS_LEVELS) + AXIS_LEVELS) | (boost ? 256 : 0);
}

export function unpackAxis(packed: number): number {
  return ((packed & 255) - AXIS_LEVELS) / AXIS_LEVELS;
}

export function unpackBoost(packed: number): boolean {
  return (packed & 256) !== 0;
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

  /** Record one fixed step. `axis` must already be quantized. */
  record(axis: number, boost: boolean): void {
    if (!this.enabled || !this.complete) return;
    const packed = packInput(axis, boost);
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
  const input: InputState = { axis: 0, boost: false, restart: false, pause: false };
  let step = 0;
  while (cursor.next(input)) {
    world.update(FIXED_DT, input);
    step++;
    onStep?.(world, step);
  }
  return world;
}
