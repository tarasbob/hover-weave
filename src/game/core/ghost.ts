import { FIXED_DT, MAX_STEPS_PER_FRAME } from "./constants";
import type { InputState } from "./input";
import { clamp01, lerp } from "./mathUtils";
import { ReplayCursor, type RunRecording } from "./replay";
import { SimWorld } from "./world";

export interface GhostPose {
  x: number;
  distance: number;
  bank: number;
}

/**
 * Drives a spectral SimWorld through a saved recording in lockstep with the
 * live run's sim clock (roadmap 3.2). Daily ghosts share the live seed — a
 * true spatial ghost on identical geometry. Endless ghosts re-fly their own
 * recorded track, so they render as a pace ghost (may pass through the live
 * run's obstacles by design).
 */
export class GhostDriver {
  world: SimWorld | null = null;
  recording: RunRecording | null = null;
  /** True once the recording is exhausted or the ghost's run ended. */
  finished = false;
  private cursor: ReplayCursor | null = null;
  private readonly input: InputState = {
    axis: 0, boost: false, restart: false, pause: false,
  };

  /** Arm for a new run (null or an incomplete recording disarms). */
  arm(recording: RunRecording | null): void {
    this.recording = recording && recording.complete ? recording : null;
    this.finished = false;
    this.cursor = this.recording ? new ReplayCursor(this.recording) : null;
    if (this.recording) {
      if (!this.world) {
        this.world = new SimWorld();
        this.world.recordInputs = false;
      }
      this.world.start(this.recording.seed, this.recording.daily);
    } else if (this.world) {
      this.world.status = "idle";
      this.world.clearField();
    }
  }

  get active(): boolean {
    return this.recording !== null && this.world !== null && this.world.status !== "idle";
  }

  /** Step the ghost sim up to the live run's sim clock. */
  sync(liveTime: number): void {
    const world = this.world;
    const cursor = this.cursor;
    if (!world || !cursor || !this.recording || this.finished) return;
    let guard = 0;
    while (
      world.status === "running" &&
      world.time < liveTime - 1e-9 &&
      guard++ < MAX_STEPS_PER_FRAME * 2
    ) {
      if (!cursor.next(this.input)) {
        this.finished = true;
        break;
      }
      world.update(FIXED_DT, this.input);
    }
    if (world.status !== "running") this.finished = true;
  }

  /** Live distance delta in meters (positive = you are ahead of the ghost). */
  deltaTo(liveDistance: number): number | null {
    if (!this.recording || !this.world || this.world.status === "idle") return null;
    return liveDistance - this.world.distance;
  }

  /**
   * Ghost pose interpolated to the live run's render clock
   * (`world.time - (1 - alpha) * FIXED_DT`), so the spectral craft moves as
   * smoothly as the player's.
   */
  poseAt(liveRenderTime: number): GhostPose | null {
    const w = this.world;
    if (!w || !this.recording || w.status === "idle") return null;
    const a = clamp01(1 - (w.time - liveRenderTime) / FIXED_DT);
    return {
      x: lerp(w.prevX, w.x, a),
      distance: lerp(w.prevDistance, w.distance, a),
      bank: lerp(w.prevBank, w.bank, a),
    };
  }
}
