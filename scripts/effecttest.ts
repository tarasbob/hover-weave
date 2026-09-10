import assert from "node:assert/strict";
import { Color, PerspectiveCamera, RenderTarget, Scene, type NodeFrame, type NodeMaterial, type QuadMesh } from "three/webgpu";
import { pass } from "three/tsl";
import type GaussianBlurNode from "three/addons/tsl/display/GaussianBlurNode.js";
import { EFFECT_PIXEL_DENSITY, effectResolutionScale } from "../src/game/render/effectPolicy";
import { createDepthOfField, disposePostResources, gateDepthOfField } from "../src/game/render/disposePostResources";
import { QUALITY_CONFIGS } from "../src/game/state/settings";
import { bloomKernel } from "../src/game/render/bloomKernel";

// Compare the optimized bloom convolution against the installed effect's
// original coefficients, including odd target widths and clamped edge texels.
// Pairing is used only on passes with matching input/output dimensions.
for (const radius of [6, 10, 14, 18, 22]) {
  const kernel = bloomKernel(radius);
  assert.equal(1 + kernel.pairs.length * 2, radius + 1);
  for (const width of [1, 3, 17, 32, 65]) {
    const pixels = Array.from({ length: width }, (_, i) => Math.sin(i * 19.17) ** 2 * 12);
    const sample = (x: number): number => {
      const clamped = Math.max(0, Math.min(width - 1, x));
      const low = Math.floor(clamped);
      return pixels[low] + (pixels[Math.min(width - 1, low + 1)] - pixels[low]) * (clamped - low);
    };
    for (let x = 0; x < width; x++) {
      let expected = pixels[x] * kernel.center;
      for (let i = 1; i < radius; i++) {
        const sigma = radius / 3;
        const weight = 0.39894 * Math.exp(-0.5 * i * i / (sigma * sigma)) / sigma;
        expected += (sample(x + i) + sample(x - i)) * weight;
      }
      const actual = kernel.pairs.reduce((sum, tap) => sum +
        (sample(x + tap.offset) + sample(x - tap.offset)) * tap.weight, pixels[x] * kernel.center);
      assert.ok(Math.abs(actual - expected) < 1e-12, `bloom radius ${radius}, width ${width}, pixel ${x}`);
    }
  }
}
console.log("Paired bloom taps preserve the original convolution and edge behavior with fewer texture fetches.");

// The soft-effect density cap only removes surplus high-DPI pixels. Preserve
// all preset values below the cap, DRS behavior, and the prior clarity floor.
for (const config of Object.values(QUALITY_CONFIGS)) {
  for (const [scale, cap] of [
    [config.bloomResolutionScale, EFFECT_PIXEL_DENSITY.bloom],
    [config.reflectionScale, EFFECT_PIXEL_DENSITY.reflection],
  ]) {
    if (scale === 0) continue;
    for (const dynamicScale of [1, config.minDprScale]) {
      const ordinary = effectResolutionScale(scale, dynamicScale, 1, cap);
      assert.equal(ordinary, Math.max(0.22, scale * dynamicScale));
      let previousPixels = 0;
      for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
        const actual = effectResolutionScale(scale, dynamicScale, dpr, cap);
        assert.ok(actual >= 0.22, "preserve the existing effect clarity floor");
        assert.ok(actual <= ordinary, "high DPI must not increase relative effect scale");
        const pixels = dpr * actual;
        assert.ok(pixels + 1e-10 >= previousPixels, "denser displays must retain at least as much effect detail");
        previousPixels = pixels;
      }
    }
  }
}
const high = QUALITY_CONFIGS[2];
const bloomRatio = effectResolutionScale(high.bloomResolutionScale, 1, 2, EFFECT_PIXEL_DENSITY.bloom)
  / high.bloomResolutionScale;
const reflectionRatio = effectResolutionScale(high.reflectionScale, 1, 2, EFFECT_PIXEL_DENSITY.reflection)
  / high.reflectionScale;
assert.ok(Math.abs(bloomRatio ** 2 - 0.5625) < 1e-10, "DPR2 bloom retains 56.25% of original target pixels");
assert.ok(Math.abs(reflectionRatio ** 2 - 0.390625) < 1e-10, "DPR2 reflections retain 39.06% of original target pixels");
console.log("Soft-effect density caps retain preset clarity and avoid surplus retina target pixels.");

// Exercise the installed DOF and its nested Gaussian update implementations,
// using a renderer double to record submitted passes rather than GPU pixels.
// Browser tests cover real shaders and backend validation separately.
{
  const scenePass = pass(new Scene(), new PerspectiveCamera());
  scenePass.renderTarget.setSize(1600, 900);
  let active = false;
  const effect = gateDepthOfField(
    createDepthOfField(scenePass.getTextureNode("output"), scenePass.getViewZNode()),
    () => active,
  );
  const builder = {
    getSharedContext: () => ({}),
    getNodeProperties: () => ({}),
  } as unknown as Parameters<typeof effect.setup>[0];
  effect.setup(builder);
  const passes: string[] = [];
  const initialTarget = new RenderTarget(16, 16);
  let currentTarget: RenderTarget | null = initialTarget;
  const initializedBlurs = new WeakSet<GaussianBlurNode>();
  const renderer = {
    autoClear: false,
    getRenderTarget: () => currentTarget,
    setRenderTarget: (target: RenderTarget | null) => { currentTarget = target; },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderObjectFunction: () => null,
    setRenderObjectFunction: () => undefined,
    getPixelRatio: () => 2,
    setPixelRatio: () => undefined,
    getMRT: () => null,
    setMRT: () => undefined,
    getClearColor: (color: Color) => color.set(0),
    getClearAlpha: () => 0,
    setClearColor: () => undefined,
    getScissorTest: () => false,
    setScissorTest: () => undefined,
    render: (mesh: QuadMesh) => {
      const blur = (mesh.material as NodeMaterial | null)?.colorNode as GaussianBlurNode | null;
      if (blur?.type === "GaussianBlurNode") {
        if (!initializedBlurs.has(blur)) {
          blur.setup(builder);
          initializedBlurs.add(blur);
        }
        blur.updateBefore(frame);
      }
      passes.push(mesh.name);
    },
  };
  const frame = { renderer } as unknown as NodeFrame;
  effect.updateBefore(frame);
  const completePasses = [...passes];
  assert.equal(completePasses.length, 9, "warmup compiles all seven DOF and two Gaussian passes");
  assert.ok(completePasses.includes("DoF [ Blur64 Near ]"));
  assert.ok(completePasses.includes("DoF [ Blur64 Far ]"));
  assert.equal(currentTarget, initialTarget, "effect restores renderer target after warmup");
  assert.equal(renderer.autoClear, false, "effect restores renderer state");

  passes.length = 0;
  for (let i = 0; i < 240; i++) effect.updateBefore(frame);
  assert.deepEqual(passes, [], "all DOF work stays off throughout active flight");
  active = true;
  effect.updateBefore(frame);
  assert.deepEqual(passes, completePasses, "death retains the original full-quality pass sequence");
  passes.length = 0;
  effect.updateBefore(frame);
  assert.deepEqual(passes, completePasses, "death transition updates every frame");
  passes.length = 0;
  active = false;
  effect.updateBefore(frame);
  assert.deepEqual(passes, [], "retry disables DOF immediately without rebuilding shaders");
  active = true;
  effect.updateBefore(frame);
  assert.deepEqual(passes, completePasses, "subsequent deaths reuse all original effects");
  disposePostResources(effect);
  initialTarget.dispose();
  console.log("DOF warms once, skips nine passes in flight, and retains every pass across death/retry.");
}
