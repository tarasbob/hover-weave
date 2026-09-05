"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { CRAFT } from "../core/constants";
import { damp, lerp } from "../core/mathUtils";
import { useSettings } from "../state/settings";
import { crashCenter, type CrashOrigin } from "./crashMotion";
import { chaseFraming } from "./cameraFraming";

/**
 * Chase camera: ship-anchored follow, bank roll, speed FOV, impact shake and a
 * death slow-mo pull-back.
 */
export function CameraRig() {
  const { world } = useGameBundle();
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const reduceMotion = useSettings((s) => s.reduceMotion);

  const state = useRef({
    x: 0,
    lookX: 0,
    craftX: 0,
    fov: 68,
    trauma: 0,
    roll: 0,
    nearWhip: 0,
    boostKick: 0,
    flowKick: 0,
    deathSpeed: 0,
    deathOrigin: null as CrashOrigin | null,
    deathCamera: new THREE.Vector3(),
    deathTarget: new THREE.Vector3(),
    /** Smoothed vertical follow of the craft's flight height. */
    lift: 0,
    launchKick: 0,
  });

  const target = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const offs = [
      world.events.on("runStart", () => {
        Object.assign(state.current, {
          x: world.x,
          lookX: world.x,
          craftX: world.x,
          trauma: 0,
          roll: 0,
          nearWhip: 0,
          boostKick: 0,
          flowKick: 0,
          deathSpeed: 0,
          deathOrigin: null,
          lift: 0,
          launchKick: 0,
        });
      }),
      world.events.on("death", (event) => {
        state.current.trauma = 1;
        state.current.deathSpeed = event.speed;
        state.current.deathOrigin = { ...event };
        state.current.deathCamera.copy(camera.position);
        state.current.deathTarget.copy(target);
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
      world.events.on("launch", (e) => {
        state.current.launchKick = Math.min(1, 0.4 + e.vy * 0.05);
      }),
      world.events.on("airJump", (e) => {
        state.current.launchKick = Math.max(state.current.launchKick, 0.25 + e.quality * 0.2);
      }),
      world.events.on("land", (e) => {
        if (e.grade === "hard") {
          state.current.trauma = Math.max(state.current.trauma, 0.42);
        } else if (e.grade === "perfect") {
          state.current.flowKick = Math.max(state.current.flowKick, 0.7);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world, camera, target]);

  useFrame((_, rawDt) => {
    if (document.hidden) return;
    const dt = Math.min(rawDt, 0.08);
    const s = state.current;
    const idle = world.status === "idle";
    const dead = world.status === "dead";
    const craftX = idle ? 0 : world.renderX;
    s.nearWhip = damp(s.nearWhip, 0, 9, dt);
    s.boostKick = damp(s.boostKick, 0, 7.5, dt);
    s.flowKick = damp(s.flowKick, 0, 3.6, dt);
    s.launchKick = damp(s.launchKick, 0, 2.6, dt);
    // Partial vertical follow: rise with the flight but keep some parallax so
    // altitude reads on screen instead of being cancelled by the camera.
    const liftTarget = idle ? 0 : Math.max(0, world.renderY - CRAFT.HOVER_HEIGHT) * 0.55;
    s.lift = damp(s.lift, liftTarget, 6, dt);

    // Curve anticipation: look (and lean) into the winding course ahead so
    // bends read as bends instead of a sideways-sliding field.
    const dist = idle ? 0 : world.renderDistance;
    const bendScale = reduceMotion ? 0.4 : 1;
    const bend = idle
      ? 0
      : (world.courseOffsetAt(dist + 78) - world.courseOffsetAt(dist + 6)) * bendScale;

    const whipScale = reduceMotion ? 0.18 : 1;
    const framing = chaseFraming(
      craftX, idle ? 0 : world.courseOffsetAt(dist), bend, s.nearWhip * whipScale, camera.aspect,
    );
    // Keep the ship anchored while it steers across a broad bend. Smoothing
    // absolute world x would leave several metres of camera lag at racing
    // speed, enough to crop the craft on a portrait display.
    const translation = craftX - s.craftX;
    s.x += translation;
    s.lookX += translation;
    s.craftX = craftX;
    s.x = damp(s.x, framing.x, 7.5, dt);
    s.lookX = damp(s.lookX, framing.lookX, 6, dt);

    const speedK = world.speedNorm;
    const motionScale = reduceMotion ? 0.25 : 1;
    const baseY = 4.5 + speedK * 0.8 - s.flowKick * 0.22 * motionScale + s.lift;
    const baseZ =
      8.6 - speedK * 0.7 + s.flowKick * 0.48 * motionScale + s.launchKick * 0.9 * motionScale;

    let px = s.x;
    let py = baseY;
    let pz = baseZ;

    if (dead && s.deathOrigin) {
      // Keep the actual breakup framed, including an outward flight off an edge.
      const center = crashCenter(s.deathOrigin, world.deathTimer, reduceMotion);
      const t = Math.min(world.deathTimer / 2.5, 1);
      const e = 1 - Math.pow(1 - t, 3);
      const impactScale = Math.min(1.35, 0.7 + s.deathSpeed / 140);
      py = s.deathCamera.y + e * 2.4 * impactScale * motionScale;
      pz = s.deathCamera.z + e * 4.6 * impactScale * motionScale;
      px = lerp(s.deathCamera.x, center.x, e * 0.8);
    }
    if (idle) {
      // Gentle cinematic drift on the title screen.
      const t = performance.now() * 0.0002;
      px += reduceMotion ? 0 : Math.sin(t) * 1.3;
      py = 4.9 + (reduceMotion ? 0 : Math.sin(t * 1.7) * 0.25);
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
    // The look target lifts with a fraction of the flight so the horizon
    // dips slightly during a jump — height becomes legible at a glance.
    target.set(s.lookX + shX * 0.4, 1.7 + shY * 0.3 + s.lift * 0.6, -13);
    if (dead && s.deathOrigin) {
      const center = crashCenter(s.deathOrigin, world.deathTimer, reduceMotion);
      const follow = 1 - Math.exp(-world.deathTimer * 3.5);
      target.set(
        lerp(s.deathTarget.x, center.x, follow),
        lerp(s.deathTarget.y, Math.max(0.25, center.y * 0.55), follow),
        lerp(s.deathTarget.z, center.z, follow),
      );
    }
    camera.lookAt(target);

    // Bank roll on top of lookAt (plus a light lean into upcoming bends).
    const bank = idle ? 0 : world.renderBank;
    s.roll = damp(s.roll, (bank * 0.28 - bend * 0.0045) * motionScale, 8, dt);
    camera.rotation.z += s.roll + shRoll;

    // FOV: speed + boost kick, a breath of air on launch, slight tunnel on death.
    const targetFov =
      66 + speedK * 13 + world.boostCharge * 9 - (dead ? 6 : 0) +
      Math.min(world.flowTier, 6) * 0.7 + s.boostKick * 4.2 * motionScale +
      s.flowKick * 1.4 * motionScale + s.launchKick * 3.2 * motionScale;
    s.fov = damp(s.fov, reduceMotion ? lerp(66, targetFov, 0.4) : targetFov, 4, dt);
    if (Math.abs(camera.fov - s.fov) > 0.01) {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }
  });

  return null;
}
