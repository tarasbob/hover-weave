"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
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
  clamp,
  floor,
  fract,
  uniformArray,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { OCEAN_DEPTH } from "./visualConstants";
import { EFFECT_PIXEL_DENSITY, effectResolutionScale } from "./effectPolicy";

/**
 * Planar-reflection water strip along the track (digital-ocean biome).
 * Uses three's ReflectorNode; opacity follows the biome's reflectivity so it
 * fades in/out through transitions and reads as wet sheen elsewhere.
 */
export function Ocean({ resolutionScale }: { resolutionScale: number }) {
  const { env, world, ambient } = useGameBundle();
  const renderer = useThree((s) => s.gl);
  const course = useMemo(() => {
    const rows = Math.ceil(OCEAN_DEPTH / 8);
    const values = Array<number>(rows + 1).fill(0);
    return { rows, step: OCEAN_DEPTH / rows, values, node: uniformArray<"float">(values, "float") };
  }, []);

  const { group, reflection } = useMemo(() => {
    const g = new THREE.Group();

    // The single water plane cannot usefully reflect another reflection.
    const reflectionNode = reflector({ resolutionScale, bounces: false });
    reflectionNode.target.rotateX(-Math.PI / 2);
    reflectionNode.target.position.y = 0.05;
    g.add(reflectionNode.target);

    // Ripple distortion on the reflection UVs.
    const ripple = Fn(() => {
      const p = vec2(positionWorld.x.mul(0.11), positionWorld.z.mul(0.13).add(env.uScroll.mul(0.09)));
      const n1 = mx_noise_float(vec3(p, env.uTime.mul(0.5)));
      const n2 = mx_noise_float(vec3(p.mul(2.7), env.uTime.mul(0.8).add(9)));
      return vec2(n1, n2).mul(0.022);
    })();
    reflectionNode.uvNode = reflectionNode.uvNode!.add(ripple);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    // The reflective strip follows the same course as the road and terrain;
    // a fixed strip at x=0 would visibly cut across the stronger bends.
    const index = clamp(
      float(OCEAN_DEPTH / 2).sub(positionLocal.z).div(course.step), 0, course.rows - 0.0001,
    );
    const row = floor(index);
    const courseX = mix(course.node.element(row), course.node.element(row.add(1)), fract(index));
    mat.positionNode = positionLocal.add(vec3(courseX, 0, 0));

    mat.colorNode = Fn(() => {
      const view = normalize(cameraPosition.sub(positionWorld));
      const fresnel = pow(saturate(float(1).sub(view.y)), 2.4).mul(0.75).add(0.25);
      const deep = mix(env.uTerrainA, env.uTerrainB, 0.35);
      const refl = reflectionNode.rgb;
      const col = mix(deep, refl, fresnel.mul(0.85));
      // Faint scrolling wave bands for motion when reflections are subtle.
      const bandSpeed = env.uSpeedNorm.mul(1.8).add(2);
      const band = sin(
        positionWorld.z.add(env.uScroll).mul(0.6).add(env.uTime.mul(bandSpeed)),
      ).mul(0.5).add(0.5);
      return col
        .add(env.uAccent.mul(band).mul(0.07))
        .add(env.uPrimary.mul(env.uTransition).mul(0.12));
    })();

    // Fade at the strip's outer edges + biome-driven visibility.
    mat.opacityNode = Fn(() => {
      const edgeFade = smoothstep(64, 40, abs(positionLocal.x));
      return env.uReflectivity.mul(edgeFade);
    })();

    const geo = new THREE.PlaneGeometry(130, OCEAN_DEPTH, 1, course.rows);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0.05, -OCEAN_DEPTH / 2 + 120);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    g.add(mesh);
    return { group: g, reflection: reflectionNode };
  }, [env, course, resolutionScale]);

  useFrame(() => {
    // A fully transparent water plane must not trigger an invisible scene
    // render. Any nonzero sheen, including biome transitions, stays visible.
    group.visible = env.uReflectivity.value > 0;
    if (group.visible) {
      const distance = world.status === "idle" ? ambient.value : world.renderDistance;
      for (let i = 0; i <= course.rows; i++) {
        course.values[i] = world.courseOffsetAt(distance - 120 + i * course.step);
      }
    }
    reflection.reflector.resolutionScale = effectResolutionScale(
      resolutionScale, env.uDrsScale.value,
      renderer.getPixelRatio(), EFFECT_PIXEL_DENSITY.reflection,
    );
  });

  useEffect(() => {
    return () => {
      reflection.dispose();
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    };
  }, [group, reflection]);

  return <primitive object={group} />;
}
