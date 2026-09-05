/** Bounded rolling measurements. Recording a frame does not allocate. */
export class TimingWindow {
  private readonly values: Float64Array;
  private cursor = 0;
  private count = 0;

  constructor(capacity = 240, private readonly allowZero = false) {
    this.values = new Float64Array(capacity);
  }

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || (ms === 0 && !this.allowZero)) return;
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
export type GpuPassCoverage = "individual" | "aggregate" | "none";

export interface GpuPassSample {
  name: string;
  gpuMs: number;
  /** Multiple invocations of the same pass are summed within one frame. */
  passes: number;
}

export interface GpuFrameSample {
  totalMs: number | undefined;
  passes: GpuPassSample[];
  coverage: GpuPassCoverage;
  /** Submitted render labels, including passes without their own GPU query. */
  submittedPasses: string[];
}

export interface GpuPassStats extends GpuPassSample {
  meanMs: number;
  p95Ms: number;
  samples: number;
}

/** Narrow adapter keeps three's backend-specific timestamp switch in one place. */
export interface GpuTimerSource {
  supported: boolean;
  setTracking(enabled: boolean): void;
  resolve(): Promise<number | undefined | GpuFrameSample>;
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
  private readonly passWindows = new Map<string, TimingWindow>();
  private passes: GpuPassSample[] = [];
  private passCoverage: GpuPassCoverage = "none";
  private submitted: string[] = [];
  private submittedAt = -Infinity;

  constructor(private readonly source: GpuTimerSource) {
    this.status = source.supported ? "pending" : "unsupported";
    source.setTracking(false);
  }

  begin(now: number, active: boolean): void {
    if (this.disposed || this.pending || !active || now < this.nextSampleAt ||
        this.status === "unsupported") return;
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
    void resolution.then((sample) => {
      if (this.disposed || generation !== this.generation) return;
      const ms = typeof sample === "object" ? sample.totalMs : sample;
      this.submitted = typeof sample === "object" ? [...new Set(sample.submittedPasses)].slice(0, 256) : [];
      this.submittedAt = this.sampledAt;
      if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
        this.value = ms;
        this.valueAt = this.sampledAt;
        this.timings.add(ms);
        this.status = "available";
        this.passes = typeof sample === "object" ? sample.passes.slice(0, 64) : [];
        this.passCoverage = typeof sample === "object" ? sample.coverage : "aggregate";
        for (const pass of this.passes) {
          if (!this.passWindows.has(pass.name) && this.passWindows.size < 64) {
            // Timestamp quantization can report a valid zero-cost pass.
            this.passWindows.set(pass.name, new TimingWindow(120, true));
          }
          this.passWindows.get(pass.name)?.add(pass.gpuMs);
        }
      } else {
        this.value = null;
        this.status = "unavailable";
        this.passCoverage = "none";
        this.passes = [];
      }
    }).catch(() => {
      if (!this.disposed && generation === this.generation) {
        this.value = null;
        this.status = "unavailable";
        this.passCoverage = "none";
        this.passes = [];
      }
    }).finally(() => { this.pending = false; });
  }

  latest(now: number): number | null {
    return now - this.valueAt <= 1500 ? this.value : null;
  }

  sampleAt(now: number): number | null {
    return this.latest(now) === null ? null : this.valueAt;
  }

  coverage(now: number): GpuPassCoverage {
    return this.latest(now) === null ? "none" : this.passCoverage;
  }

  submittedPasses(now: number): string[] {
    return now - this.submittedAt <= 1500 ? [...this.submitted] : [];
  }

  submissionAt(now: number): number | null {
    return now - this.submittedAt <= 1500 ? this.submittedAt : null;
  }

  passSnapshot(now: number): GpuPassStats[] {
    if (this.latest(now) === null) return [];
    return this.passes.map((pass) => {
      const stats = this.passWindows.get(pass.name)?.snapshot();
      return { ...pass, meanMs: stats?.mean ?? 0, p95Ms: stats?.p95 ?? 0, samples: stats?.samples ?? 0 };
    });
  }

  resetSamples(): void {
    this.generation++;
    this.value = null;
    this.valueAt = -Infinity;
    this.timings.clear();
    this.passWindows.clear();
    this.passes = [];
    this.passCoverage = "none";
    this.submitted = [];
    this.submittedAt = -Infinity;
    if (this.status === "available") this.status = "pending";
  }

  dispose(): void {
    this.disposed = true;
    this.source.setTracking(false);
  }
}
