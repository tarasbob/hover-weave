import { NodeMaterial, Vector2, type NodeBuilder, type Texture } from "three/webgpu";
import { Fn, If, texture, uniform, uv, vec4 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { bloomKernel } from "./bloomKernel";

/**
 * Compatibility boundary for three r185's bloom material factory. Keep its
 * five mip levels, Gaussian coefficients, targets and resource ownership;
 * reduce texture fetches where the input and output pixel grids coincide.
 */
export function efficientBloom(...args: Parameters<typeof bloom>): ReturnType<typeof bloom> {
  const effect = bloom(...args);
  const internal = effect as typeof effect & {
    _getSeparableBlurMaterial(builder: NodeBuilder & { getSharedContext(): NodeBuilder["context"] }, radius: number): NodeMaterial;
  };
  internal._getSeparableBlurMaterial = (builder, radius) => {
    const colorTexture = texture(null as unknown as Texture);
    const invSize = uniform(new Vector2());
    const direction = uniform(new Vector2(0.5, 0.5));
    const kernel = bloomKernel(radius);
    const fragment = Fn(() => {
      const coord = uv();
      const step = direction.mul(invSize);
      const sum = colorTexture.sample(coord).rgb.mul(kernel.center).toVar();
      const paired = () => {
        for (const tap of kernel.pairs) {
          const offset = step.mul(tap.offset);
          sum.addAssign(colorTexture.sample(coord.add(offset)).rgb
            .add(colorTexture.sample(coord.sub(offset)).rgb).mul(tap.weight));
        }
      };
      if (radius === 6) {
        paired();
      } else {
        // Later horizontal passes downsample the preceding mip. Their taps
        // are two input texels apart and cannot be combined with a single
        // bilinear fetch. Vertical passes always read an equally sized target.
        If(direction.y.greaterThan(0), paired).Else(() => {
          const sigma = radius / 3;
          for (let i = 1; i < radius; i++) {
            const offset = step.mul(i);
            const weight = 0.39894 * Math.exp(-0.5 * i * i / (sigma * sigma)) / sigma;
            sum.addAssign(colorTexture.sample(coord.add(offset)).rgb
              .add(colorTexture.sample(coord.sub(offset)).rgb).mul(weight));
          }
        });
      }
      return vec4(sum, 1);
    });
    const material = new NodeMaterial();
    material.fragmentNode = fragment().context(builder.getSharedContext());
    material.name = "Bloom_separable";
    // BloomNode updates these handles for each pass and owns their disposal.
    return Object.assign(material, { colorTexture, invSize, direction });
  };
  return effect;
}
