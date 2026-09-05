import { clamp, smoothstep } from "../core/mathUtils";

export interface CrashOrigin {
  x: number;
  y: number;
  speed: number;
  latVel: number;
  vy: number;
  bank: number;
  cause: "obstacle" | "edge";
  edge?: -1 | 1;
}

/** Camera and wreck share one trajectory, independent of render refresh rate. */
export function crashCenter(
  origin: CrashOrigin,
  elapsed: number,
  reduceMotion: boolean,
): { x: number; y: number; z: number } {
  const t = clamp(elapsed, 0, 3.5);
  const motion = reduceMotion ? 0.45 : 1;
  const edge = origin.cause === "edge";
  const lateral = edge
    ? (origin.edge ?? (origin.latVel < 0 ? -1 : 1)) * Math.max(3.2, Math.abs(origin.latVel) * 0.3)
    : origin.latVel * 0.1;
  return {
    x: origin.x + lateral * (edge ? t : 1 - Math.exp(-t * 1.4)) * motion,
    y: edge
      ? Math.max(0.24, origin.y + (1.8 + clamp(origin.vy * 0.1, -0.5, 1.5)) * t * motion - 1.6 * t * t * motion)
      : origin.y,
    // A solid impact recoils onto the camera-facing side of the obstacle.
    // Continuing forward here buries every fragment inside/behind tall pillars.
    z: edge
      ? -t * Math.min(4, 1.4 + origin.speed * 0.025) * motion
      : (1 - Math.exp(-t * 1.35)) * Math.min(5.2, 3.4 + origin.speed * 0.018) * motion,
  };
}

/** An edge departure has a brief intact arc before its panels peel away. */
export function crashSeparation(elapsed: number, edge: boolean): number {
  const t = Math.max(0, elapsed - (edge ? 0.18 : 0));
  return t * smoothstep(0, 0.22, t);
}
