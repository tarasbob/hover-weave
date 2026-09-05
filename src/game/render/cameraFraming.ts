/**
 * Anticipate the road without yawing the ship off a narrow phone viewport.
 * A bounded look offset also leaves the winding centerline visible, instead
 * of continually rotating the camera until the next bend looks straight.
 */
export function chaseFraming(
  craftX: number, courseX: number, bend: number, whip = 0, aspect = 16 / 9,
) {
  const anticipationLimit = 3.2 * Math.min(1, aspect / 0.75);
  const anticipation = anticipationLimit * Math.tanh((bend * 0.18 + whip) / anticipationLimit);
  return {
    x: courseX + (craftX - courseX) * 0.99,
    lookX: craftX + anticipation,
  };
}
