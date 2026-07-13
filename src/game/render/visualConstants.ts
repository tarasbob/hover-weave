/** Shared visual direction so the sky disc, key light and reflections agree. */
export const SUN_DIRECTION = [0.44, 0.78, -0.44] as const;

/**
 * Far-field depth budget, sized against LOOKAHEAD.MAX (1560 m): the camera
 * frustum, terrain/ocean planes and sky dome must all reach past the largest
 * speed-scaled view distance or high-speed play would clip the world.
 * graphicstest.ts asserts these stay consistent with LOOKAHEAD.
 */
export const CAMERA_FAR = 2400;
export const SKYDOME_RADIUS = 2000;
export const TERRAIN_DEPTH = 1700;
export const OCEAN_DEPTH = 1700;
