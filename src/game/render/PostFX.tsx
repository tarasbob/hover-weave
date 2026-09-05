"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  distance,
  float,
  luminance,
  mix,
  nodeObject,
  pass,
  pow,
  renderOutput,
  saturate,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { chromaticAberration } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { useGameBundle } from "../GameController";
import { damp } from "../core/mathUtils";
import { useSettings } from "../state/settings";
import type { NodeAny } from "./tsl-utils";
import { SUN_DIRECTION } from "./visualConstants";
import { createDepthOfField, disposePostResources, gateDepthOfField } from "./disposePostResources";
import { EFFECT_PIXEL_DENSITY, effectResolutionScale } from "./effectPolicy";

/**
 * WebGPU-native post chain: bloom, speed-driven chromatic aberration,
 * vignette, tiered FXAA/SMAA, then film grain.
 * Takes over the R3F render loop (priority 1).
 */
export function PostFX({
  aa,
  bloomQuality,
  bloomResolutionScale,
  msaaSamples,
  premiumPost,
}: {
  aa: "none" | "fxaa" | "smaa";
  bloomQuality: number;
  bloomResolutionScale: number;
  msaaSamples: 0 | 4;
  premiumPost: boolean;
}) {
  const { world, env } = useGameBundle();
  const renderer = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const reduceFlash = useSettings((s) => s.reduceFlash);
  const highContrast = useSettings((s) => s.highContrast);

  const uCA = useMemo(() => uniform(0), []);
  const uVignette = useMemo(() => uniform(0.62), []);
  const uMotionBlur = useMemo(() => uniform(0), []);
  const uShafts = useMemo(() => uniform(0), []);
  const uSunScreen = useMemo(() => uniform(new THREE.Vector2()), []);
  const projectedSun = useMemo(() => new THREE.Vector3(), []);

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
    let sceneColor: NodeAny = color;

    if (premiumPost) {
      // Subtle radial accumulation sells boost speed while retaining a sharp base.
      const radial = screenUV.sub(vec2(0.5));
      const peripheral = smoothstep(0.16, 0.52, radial.length());
      const blur = uMotionBlur.mul(peripheral);
      const sampleA = color.sample(screenUV.sub(radial.mul(blur.mul(0.008))));
      const sampleB = color.sample(screenUV.sub(radial.mul(blur.mul(0.016))));
      sceneColor = color.mul(0.76).add(sampleA.mul(0.16)).add(sampleB.mul(0.08));
    }

    // Extract only the luminous HDR regions so neon blooms without washing fog.
    const brightMask = pow(
      smoothstep(0.38, 1.15, luminance(sceneColor.rgb)),
      0.82,
    );
    const bloomInput = nodeObject(sceneColor.mul(brightMask));
    const bloomNode = bloom(
      bloomInput,
      0.85,
      0.42,
      0.68 + (1 - bloomQuality) * 0.12,
    );
    bloomNode.smoothWidth.value = 0.1;
    bloomNode.setResolutionScale(bloomResolutionScale);

    const withBloom = sceneColor.add(bloomNode);
    // Note: center must be explicit — the addon crashes on its null default.
    const ca: NodeAny = nodeObject(
      chromaticAberration(withBloom, uCA, vec2(0.5, 0.5), float(1.06)) as NodeAny,
    );

    // Biome-aware cinematic grade, then vignette and reactive edge tint.
    const d = distance(screenUV, vec2(0.5));
    const vig = float(1).sub(smoothstep(0.34, 1, d.mul(uVignette.add(0.4))));
    const luma = luminance(ca.rgb);
    const saturated = mix(vec3(luma), ca.rgb, env.uPostSaturation.mul(0.9));
    const contrasted = saturated
      .sub(vec3(0.18))
      .mul(env.uPostContrast.add(env.uContrast.mul(0.08)))
      .add(vec3(0.18));
    const shadowTint = float(1).sub(smoothstep(0.12, 0.58, luma));
    const highlightTint = smoothstep(0.5, 1.15, luma);
    let graded: NodeAny = vec4(
      contrasted
        .add(env.uFogColor.mul(shadowTint).mul(0.075))
        .add(env.uAccent.mul(highlightTint).mul(0.045))
        .mul(mix(vec3(0.3, 0.28, 0.4), vec3(1), vig))
        .add(env.uAccent.mul(env.uBoost).mul(smoothstep(0.4, 0.9, d)).mul(0.12))
        .add(env.uPrimary.mul(env.uNearMiss).mul(0.035)),
      ca.a,
    );

    if (premiumPost) {
      // A cheap, stable light-shaft impression around the coherent sky source.
      const shaftDistance = distance(screenUV, uSunScreen);
      const shaft = pow(saturate(float(1).sub(shaftDistance.mul(1.7))), 3.4)
        .mul(uShafts);
      graded = vec4(graded.rgb.add(env.uHorizon.mul(shaft).mul(0.32)), graded.a);
      const deathFocus = gateDepthOfField(
        createDepthOfField(graded, scenePass.getViewZNode(), 14, 28, env.uDeath.mul(1.25)),
        () => env.uDeath.value > 0,
      );
      // The DOF graph stays compiled, but its expensive blur/MRT passes are
      // inactive throughout flight. At zero radius the original effect still
      // resampled the image at half resolution, softening an otherwise sharp
      // course. Select the original grade until the actual crash transition.
      graded = env.uDeath.greaterThan(0).select(deathFocus, graded);
    }

    if (aa === "smaa") {
      // SMAA expects tone-mapped linear input, before conversion to sRGB.
      const toneMapped = renderOutput(graded, renderer.toneMapping, THREE.NoColorSpace);
      const antialiased = smaa(toneMapped);
      const withGrain = nodeObject(film(antialiased, float(0.028)));
      post.outputNode = renderOutput(withGrain, THREE.NoToneMapping, renderer.outputColorSpace);
    } else {
      // FXAA expects display-space (sRGB) input.
      const output = renderOutput(graded, renderer.toneMapping, renderer.outputColorSpace);
      const antialiased = aa === "fxaa" ? fxaa(output) : output;
      post.outputNode = nodeObject(film(antialiased, float(0.028)));
    }

    return { post, bloomNode };
  }, [
    renderer,
    scene,
    camera,
    aa,
    bloomQuality,
    bloomResolutionScale,
    msaaSamples,
    premiumPost,
    env,
    uCA,
    uMotionBlur,
    uShafts,
    uSunScreen,
    uVignette,
  ]);

  useEffect(() => () => {
    disposePostResources(setup.post.outputNode);
    setup.post.dispose();
  }, [setup]);

  const caSmooth = useRef(0);
  const motionSmooth = useRef(0);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.08);
    // Bloom breathes with flow, spikes on boost and lightning.
    setup.bloomNode.strength.value =
      (0.58 + env.uFlow.value * 0.3 + world.boostCharge * 0.42 +
        env.uFlash.value * (reduceFlash ? 0.1 : 0.4) +
        env.uFlowPulse.value * 0.24 +
        env.uShieldPulse.value * 0.12) * bloomQuality;
    setup.bloomNode.radius.value = 0.4 + world.boostCharge * (reduceMotion ? 0.08 : 0.25);
    setup.bloomNode.setResolutionScale(
      effectResolutionScale(bloomResolutionScale, env.uDrsScale.value,
        renderer.getPixelRatio(), EFFECT_PIXEL_DENSITY.bloom),
    );

    const caScale = reduceMotion || highContrast ? 0 : 1;
    const targetCA =
      (0.025 + world.speedNorm * 0.12 + world.boostCharge * 0.38 + env.uDeath.value * 0.5) * caScale;
    caSmooth.current = damp(caSmooth.current, targetCA, 6, dt);
    uCA.value = caSmooth.current;
    uVignette.value = 0.6 + world.boostCharge * 0.3 + env.uDeath.value * 0.5;
    const motionTarget = reduceMotion || highContrast
      ? 0
      : Math.max(0, world.speedNorm - 0.45) * 0.45 + world.boostCharge * 0.8;
    motionSmooth.current = damp(motionSmooth.current, motionTarget, 5, dt);
    uMotionBlur.value = motionSmooth.current;
    // Screen-space atmosphere must follow the actual sky source through banks
    // and jumps, instead of painting an unrelated fixed light over the course.
    projectedSun.set(...SUN_DIRECTION).multiplyScalar(1000).add(camera.position).project(camera);
    uSunScreen.value.set(projectedSun.x * 0.5 + 0.5, 0.5 - projectedSun.y * 0.5);
    uShafts.value =
      (0.28 + env.uTransition.value * 0.55 + env.uFlash.value * 0.75) *
      env.uSkyEnergy.value *
      (reduceFlash ? 0.35 : 1) * (projectedSun.z < 1 && projectedSun.z > -1 ? 1 : 0);

    setup.post.render();
  }, 1);

  return null;
}
