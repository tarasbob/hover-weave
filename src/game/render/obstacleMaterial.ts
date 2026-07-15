"use client";

import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  float,
  fwidth,
  instancedBufferAttribute,
  mix,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  dot,
  hash,
  instanceIndex,
  vec3,
} from "three/tsl";
import type { EnvState } from "./env";
import type { NodeAny } from "./tsl-utils";

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
  opts: {
    emissiveBase?: number;
    profile?: "metal" | "crystal" | "ring" | "glass" | "bumper" | "beam";
  } = {},
): THREE.MeshStandardNodeMaterial {
  const profile = opts.profile ?? "metal";
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.metalness =
    profile === "crystal" ? 0.42
    : profile === "ring" ? 0.82
    : profile === "glass" ? 0.08
    : profile === "bumper" ? 0.12
    : profile === "beam" ? 0.3
    : 0.72;
  mat.roughness =
    profile === "crystal" ? 0.14
    : profile === "ring" ? 0.22
    : profile === "glass" ? 0.06
    : profile === "bumper" ? 0.52
    : profile === "beam" ? 0.18
    : 0.3;
  if (profile === "glass") {
    // See-through panes: the field behind must stay readable at speed.
    mat.transparent = true;
    mat.opacity = 0.42;
    mat.depthWrite = false;
  }
  if (profile === "beam") {
    mat.transparent = true;
    mat.opacity = 0.88;
    mat.depthWrite = false;
  }

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
    const facing = saturate(abs(dot(normalView, positionViewDirection)));
    const rim = saturate(float(1).sub(facing));
    const rimAA = fwidth(rim).mul(1.5);
    const fresnel = pow(
      smoothstep(float(0.12).sub(rimAA), float(0.9).add(rimAA), rim),
      profile === "crystal" ? 1.45 : 1.9,
    );
    const seed = hash(instanceIndex.toFloat().add(0.5));
    const pulse = sin(env.uTime.mul(2.4).add(seed.mul(31.4))).mul(0.16).add(0.9);
    const base = float(opts.emissiveBase ?? 0.05);
    let profileColor: NodeAny = paletteColor;
    let profileEnergy: NodeAny = float(1);

    if (profile === "crystal") {
      const facet = pow(abs(dot(normalView, vec3(0.57, 0.72, 0.39))), 18);
      const spectral = sin(facing.mul(15).add(env.uTime.mul(0.35)).add(seed.mul(8)))
        .mul(0.5)
        .add(0.5);
      profileColor = mix(paletteColor, env.uAccent, spectral.mul(0.42));
      profileEnergy = facet.mul(1.4).add(1.08);
    } else if (profile === "ring") {
      profileColor = mix(paletteColor, env.uPrimary, 0.22);
      profileEnergy = sin(env.uTime.mul(5.5).add(seed.mul(20))).mul(0.16).add(1.18);
    } else if (profile === "glass") {
      // Cold, edge-lit panes with a slow internal shimmer.
      profileColor = mix(paletteColor, env.uAccent, 0.55);
      profileEnergy = sin(env.uTime.mul(1.6).add(seed.mul(12))).mul(0.12).add(1.25);
    } else if (profile === "bumper") {
      // Rubbery breathing pulse — reads as "springy", not "lethal".
      profileColor = mix(paletteColor, env.uAccent, 0.3);
      profileEnergy = sin(env.uTime.mul(3.2).add(seed.mul(17))).mul(0.28).add(1.2);
    } else if (profile === "beam") {
      // Hot core: per-instance glow (CPU-driven phase) does the talking.
      profileColor = mix(paletteColor, env.uWarn, 0.35);
      profileEnergy = sin(env.uTime.mul(11).add(seed.mul(23))).mul(0.2).add(1.6);
    }

    const intensity = fresnel
      .mul(1.35)
      .add(base)
      .mul(pulse)
      .mul(profileEnergy)
      .mul(glow)
      .mul(env.uContrast.mul(1.15).add(1));
    // Flow state pushes everything hotter; lightning adds a specular wash.
    return profileColor
      .mul(intensity)
      .mul(env.uFlow.mul(0.55).add(1))
      .add(profileColor.mul(env.uFlash).mul(0.35))
      .add(profileColor.mul(env.uFlowPulse).mul(0.22));
  })();

  return mat;
}
