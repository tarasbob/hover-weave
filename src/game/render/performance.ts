/** Bounded rolling measurements. Recording a frame does not allocate. */
export class TimingWindow {
  private readonly values: Float64Array;
  private cursor = 0;
  private count = 0;

  constructor(capacity = 240) {
    this.values = new Float64Array(capacity);
  }

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.values[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.values.length;
    this.count = Math.min(this.count + 1, this.values.length);
  }

  clear(): void {
    this.cursor = 0;
    this.count = 0;
  }

  snapshot(): { samples: number; mean: number; p95: number; p99: number } {
    if (this.count === 0) return { samples: 0, mean: 0, p95: 0, p99: 0 };
    const sorted = this.values.slice(0, this.count).sort();
    const mean = sorted.reduce((sum, value) => sum + value, 0) / this.count;
    return {
      samples: this.count,
      mean,
      p95: sorted[Math.ceil(this.count * 0.95) - 1],
      p99: sorted[Math.ceil(this.count * 0.99) - 1],
    };
  }
}

/**
 * Time-based hysteresis, independent of HUD updates and display refresh rate.
 * Prefer fresh GPU work over presentation cadence: a CPU stall or a 30 Hz
 * display should not blur an otherwise inexpensive GPU frame. Without timer
 * support, sustained frame pressure is the conservative fallback.
 */
export class ResolutionController {
  scale = 1;
  private pressureMs = 16.67;
  private cooldown = 2;

  constructor(private readonly minimum: number) {}

  update(frameMs: number, gpuMs: number | null, active: boolean): number {
    if (!active || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) {
      this.cooldown = 2;
      this.pressureMs = 16.67;
      return this.scale;
    }
    const dt = frameMs / 1000;
    const measured = gpuMs !== null && Number.isFinite(gpuMs) && gpuMs > 0
      ? gpuMs : frameMs;
    this.pressureMs += (measured - this.pressureMs) * (1 - Math.exp(-dt / 0.5));
    this.cooldown -= dt;
    if (this.cooldown > 0) return this.scale;

    if (this.pressureMs > 20 && this.scale > this.minimum) {
      this.scale = Math.max(this.minimum, Math.round((this.scale - 0.05) * 100) / 100);
      this.cooldown = 1.5;
    } else if (this.pressureMs < 14 && this.scale < 1) {
      this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
      this.cooldown = 3;
    }
    return this.scale;
  }
}

export type GpuTimingStatus = "pending" | "available" | "unsupported" | "unavailable";

/** Narrow adapter keeps three's backend-specific timestamp switch in one place. */
export interface GpuTimerSource {
  supported: boolean;
  setTracking(enabled: boolean): void;
  resolve(): Promise<number | undefined>;
}

/**
 * Sample one complete render pipeline, then stop issuing queries until its
 * asynchronous readback finishes. This avoids GPU fences in the render loop,
 * unbounded pending promises, and overlapping WebGL query-pool resets.
 */
export class GpuFrameTimer {
  status: GpuTimingStatus;
  private pending = false;
  private sampling = false;
  private disposed = false;
  private nextSampleAt = 0;
  private sampledAt = -Infinity;
  private valueAt = -Infinity;
  private value: number | null = null;
  private generation = 0;
  readonly timings = new TimingWindow(120);

  constructor(private readonly source: GpuTimerSource) {
    this.status = source.supported ? "pending" : "unsupported";
    source.setTracking(false);
  }

  begin(now: number, active: boolean): void {
    if (this.disposed || this.pending || !active || now < this.nextSampleAt ||
        this.status === "unsupported" || this.status === "unavailable") return;
    this.sampling = true;
    this.sampledAt = now;
    this.source.setTracking(true);
  }

  end(): void {
    if (!this.sampling) return;
    this.sampling = false;
    this.pending = true;
    const generation = this.generation;
    this.nextSampleAt = this.sampledAt + 250;
    // Start resolution before disabling tracking: three checks the switch
    // synchronously at the entry to resolveTimestampsAsync().
    const resolution = this.source.resolve();
    this.source.setTracking(false);
    void resolution.then((ms) => {
      if (this.disposed || generation !== this.generation) return;
      if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
        this.value = ms;
        this.valueAt = this.sampledAt;
        this.timings.add(ms);
        this.status = "available";
      } else {
        this.value = null;
        this.status = "unavailable";
      }
    }).catch(() => {
      if (!this.disposed && generation === this.generation) {
        this.value = null;
        this.status = "unavailable";
      }
    }).finally(() => { this.pending = false; });
  }

  latest(now: number): number | null {
    return now - this.valueAt <= 1500 ? this.value : null;
  }

  resetSamples(): void {
    this.generation++;
    this.value = null;
    this.valueAt = -Infinity;
    this.timings.clear();
    if (this.status === "available") this.status = "pending";
  }

  dispose(): void {
    this.disposed = true;
    this.source.setTracking(false);
  }
}
