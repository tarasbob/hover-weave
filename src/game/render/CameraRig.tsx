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
    nearWhip: 0,
    boostKick: 0,
    flowKick: 0,
    deathSpeed: 0,
  });

  const target = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const offs = [
      world.events.on("death", (event) => {
        state.current.trauma = 1;
        state.current.deathSpeed = event.speed;
      }),
      world.events.on("shieldBreak", () => {
        state.current.trauma = Math.max(state.current.trauma, 0.65);
      }),
      world.events.on("nearMiss", (e) => {
        state.current.trauma = Math.max(state.current.trauma, 0.12 + e.precision * 0.2);
        state.current.nearWhip =
          Math.sign(e.x - world.x) * (0.35 + e.precision * 0.65);
      }),
      world.events.on("boostStart", () => {
        state.current.boostKick = 1;
      }),
      world.events.on("boostEnd", () => {
        state.current.boostKick = Math.min(state.current.boostKick, -0.35);
      }),
      world.events.on("flowTier", (event) => {
        if (event.tier > event.prev) {
          state.current.flowKick = Math.max(state.current.flowKick, 0.55 + event.tier * 0.1);
        }
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
    s.nearWhip = damp(s.nearWhip, 0, 9, dt);
    s.boostKick = damp(s.boostKick, 0, 7.5, dt);
    s.flowKick = damp(s.flowKick, 0, 3.6, dt);

    // Curve anticipation: look (and lean) into the winding course ahead so
    // bends read as bends instead of a sideways-sliding field.
    const dist = idle ? 0 : world.renderDistance;
    const bendScale = reduceMotion ? 0.4 : 1;
    const bend = idle
      ? 0
      : (world.courseOffsetAt(dist + 78) - world.courseOffsetAt(dist + 6)) * bendScale;

    s.x = damp(s.x, craftX * 0.92, 7.5, dt);
    const whipScale = reduceMotion ? 0.18 : 1;
    s.lookX = damp(s.lookX, craftX * 0.55 + s.nearWhip * whipScale + bend * 0.5, 6, dt);

    const speedK = world.speedNorm;
    const motionScale = reduceMotion ? 0.25 : 1;
    const baseY = 4.5 + speedK * 0.8 - s.flowKick * 0.22 * motionScale;
    const baseZ = 8.6 - speedK * 0.7 + s.flowKick * 0.48 * motionScale;

    let px = s.x;
    let py = baseY;
    let pz = baseZ;

    if (dead) {
      // Slow pull up + back while the wreck tumbles.
      const t = Math.min(world.deathTimer / 1.6, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const impactScale = Math.min(1.35, 0.7 + s.deathSpeed / 140);
      py += e * 4.2 * impactScale;
      pz += e * 7 * impactScale;
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

    // Bank roll on top of lookAt (plus a light lean into upcoming bends).
    const bank = idle ? 0 : world.renderBank;
    s.roll = damp(s.roll, bank * 0.34 - bend * 0.0045, 8, dt);
    camera.rotation.z += s.roll + shRoll;

    // FOV: speed + boost kick, slight tunnel on death.
    const targetFov =
      66 + speedK * 13 + world.boostCharge * 9 - (dead ? 6 : 0) +
      Math.min(world.flowTier, 6) * 0.7 + s.boostKick * 4.2 * motionScale + s.flowKick * 1.4 * motionScale;
    s.fov = damp(s.fov, reduceMotion ? lerp(66, targetFov, 0.4) : targetFov, 4, dt);
    if (Math.abs(camera.fov - s.fov) > 0.01) {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
