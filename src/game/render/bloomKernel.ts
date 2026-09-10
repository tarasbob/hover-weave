export interface BloomTap { offset: number; weight: number }

/** Pair adjacent Gaussian taps using the texture sampler's linear interpolation. */
export function bloomKernel(radius: number): { center: number; pairs: BloomTap[] } {
  const sigma = radius / 3;
  const weight = (i: number) => 0.39894 * Math.exp(-0.5 * i * i / (sigma * sigma)) / sigma;
  const pairs: BloomTap[] = [];
  for (let i = 1; i < radius; i += 2) {
    const a = weight(i);
    const b = i + 1 < radius ? weight(i + 1) : 0;
    pairs.push({ offset: i + b / (a + b), weight: a + b });
  }
  return { center: weight(0), pairs };
}
