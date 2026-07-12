"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  positionWorld,
  reflector,
  sin,
  smoothstep,
  vec2,
  vec3,
  saturate,
  cameraPosition,
  normalize,
  pow,
} from "three/tsl";
import { useGameBundle } from "../GameController";

/**
 * Planar-reflection water strip along the track (digital-ocean biome).
 * Uses three's ReflectorNode; opacity follows the biome's reflectivity so it
 * fades in/out through transitions and reads as wet sheen elsewhere.
 */
export function Ocean() {
  const { env } = useGameBundle();

  const group = useMemo(() => {
    const g = new THREE.Group();

    const reflection = reflector({ resolutionScale: 0.5 });
    reflection.target.rotateX(-Math.PI / 2);
    reflection.target.position.y = 0.05;
    g.add(reflection.target);

    // Ripple distortion on the reflection UVs.
    const ripple = Fn(() => {
      const p = vec2(positionWorld.x.mul(0.11), positionWorld.z.mul(0.13).add(env.uScroll.mul(0.09)));
      const n1 = mx_noise_float(vec3(p, env.uTime.mul(0.5)));
      const n2 = mx_noise_float(vec3(p.mul(2.7), env.uTime.mul(0.8).add(9)));
      return vec2(n1, n2).mul(0.022);
    })();
    reflection.uvNode = reflection.uvNode!.add(ripple);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;

    mat.colorNode = Fn(() => {
      const view = normalize(cameraPosition.sub(positionWorld));
      const fresnel = pow(saturate(float(1).sub(view.y)), 2.4).mul(0.75).add(0.25);
      const deep = mix(env.uTerrainA, env.uTerrainB, 0.35);
      const refl = reflection.rgb;
      const col = mix(deep, refl, fresnel.mul(0.85));
      // Faint scrolling wave bands for motion when reflections are subtle.
      const band = sin(positionWorld.z.add(env.uScroll).mul(0.6).add(env.uTime.mul(2))).mul(0.5).add(0.5);
      return col.add(env.uAccent.mul(band).mul(0.045));
    })();

    // Fade at the strip's outer edges + biome-driven visibility.
    mat.opacityNode = Fn(() => {
      const edgeFade = smoothstep(64, 40, abs(positionLocal.x));
      return env.uReflectivity.mul(edgeFade);
    })();

    const geo = new THREE.PlaneGeometry(130, 640);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0.05, -250);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    g.add(mesh);
    return g;
  }, [env]);

  return <primitive object={group} />;
}
