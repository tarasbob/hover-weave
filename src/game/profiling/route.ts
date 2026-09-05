import { FIXED_DT, MAX_STEPS_PER_FRAME } from "../core/constants";
import type { InputState } from "../core/input";
import { recordingConfig, ReplayCursor, REPLAY_VERSION, type RunRecording } from "../core/replay";
import type { SimWorld } from "../core/world";
import fixture from "./route.json";

export const PROFILE_ROUTE = fixture;
const recording = fixture.recording as RunRecording;

/** Play the checked-in input stream against the real world, including collisions. */
export class ProfileRouteDriver {
  private cursor = new ReplayCursor(recording);
  private accumulator = 0;
  private steps = 0;
  loops = 0;
  totalSteps = 0;
  failed: string | null = null;
  private readonly input: InputState = {
    axis: 0, boost: false, dash: false, restart: false, pause: false,
  };

  constructor(private world: SimWorld) {
    if (recording.v !== REPLAY_VERSION) throw new Error("Profiling route needs rebaking for this replay version");
    this.resetRoute();
  }

  private resetRoute(): void {
    this.world.start(recordingConfig(recording));
    this.cursor.reset();
    this.steps = 0;
  }

  advance(dt: number): void {
    if (this.failed) return;
    this.accumulator += Math.min(Math.max(dt, 0), 0.25);
    let budget = MAX_STEPS_PER_FRAME;
    while (this.accumulator + 1e-10 >= FIXED_DT && budget-- > 0) {
      if (this.steps === recording.steps) {
        if (Math.abs(this.world.distance - recording.distance) > 1e-7 || this.world.stats.score !== recording.score) {
          this.failed = "Route replay diverged from its recorded result";
          return;
        }
        this.loops++;
        this.resetRoute();
      }
      if (!this.cursor.next(this.input)) {
        this.failed = "Route recording ended unexpectedly";
        return;
      }
      this.world.update(FIXED_DT, this.input);
      this.steps++;
      this.totalSteps++;
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      if (this.world.status !== "running") {
        this.failed = `Route ended ${this.world.status} at step ${this.steps}`;
        return;
      }
    }
    if (budget < 0 && this.accumulator >= FIXED_DT) this.accumulator = 0;
  }
}
