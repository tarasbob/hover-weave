"use client";

import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  instancedBufferAttribute,
  mix,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  step,
  dot,
  hash,
  instanceIndex,
} from "three/tsl";
import type { EnvState } from "./env";

/**
 * Shared neon obstacle material: dark reflective body with fresnel edge glow
 * tinted by a per-instance palette role, pulsing subtly. Role/glow ride in an
 * instanced attribute so biome transitions recolor live obstacles for free.
 *
 * aData: [role (0 primary, 1 accent, 2 warn, 3 dim), glow multiplier]
 */
export function createObstacleMaterial(
  env: EnvState,
  attr: THREE.InstancedBufferAttribute,
  opts: { emissiveBase?: number } = {},
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.metalness = 0.72;
  mat.roughness = 0.3;

  const data = instancedBufferAttribute<"vec2">(attr, "vec2");
  const role = data.x;
  const glow = data.y;

  mat.colorNode = env.uBody;

  mat.emissiveNode = Fn(() => {
    const paletteColor = mix(
      mix(env.uPrimary, env.uAccent, step(0.5, role)),
      mix(env.uWarn, env.uDim, step(2.5, role)),
      step(1.5, role),
    );
    const fresnel = pow(
      saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))),
      2.1,
    );
    const seed = hash(instanceIndex.toFloat().add(0.5));
    const pulse = sin(env.uTime.mul(2.4).add(seed.mul(31.4))).mul(0.16).add(0.9);
    const base = float(opts.emissiveBase ?? 0.05);
    const intensity = fresnel.mul(1.35).add(base).mul(pulse).mul(glow);
    // Flow state pushes everything hotter; lightning adds a specular wash.
    return paletteColor
      .mul(intensity)
      .mul(env.uFlow.mul(0.55).add(1))
      .add(paletteColor.mul(env.uFlash).mul(0.35));
  })();

  return mat;
}
