"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  distance,
  float,
  mix,
  nodeObject,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { chromaticAberration } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { useGameBundle } from "../GameController";
import { damp } from "../core/mathUtils";
import { useSettings } from "../state/settings";

/**
 * WebGPU-native post chain: bloom, speed-driven chromatic aberration,
 * vignette, tiered FXAA/SMAA, then film grain.
 * Takes over the R3F render loop (priority 1).
 */
export function PostFX({
  aa,
  bloomQuality,
  msaaSamples,
}: {
  aa: "none" | "fxaa" | "smaa";
  bloomQuality: number;
  msaaSamples: 0 | 4;
}) {
  const { world, env } = useGameBundle();
  const renderer = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const reduceFlash = useSettings((s) => s.reduceFlash);
  const highContrast = useSettings((s) => s.highContrast);

  const uCA = useMemo(() => uniform(0.6), []);
  const uVignette = useMemo(() => uniform(0.62), []);

  const setup = useMemo(() => {
    // r18x renamed PostProcessing to RenderPipeline; support both.
    const Pipeline =
      (THREE as unknown as { RenderPipeline?: typeof THREE.PostProcessing }).RenderPipeline ??
      THREE.PostProcessing;
    const post = new Pipeline(renderer);
    post.outputColorTransform = false;

    const scenePass = pass(scene, camera, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      samples: msaaSamples,
    });
    const color = scenePass.getTextureNode("output");

    const bloomNode = bloom(color, 0.85, 0.42, 0.82);

    const withBloom = color.add(bloomNode);
    // Note: center must be explicit — the addon crashes on its null default.
    const ca = nodeObject(
      chromaticAberration(withBloom, uCA, vec2(0.5, 0.5), float(1.06)) as unknown as ReturnType<typeof float>,
    );

    // Vignette + subtle edge glow tint driven by boost.
    const d = distance(screenUV, vec2(0.5));
    const vig = float(1).sub(smoothstep(0.34, 1, d.mul(uVignette.add(0.4))));
    const graded = ca
      .mul(mix(vec3(0.3, 0.28, 0.4), vec3(1), vig))
      .add(env.uAccent.mul(env.uBoost).mul(smoothstep(0.4, 0.9, d)).mul(0.12));

    if (aa === "smaa") {
      // SMAA expects tone-mapped linear input, before conversion to sRGB.
      const toneMapped = renderOutput(graded, renderer.toneMapping, THREE.NoColorSpace);
      const antialiased = smaa(toneMapped);
      const withGrain = nodeObject(film(antialiased, float(0.07)));
      post.outputNode = renderOutput(withGrain, THREE.NoToneMapping, renderer.outputColorSpace);
    } else {
      // FXAA expects display-space (sRGB) input.
      const output = renderOutput(graded, renderer.toneMapping, renderer.outputColorSpace);
      const antialiased = aa === "fxaa" ? fxaa(output) : output;
      post.outputNode = nodeObject(film(antialiased, float(0.07)));
    }

    return { post, bloomNode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, scene, camera, aa, bloomQuality, msaaSamples, env, uCA, uVignette]);

  useEffect(() => {
    return () => setup.post.dispose();
  }, [setup]);

  const caSmooth = useRef(0.5);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.08);
    // Bloom breathes with flow, spikes on boost and lightning.
    setup.bloomNode.strength.value =
      (0.72 + env.uFlow.value * 0.45 + world.boostCharge * 0.55 +
        env.uFlash.value * (reduceFlash ? 0.1 : 0.4)) * bloomQuality;
    setup.bloomNode.radius.value = 0.4 + world.boostCharge * (reduceMotion ? 0.08 : 0.25);

    const caScale = reduceMotion ? 0.28 : highContrast ? 0.35 : 1;
    const targetCA =
      (0.16 + world.speedNorm * 0.6 + world.boostCharge * 2.2 + env.uDeath.value * 1.4) * caScale;
    caSmooth.current = damp(caSmooth.current, targetCA, 6, dt);
    uCA.value = caSmooth.current;
    uVignette.value = 0.6 + world.boostCharge * 0.3 + env.uDeath.value * 0.5;

    setup.post.render();
  }, 1);

  return null;
}
