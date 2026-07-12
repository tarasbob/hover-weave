"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { densityFogFactor, fog, positionWorld, smoothstep } from "three/tsl";
import { useGameBundle } from "../GameController";
import { useGame } from "../state/game";
import { QUALITY_CONFIGS, resolveTier, useSettings } from "../state/settings";
import { CameraRig } from "./CameraRig";
import { Craft } from "./Craft";
import { Decor } from "./Decor";
import { ObstacleField } from "./ObstacleField";
import { Particles } from "./Particles";
import { Pickups } from "./Pickups";
import { PostFX } from "./PostFX";
import { SkyDome } from "./SkyDome";
import { Terrain } from "./Terrain";
import { Ocean } from "./Ocean";

const HUD_INTERVAL = 1 / 12;

export function GameScene() {
  const bundle = useGameBundle();
  const { world, input, env, audio, ambient } = bundle;
  const scene = useThree((s) => s.scene);
  const setDpr = useThree((s) => s.setDpr);

  const tier = useSettings((s) => resolveTier(s));
  const quality = QUALITY_CONFIGS[tier];
  const sensitivity = useSettings((s) => s.sensitivity);

  const hudClock = useRef(0);
  const fpsEma = useRef(16.7);
  const drs = useRef({ scale: 1, cooldown: 0 });

  // Height-aware exponential fog from env uniforms (denser near the ground,
  // thinning overhead so the sky stays crisp — but never so thin that tall
  // obstacles escape the fog and pop in at the generation horizon).
  useEffect(() => {
    const heightFactor = smoothstep(64, 3, positionWorld.y).mul(0.72).add(0.28);
    const factor = densityFogFactor(env.uFogDensity.mul(heightFactor));
    const s = scene as THREE.Scene & { fogNode: unknown };
    s.fogNode = fog(env.uFogColor, factor);
    return () => {
      s.fogNode = null;
    };
  }, [scene, env]);

  const dirLight = useMemo(() => {
    const l = new THREE.DirectionalLight("#c0bfff", 1.4);
    l.position.set(38, 64, -36);
    l.castShadow = quality.shadows;
    l.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    l.shadow.camera.near = 8;
    l.shadow.camera.far = 220;
    l.shadow.camera.left = -70;
    l.shadow.camera.right = 70;
    l.shadow.camera.top = 90;
    l.shadow.camera.bottom = -60;
    l.shadow.bias = -0.0015;
    return l;
  }, [quality.shadows, quality.shadowMapSize]);

  const ambientLight = useMemo(() => new THREE.AmbientLight("#8f9bff", 0.5), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const g = useGame.getState();

    // --- Input edges ---------------------------------------------------
    input.poll(sensitivity);
    if (input.consumeRestart()) {
      if (g.phase === "dead") bundle.restart();
      else if (g.phase === "title") bundle.startRun(g.mode);
    }
    if (input.consumePause()) {
      if (g.phase === "running" || g.phase === "paused") bundle.togglePause();
    }

    // --- Simulation ------------------------------------------------------
    // Frames longer than ~0.35s mean the tab was throttled/hidden; dropping
    // them keeps the craft from teleporting into obstacles.
    const throttled = rawDt > 0.35;
    if ((g.phase === "running" || g.phase === "dead") && !throttled) {
      world.update(dt, input.state);
    } else if (g.phase === "title") {
      ambient.value += dt * 9;
    }

    // --- Environment + audio ----------------------------------------------
    env.update(world, dt, ambient.value);
    audio.update(world, dt);
    dirLight.color.copy(env.lightColor);
    dirLight.intensity = env.lightIntensity + env.uFlash.value * 3.2;
    ambientLight.intensity = env.ambient + env.uFlash.value * 0.8;

    // --- HUD snapshot (throttled) -----------------------------------------
    hudClock.current += dt;
    if (hudClock.current >= HUD_INTERVAL) {
      hudClock.current = 0;
      if (g.phase === "running" || g.phase === "paused" || g.phase === "dead") {
        g.setHud({
          score: Math.floor(world.score),
          multiplier: world.flowMultiplier,
          flowTier: world.flowTier,
          flowFrac: (world.flowPoints % 5) / 5,
          energy: world.energy,
          boosting: world.boosting,
          shield: world.hasShield,
          speedKmh: Math.round(world.speed * 3.6),
          distance: Math.floor(world.distance),
          biome: env.biomeLabelAt(world.distance),
        });
      }
      // FPS + dynamic resolution.
      fpsEma.current = fpsEma.current * 0.9 + rawDt * 1000 * 0.1;
      g.setFps(Math.round(1000 / fpsEma.current));
      const d = drs.current;
      d.cooldown -= HUD_INTERVAL;
      if (d.cooldown <= 0) {
        if (fpsEma.current > 20 && d.scale > 0.6) {
          d.scale = Math.max(0.6, d.scale - 0.1);
          d.cooldown = 1.5;
          setDpr(Math.min(quality.maxDpr, window.devicePixelRatio) * d.scale);
        } else if (fpsEma.current < 13.5 && d.scale < 1) {
          d.scale = Math.min(1, d.scale + 0.1);
          d.cooldown = 2.5;
          setDpr(Math.min(quality.maxDpr, window.devicePixelRatio) * d.scale);
        }
      }
    }
  });

  return (
    <>
      <primitive object={dirLight} />
      <primitive object={dirLight.target} position={[0, 0, -40]} />
      <primitive object={ambientLight} />
      <SkyDome />
      <Terrain segments={quality.terrainSegments} />
      {quality.reflections && <Ocean />}
      <Decor />
      <ObstacleField shadows={quality.shadows} />
      <Pickups />
      <Craft />
      <Particles max={quality.maxParticles} />
      <CameraRig />
      <PostFX aa={quality.aa} bloomQuality={quality.bloomQuality} />
    </>
  );
}
