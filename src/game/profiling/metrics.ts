/** A fixed-size histogram: every sample contributes, even after long captures. */
export class ProfileDistribution {
  private bins = new Uint32Array(10_001);
  private sum = 0;
  private count = 0;
  private maximum = 0;
  private slow16 = 0;
  private slow33 = 0;
  private overflow = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.sum += ms;
    this.maximum = Math.max(this.maximum, ms);
    if (ms > 1000 / 60) this.slow16++;
    if (ms > 1000 / 30) this.slow33++;
    if (ms > 1000) this.overflow++;
    this.bins[Math.min(10_000, Math.ceil(ms * 10))]++;
  }

  snapshot() {
    const percentile = (fraction: number) => {
      if (!this.count) return null;
      const target = Math.ceil(this.count * fraction);
      let seen = 0;
      for (let i = 0; i < this.bins.length; i++) {
        seen += this.bins[i];
        if (seen >= target) return i === 10_000 && this.overflow ? this.maximum : i / 10;
      }
      return this.maximum;
    };
    return {
      samples: this.count,
      meanMs: this.count ? this.sum / this.count : null,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
      maxMs: this.count ? this.maximum : null,
      over16_67Ms: this.slow16, over33_33Ms: this.slow33, overflowSamples: this.overflow,
    };
  }
}

export type DistributionSummary = ReturnType<ProfileDistribution["snapshot"]>;

/** The fixed upper bounds are part of the export contract. */
export const PROFILE_LIMITS = {
  maxSeconds: 900, maxSeries: 900, maxEvents: 2000, maxInputs: 512,
  maxNotes: 32, maxPasses: 64, histogramResolutionMs: 0.1, histogramCeilingMs: 1000,
} as const;
