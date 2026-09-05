/**
 * Soft effects do not need the beauty pass's full retina density. Keep their
 * authored scale on ordinary displays and their existing 0.22 clarity floor;
 * cap only the extra density on high-DPI displays. Main-scene DPR and AA are
 * untouched. Reflection ripples already filter detail more than bloom does.
 */
export const EFFECT_PIXEL_DENSITY = { bloom: 1.5, reflection: 1.25 } as const;

export function effectResolutionScale(
  authoredScale: number,
  dynamicScale: number,
  rendererDpr: number,
  densityLimit: number,
): number {
  const densityScale = Math.min(1, densityLimit / Math.max(1, rendererDpr));
  return Math.max(0.22, authoredScale * dynamicScale * densityScale);
}
