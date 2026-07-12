"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { damp, lerp } from "../core/mathUtils";
import { useSettings } from "../state/settings";

/**
 * Chase camera: lateral lag, bank roll, speed FOV, impact shake and a
 * death slow-mo pull-back.
 */
export function CameraRig() {
  const { world } = useGameBundle();
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const reduceMotion = useSettings((s) => s.reduceMotion);

  const state = useRef({
    x: 0,
    lookX: 0,
    fov: 68,
    trauma: 0,
    roll: 0,
  });

  const target = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const offs = [
      world.events.on("death", () => {
        state.current.trauma = 1;
      }),
      world.events.on("shieldBreak", () => {
        state.current.trauma = Math.max(state.current.trauma, 0.65);
      }),
      world.events.on("nearMiss", () => {
        state.current.trauma = Math.max(state.current.trauma, 0.18);
      }),
      world.events.on("slabFall", (e) => {
        const d = Math.abs(e.s - world.distance);
        if (d < 60) state.current.trauma = Math.max(state.current.trauma, 0.3 - d * 0.004);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.08);
    const s = state.current;
    const idle = world.status === "idle";
    const dead = world.status === "dead";
    const craftX = idle ? 0 : world.renderX;

    s.x = damp(s.x, craftX * 0.92, 7.5, dt);
    s.lookX = damp(s.lookX, craftX * 0.55, 6, dt);

    const speedK = world.speedNorm;
    const baseY = 4.5 + speedK * 0.8;
    const baseZ = 8.6 - speedK * 0.7;

    let px = s.x;
    let py = baseY;
    let pz = baseZ;

    if (dead) {
      // Slow pull up + back while the wreck tumbles.
      const t = Math.min(world.deathTimer / 1.6, 1);
      const e = 1 - Math.pow(1 - t, 3);
      py += e * 4.2;
      pz += e * 7;
      px = damp(s.x, world.deathX, 4, dt);
    }
    if (idle) {
      // Gentle cinematic drift on the title screen.
      const t = performance.now() * 0.0002;
      px += Math.sin(t) * 2.2;
      py = 4.9 + Math.sin(t * 1.7) * 0.5;
      pz = 9.4;
    }

    // Impact shake (trauma^2 falloff, reduced-motion aware).
    s.trauma = Math.max(0, s.trauma - dt * (dead ? 0.55 : 1.6));
    const shakeAmp = reduceMotion ? 0.25 : 1;
    const sh = s.trauma * s.trauma * shakeAmp;
    const tt = performance.now() * 0.001;
    const shX = Math.sin(tt * 37.7) * sh * 0.42;
    const shY = Math.cos(tt * 43.3) * sh * 0.34;
    const shRoll = Math.sin(tt * 31.1) * sh * 0.05;

    camera.position.set(px + shX, py + shY, pz);
    target.set(s.lookX + shX * 0.4, 1.7 + shY * 0.3, -13);
    camera.lookAt(target);

    // Bank roll on top of lookAt.
    const bank = idle ? 0 : world.renderBank;
    s.roll = damp(s.roll, bank * 0.34, 8, dt);
    camera.rotation.z += s.roll + shRoll;

    // FOV: speed + boost kick, slight tunnel on death.
    const targetFov =
      66 + speedK * 13 + world.boostCharge * 9 - (dead ? 6 : 0) + world.flowTier * 0.7;
    s.fov = damp(s.fov, reduceMotion ? lerp(66, targetFov, 0.4) : targetFov, 4, dt);
    if (Math.abs(camera.fov - s.fov) > 0.01) {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
