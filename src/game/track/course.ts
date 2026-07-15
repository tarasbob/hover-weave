import { COURSE } from "../core/constants";
import { smoothstep } from "../core/mathUtils";
import { createRng } from "../core/rng";
import { difficultyAt } from "./generator";

interface Wave {
  amp: number;
  k: number;
  phase: number;
}

/**
 * The winding track: a seeded, slowly wandering corridor centerline.
 *
 * `offsetAt(s)` is a pure function of the run seed and track distance, so
 * replays, ghosts, and dailies stay bit-exact. Patterns keep authoring and
 * validating in a straight local frame; the sim applies this offset when
 * chunks spawn and when clamping the craft, and the camera/craft lean into
 * the bends.
 *
 * Fairness: each octave contributes `slope share = amp * k`; the shares sum
 * to COURSE.SLOPE_EARLY at full amplitude and taper by LATE_SCALE once the
 * validator switches to its tighter late reach profile — the drift always
 * fits inside the craft's steering headroom above the validator's plan.
 */
export class Course {
  private readonly waves: Wave[] = [];
  /** Identity course (trials): offset is 0 everywhere. */
  readonly flat: boolean;

  constructor(seed: string | null) {
    this.flat = seed === null;
    if (seed === null) return;
    const rng = createRng(`${seed}|course`);
    // [worst-case slope share, min wavelength, max wavelength]
    const octaves: [number, number, number][] = [
      [0.04, 1700, 2200],
      [0.022, 520, 700],
    ];
    for (const [share, l0, l1] of octaves) {
      const k = (2 * Math.PI) / rng.range(l0, l1);
      this.waves.push({ amp: share / k, k, phase: rng.range(0, Math.PI * 2) });
    }
  }

  /** Lateral centerline offset (m) of the corridor at track distance s. */
  offsetAt(s: number): number {
    if (this.flat) return 0;
    let raw = 0;
    for (const w of this.waves) raw += Math.sin(s * w.k + w.phase) * w.amp;
    const rampIn = smoothstep(40, COURSE.RAMP_IN, s);
    const late =
      1 - (1 - COURSE.LATE_SCALE) * smoothstep(COURSE.TAPER_D0, COURSE.TAPER_D1, difficultyAt(s));
    return raw * rampIn * late;
  }
}
