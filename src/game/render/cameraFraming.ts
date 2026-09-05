/** Course translation follows fully; only the pilot's local steering has lag. */
export function chaseFraming(craftX: number, courseX: number, bend: number, whip = 0) {
  return {
    x: courseX + (craftX - courseX) * 0.96,
    lookX: craftX + bend * 0.35 + whip,
  };
}
