export const clamp = (v: number, min: number, max: number) =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Framerate-independent exponential smoothing. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;

/**
 * Squared distance from a point to an oriented box in the track plane
 * (x = lateral, s = along-track). Returns 0 when the point is inside.
 */
export function circleObbDistSq(
  cx: number, cs: number,
  bx: number, bs: number,
  halfX: number, halfS: number,
  yaw: number,
): number {
  const dx = cx - bx;
  const ds = cs - bs;
  let lx = dx, ls = ds;
  if (yaw !== 0) {
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    lx = dx * c - ds * s;
    ls = dx * s + ds * c;
  }
  const qx = Math.max(0, Math.abs(lx) - halfX);
  const qs = Math.max(0, Math.abs(ls) - halfS);
  return qx * qx + qs * qs;
}

/** Sharp-in / hold / retract pulse used by piston crushers. Returns 0..1. */
export function pistonPulse(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < 0.18) return smoothstep(0, 0.18, p);
  if (p < 0.42) return 1;
  if (p < 0.62) return 1 - smoothstep(0.42, 0.62, p);
  return 0;
}
