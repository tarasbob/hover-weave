import { COURSE } from "../core/constants";
import { lerp, smoothstep } from "../core/mathUtils";
import { createRng } from "../core/rng";
import { difficultyAt } from "./generator";

/**
 * Seeded S bends spanning several track widths. Every apex, including late
 * in a run, moves beyond the original corridor and demands active steering.
 * Each apex alternates sides, with a seeded amplitude;
 * smooth interpolation keeps the tangent continuous, including at launch.
 * Patterns and their solved path share this exact centerline in world space.
 * The late taper reserves steering authority for the denser obstacle field.
 */
export class Course {
  readonly flat: boolean;
  private readonly seed: number;
  private readonly firstSide: number;

  constructor(seed: string | null) {
    this.flat = seed === null;
    const rng = createRng(`${seed ?? "flat"}|course`);
    this.seed = Math.floor(rng.range(0, 0x1_0000_0000));
    this.firstSide = rng.range(0, 1) < 0.5 ? -1 : 1;
  }

  /** Stateless seeded apex sampling: no streaming order or growing cache. */
  private apex(index: number): number {
    let hash = (this.seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
    hash = (hash ^ (hash >>> 15)) >>> 0;
    const amplitude = lerp(COURSE.MIN_OFFSET, COURSE.MAX_OFFSET, hash / 0xffff_ffff);
    return amplitude * this.firstSide * (index % 2 === 0 ? 1 : -1);
  }

  /** Lateral centerline offset (m) of the corridor at track distance s. */
  offsetAt(s: number): number {
    if (this.flat || s <= 0) return 0;
    let offset: number;
    if (s < COURSE.RAMP_IN) {
      offset = this.apex(0) * smoothstep(COURSE.LAUNCH_STRAIGHT, COURSE.RAMP_IN, s);
    } else {
      const bend = (s - COURSE.RAMP_IN) / COURSE.BEND_LENGTH;
      const index = Math.floor(bend);
      offset = lerp(this.apex(index), this.apex(index + 1), smoothstep(0, 1, bend - index));
    }
    const late = 1 - (1 - COURSE.LATE_SCALE) *
      smoothstep(COURSE.TAPER_D0, COURSE.TAPER_D1, difficultyAt(s));
    return offset * late;
  }
}
