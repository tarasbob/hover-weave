import * as THREE from "three/webgpu";

export const TRAIL_POINTS = 44;
export const TRAIL_SAMPLE_INTERVAL = 1 / 60;
const HISTORY_CAPACITY = TRAIL_POINTS - 1;

/**
 * A fixed simulation-time wake, independent of display refresh rate. History
 * lives in a ring buffer; the render loop never allocates or shifts objects.
 */
export class TrailRibbon {
  readonly geometry = new THREE.BufferGeometry();
  readonly positions = new Float32Array(TRAIL_POINTS * 4 * 3);
  private readonly samples = new Float64Array(HISTORY_CAPACITY * 4);
  private readonly ages = new Float32Array(TRAIL_POINTS * 4);
  private count = 0;
  private head = 0;
  private nextSample = 0;
  private lastTime = Number.NaN;
  private lastX = 0;
  private lastY = 0;
  private lastS = 0;

  constructor() {
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      for (const off of [0, TRAIL_POINTS * 2]) {
        const a = off + i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geometry.setIndex(indices);
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aT",
      new THREE.BufferAttribute(this.ages, 1).setUsage(THREE.DynamicDrawUsage),
    );
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.lastTime = Number.NaN;
  }

  private sample(x: number, y: number, s: number, time: number): void {
    const offset = this.head * 4;
    this.samples[offset] = x;
    this.samples[offset + 1] = y;
    this.samples[offset + 2] = s;
    this.samples[offset + 3] = time;
    this.head = (this.head + 1) % HISTORY_CAPACITY;
    this.count = Math.min(this.count + 1, HISTORY_CAPACITY);
  }

  update(x: number, y: number, s: number, time: number): void {
    if (!Number.isFinite(time)) return;
    if (!Number.isFinite(this.lastTime) || time < this.lastTime || time - this.lastTime > 0.5) {
      // Restarts and large discontinuities must not draw a stripe across the map.
      this.reset();
      this.sample(x, y, s, time);
      this.nextSample = time + TRAIL_SAMPLE_INTERVAL;
    } else if (time > this.lastTime) {
      while (this.nextSample <= time + 1e-8) {
        const t = Math.min(1, (this.nextSample - this.lastTime) / (time - this.lastTime));
        this.sample(
          this.lastX + (x - this.lastX) * t,
          this.lastY + (y - this.lastY) * t,
          this.lastS + (s - this.lastS) * t,
          this.nextSample,
        );
        this.nextSample += TRAIL_SAMPLE_INTERVAL;
      }
    }
    this.lastX = x;
    this.lastY = y;
    this.lastS = s;
    this.lastTime = time;
  }

  write(distance: number, width: number, time: number): void {
    const lifetime = (TRAIL_POINTS - 1) * TRAIL_SAMPLE_INTERVAL;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const sampleIndex = (this.head - 1 - Math.min(Math.max(0, i - 1), this.count - 1)
        + HISTORY_CAPACITY) % HISTORY_CAPACITY;
      const offset = sampleIndex * 4;
      const latest = i === 0;
      const x = latest ? this.lastX : this.samples[offset];
      const y = latest ? this.lastY : this.samples[offset + 1];
      const s = latest ? this.lastS : this.samples[offset + 2];
      const sampledAt = latest ? this.lastTime : this.samples[offset + 3];
      const age = this.count === 0 ? 1 : Math.min(1, Math.max(0, (time - sampledAt) / lifetime));
      const taper = (1 - age) * (1 - age * 0.6);
      const w = this.count === 0 ? 0 : width * taper;
      const z = distance - s;
      let o = i * 6;
      this.positions[o] = x - w;
      this.positions[o + 1] = y;
      this.positions[o + 2] = z;
      this.positions[o + 3] = x + w;
      this.positions[o + 4] = y;
      this.positions[o + 5] = z;
      o += TRAIL_POINTS * 6;
      this.positions[o] = x;
      this.positions[o + 1] = y - w;
      this.positions[o + 2] = z;
      this.positions[o + 3] = x;
      this.positions[o + 4] = y + w;
      this.positions[o + 5] = z;
      this.ages[i * 2] = this.ages[i * 2 + 1] = age;
      this.ages[TRAIL_POINTS * 2 + i * 2] = this.ages[TRAIL_POINTS * 2 + i * 2 + 1] = age;
    }
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.getAttribute("aT").needsUpdate = true;
  }
}
