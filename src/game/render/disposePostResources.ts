import type { Material, Node, RenderTarget } from "three/webgpu";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";

const OWNED_PASSES = new Set([
  "PassNode", "BloomNode", "SMAANode", "DepthOfFieldNode", "GaussianBlurNode",
]);
const dofBlurNodes = new WeakMap<Node, Set<Node>>();
type DofResources = Node & { _CoCBlurredMaterial: { colorNode: Node | null } };

/** Retain every blur created by r185's repeated DOF setup, including overwritten ones. */
export function createDepthOfField(...args: Parameters<typeof dof>): ReturnType<typeof dof> {
  const effect = dof(...args);
  const owned = new Set<Node>();
  const setup = effect.setup.bind(effect);
  effect.setup = (builder) => {
    // Effects can be setup again after cleanup during React effect replay.
    dofBlurNodes.set(effect, owned);
    const result = setup(builder);
    const blur = (effect as unknown as DofResources)._CoCBlurredMaterial.colorNode;
    if (blur) owned.add(blur);
    return result;
  };
  return effect;
}

/**
 * A zero bokeh radius does not disable r185's nine DOF rendering passes. Warm
 * their shaders once when constructing the pipeline, then run them only while
 * the effect is visible. The caller must select the original color while off;
 * otherwise it would display the last blurred frame. No graph rebuild is
 * needed on death or retry, and the first crash has already compiled shaders.
 */
export function gateDepthOfField(
  effect: ReturnType<typeof dof>,
  active: () => boolean,
): ReturnType<typeof dof> {
  let warm = false;
  const updateBefore = effect.updateBefore.bind(effect);
  effect.updateBefore = (frame) => {
    if (warm && !active()) return;
    updateBefore(frame);
    warm = true;
    return undefined;
  };
  return effect;
}

/**
 * RenderPipeline.dispose() only frees its final quad material in three r185.
 * Release the offscreen targets too when changing quality or unmounting.
 * Walk only node links, deduplicating shared inputs and cycles; scene objects
 * and the shared environment uniforms are not owned by the post pipeline.
 */
export function disposePostResources(output: Node): void {
  const visited = new Set<Node>();
  const pending = [output];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const child of node.getChildren()) pending.push(child);
    const retainedBlurs = dofBlurNodes.get(node);
    if (retainedBlurs) {
      for (const blur of retainedBlurs) pending.push(blur);
      // Keep ownership for the effect's lifetime: React can reuse a compiled
      // graph after cleanup, reallocating targets without another node setup.
      // The WeakMap does not keep the discarded effect or its graphs alive.
    }

    if (node.type === "DepthOfFieldNode") {
      // r185 creates this GaussianBlurNode inside a private material during
      // setup(). Public node traversal cannot reach it, and disposing the
      // material does not release the blur's two internal render targets.
      const dof = node as DofResources;
      const blur = dof._CoCBlurredMaterial.colorNode;
      if (blur) pending.push(blur);
    }

    if (node.type === "RTTNode") {
      // r185's implicit convertToTexture nodes inherit a no-op dispose().
      // Until three supplies it, this small compatibility boundary owns the
      // target and private quad material inspected in the installed version.
      const rtt = node as Node & {
        renderTarget: RenderTarget;
        _quadMesh: { material: Material };
      };
      rtt.renderTarget.dispose();
      rtt._quadMesh.material.dispose();
    } else if (node.type && OWNED_PASSES.has(node.type)) {
      node.dispose();
    }
  }
}
