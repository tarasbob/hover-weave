"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { attribute, float, vec4 } from "three/tsl";
import { useGameBundle } from "../GameController";
import { createRng } from "../core/rng";
import { CRAFT } from "../core/constants";
import { TRAILS, useMeta } from "../state/meta";
import { useSettings } from "../state/settings";
import { crashCenter, type CrashOrigin } from "./crashMotion";

interface Particle {
  alive: boolean;
  /** Track-space coordinates (s converts to z each frame). */
  x: number; y: number; s: number;
  vx: number; vy: number; vs: number;
  drag: number; grav: number;
  age: number; life: number;
  size0: number; size1: number;
  r: number; g: number; b: number; a: number;
  /** 0 = billboard spark, 1 = z-stretched streak. */
  kind: 0 | 1;
  stretch: number;
  /** Wreck sparks stay in the cinematic frame after the road stops gliding. */
  crash: boolean;
}

const rng = createRng("particles-visual");

/**
 * One pooled CPU particle system for every effect: near-miss sparks, shard
 * bursts, crash shatter, boost embers, speed streaks, ambient motes.
 * Instanced quads, additive, colored per instance. Backend-agnostic.
 */
export function Particles({ max }: { max: number }) {
  const { world, env } = useGameBundle();
  const camera = useThree((s) => s.camera);
  const trailId = useMeta((s) => s.selectedTrail);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const reduceFlash = useSettings((s) => s.reduceFlash);
  const trailColor = useMemo(
    () => new THREE.Color((TRAILS.find((t) => t.id === trailId) ?? TRAILS[0]).color),
    [trailId],
  );

  const sys = useMemo(() => {
    const pool: Particle[] = Array.from({ length: max }, () => ({
      alive: false, x: 0, y: 0, s: 0, vx: 0, vy: 0, vs: 0,
      drag: 0, grav: 0, age: 0, life: 1, size0: 1, size1: 1,
      r: 1, g: 1, b: 1, a: 1, kind: 0 as const, stretch: 1, crash: false,
    }));
    let cursor = 0;

    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    colorAttr.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("aColor", colorAttr);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.blending = THREE.AdditiveBlending;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    const aColor = attribute<"vec4">("aColor", "vec4");
    mat.colorNode = vec4(aColor.xyz, float(1));
    mat.opacityNode = aColor.w;

    const mesh = new THREE.InstancedMesh(geo, mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;

    const spawn = (p: Partial<Particle>): void => {
      const it = pool[cursor];
      cursor = (cursor + 1) % pool.length;
      Object.assign(it, {
        alive: true, age: 0, drag: 0, grav: 0, vx: 0, vy: 0, vs: 0,
        kind: 0, stretch: 1, a: 1, size1: 0, crash: false,
      }, p);
    };

    return { pool, mesh, colorAttr, spawn, deathClock: 0, crashOrigin: null as CrashOrigin | null };
  }, [max]);

  useEffect(() => {
    return () => {
      sys.mesh.geometry.dispose();
      (sys.mesh.material as THREE.Material).dispose();
    };
  }, [sys]);

  const emit = useMemo(() => ({ ember: 0, streak: 0, mote: 0, magnet: 0, crash: 0 }), []);

  // --- Event-driven bursts -------------------------------------------------
  useEffect(() => {
    const c = new THREE.Color();
    const burstScale = Math.min(reduceMotion ? 0.4 : 1, reduceFlash ? 0.58 : 1);
    const brightness = reduceFlash ? 0.62 : 1;
    const offs = [
      world.events.on("runStart", () => {
        for (const particle of sys.pool) particle.alive = false;
        sys.deathClock = 0;
        sys.crashOrigin = null;
        emit.crash = 0;
      }),
      world.events.on("nearMiss", (e) => {
        c.copy(env.uWarn.value);
        const gradeCount = e.grade === "perfect" ? 24 : e.grade === "razor" ? 16 : 10;
        const chainBonus = Math.min(16, Math.max(0, e.chain - 1) * 3);
        const count = Math.max(4, Math.round((gradeCount + chainBonus) * burstScale));
        const energy = reduceFlash ? 1.35 : 2 + e.precision * 0.7;
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: e.x + (world.x - e.x) * 0.5, y: CRAFT.HOVER_HEIGHT + rng.range(-0.4, 0.6), s: e.s,
            vx: rng.range(-6, 6), vy: rng.range(2, 9), vs: rng.range(-4, 4),
            grav: -14, drag: 1.4, life: rng.range(0.3, 0.65),
            size0: rng.range(0.1, 0.24), size1: 0.02,
            r: c.r * energy, g: c.g * energy, b: c.b * energy,
          });
        }
      }),
      world.events.on("shard", (e) => {
        c.copy(env.uAccent.value);
        const count = Math.max(
          5,
          Math.round((12 + Math.min(8, e.combo) + (e.risk ? 8 : 0)) * burstScale),
        );
        for (let i = 0; i < count; i++) {
          const ang = rng.range(0, Math.PI * 2);
          sys.spawn({
            x: e.x, y: e.y, s: world.distance + 1,
            vx: Math.cos(ang) * rng.range(2, 7), vy: Math.sin(ang) * rng.range(2, 7) + 2,
            vs: rng.range(-2, 2),
            grav: -6, drag: 2.2, life: rng.range(0.35, 0.7),
            size0: rng.range(0.08, 0.2), size1: 0.01,
            r: c.r * 2.4 * brightness,
            g: c.g * 2.4 * brightness,
            b: c.b * 2.4 * brightness,
          });
        }
      }),
      world.events.on("shieldBreak", () => {
        c.copy(env.uWarn.value);
        const count = Math.max(8, Math.round(26 * burstScale));
        for (let i = 0; i < count; i++) {
          const ang = rng.range(0, Math.PI * 2);
          sys.spawn({
            x: world.x, y: CRAFT.HOVER_HEIGHT, s: world.distance,
            vx: Math.cos(ang) * rng.range(4, 13), vy: rng.range(1, 10),
            vs: rng.range(-6, 6),
            grav: -10, drag: 1.6, life: rng.range(0.4, 0.9),
            size0: rng.range(0.12, 0.3), size1: 0.02,
            r: c.r * 2.2 * brightness,
            g: c.g * 2.2 * brightness,
            b: c.b * 2.2 * brightness,
          });
        }
      }),
      world.events.on("shieldPickup", () => {
        c.copy(env.uWarn.value);
        const count = Math.max(6, Math.round(18 * burstScale));
        for (let i = 0; i < count; i++) {
          const ang = (i / count) * Math.PI * 2;
          sys.spawn({
            x: world.x + Math.cos(ang) * 0.7,
            y: CRAFT.HOVER_HEIGHT + Math.sin(ang) * 0.45,
            s: world.distance,
            vx: Math.cos(ang) * rng.range(1.5, 4),
            vy: rng.range(2, 7),
            vs: Math.sin(ang) * rng.range(1, 4),
            grav: -4,
            drag: 2.1,
            life: rng.range(0.45, 0.9),
            size0: rng.range(0.08, 0.2),
            size1: 0.01,
            r: c.r * 2.4 * brightness,
            g: c.g * 2.4 * brightness,
            b: c.b * 2.4 * brightness,
          });
        }
      }),
      world.events.on("boostStart", () => {
        c.copy(env.uAccent.value);
        const count = Math.max(6, Math.round(16 * burstScale));
        for (let i = 0; i < count; i++) {
          const ang = (i / count) * Math.PI * 2;
          sys.spawn({
            x: world.x + Math.cos(ang) * 0.55,
            y: CRAFT.HOVER_HEIGHT + Math.sin(ang) * 0.25,
            s: world.distance - 0.7,
            vx: Math.cos(ang) * rng.range(1, 4),
            vy: Math.sin(ang) * rng.range(1, 3),
            vs: rng.range(-18, -8),
            drag: 1.2,
            life: rng.range(0.28, 0.55),
            size0: rng.range(0.07, 0.18),
            size1: 0.01,
            r: c.r * 2.8 * brightness,
            g: c.g * 2.8 * brightness,
            b: c.b * 2.8 * brightness,
          });
        }
      }),
      world.events.on("boostEnd", () => {
        emit.ember = Math.min(emit.ember, 0.25);
      }),
      world.events.on("flowTier", (event) => {
        if (event.tier <= event.prev) return;
        c.copy(env.uPrimary.value);
        const count = Math.max(8, Math.round((10 + Math.min(event.tier, 8) * 4) * burstScale));
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: world.x + rng.range(-1.2, 1.2),
            y: CRAFT.HOVER_HEIGHT + rng.range(-0.2, 0.5),
            s: world.distance + rng.range(-1, 1),
            vx: rng.range(-6, 6),
            vy: rng.range(3, 11),
            vs: rng.range(-10, 3),
            grav: -8,
            drag: 1.8,
            life: rng.range(0.45, 0.9),
            size0: rng.range(0.07, 0.2),
            size1: 0.01,
            r: c.r * 2.2 * brightness,
            g: c.g * 2.2 * brightness,
            b: c.b * 2.2 * brightness,
          });
        }
      }),
      world.events.on("shatter", (e) => {
        // Glass breach: a wall of glinting shards blown forward and outward.
        c.copy(env.uAccent.value);
        const count = Math.max(10, Math.round(34 * burstScale));
        for (let i = 0; i < count; i++) {
          const white = rng.range(0.4, 1);
          sys.spawn({
            x: e.x + rng.range(-e.hx, e.hx) * 0.8,
            y: Math.max(0.3, e.y + rng.range(-e.hy, e.hy) * 0.8),
            s: e.s + rng.range(-0.5, 0.5),
            vx: rng.range(-8, 8),
            vy: rng.range(1, 11),
            vs: rng.range(4, 16),
            grav: -16, drag: 1.1, life: rng.range(0.35, 0.85),
            size0: rng.range(0.07, 0.2), size1: 0.01,
            r: (c.r + (1 - c.r) * white) * 2.2 * brightness,
            g: (c.g + (1 - c.g) * white) * 2.2 * brightness,
            b: (c.b + (1 - c.b) * white) * 2.2 * brightness,
          });
        }
      }),
      world.events.on("bounce", (e) => {
        // Bumper boing: a springy arc of sparks flung with the craft.
        c.copy(env.uWarn.value);
        const count = Math.max(6, Math.round(14 * burstScale));
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: e.x + e.dir * rng.range(0.4, 1.4),
            y: CRAFT.HOVER_HEIGHT + rng.range(-0.3, 0.5),
            s: e.s + rng.range(-0.6, 0.6),
            vx: e.dir * rng.range(5, 14),
            vy: rng.range(2, 8),
            vs: rng.range(-3, 3),
            grav: -12, drag: 1.5, life: rng.range(0.3, 0.6),
            size0: rng.range(0.09, 0.22), size1: 0.02,
            r: c.r * 2.3 * brightness,
            g: c.g * 2.3 * brightness,
            b: c.b * 2.3 * brightness,
          });
        }
      }),
      world.events.on("launch", (e) => {
        // Lip dust: a fan of sparks kicked back off the wedge crest.
        c.copy(env.uAccent.value);
        const count = Math.max(6, Math.round((10 + e.vy * 1.2) * burstScale));
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: e.x + rng.range(-1.6, 1.6),
            y: world.y + rng.range(-0.4, 0.3),
            s: e.s + rng.range(-1.2, 0.4),
            vx: rng.range(-5, 5),
            vy: rng.range(-2, 4),
            vs: rng.range(-20, -9),
            grav: -9, drag: 1.2, life: rng.range(0.3, 0.7),
            size0: rng.range(0.08, 0.2), size1: 0.02,
            r: c.r * 2 * brightness,
            g: c.g * 2 * brightness,
            b: c.b * 2 * brightness,
          });
        }
      }),
      world.events.on("airJump", (e) => {
        // Double jump: a downward-blown pressure ring under the hull —
        // apex-quality taps flash brighter and wider.
        c.copy(env.uAccent.value);
        const count = Math.max(6, Math.round((8 + e.quality * 8) * burstScale));
        for (let i = 0; i < count; i++) {
          const ang = (i / count) * Math.PI * 2;
          sys.spawn({
            x: e.x + Math.cos(ang) * 0.5,
            y: e.y - 0.35,
            s: e.s + Math.sin(ang) * 0.5,
            vx: Math.cos(ang) * rng.range(2, 5 + e.quality * 3),
            vy: rng.range(-6, -2.5),
            vs: Math.sin(ang) * rng.range(2, 5) - 6,
            grav: -4, drag: 1.8, life: rng.range(0.25, 0.5),
            size0: rng.range(0.08, 0.2), size1: 0.02,
            r: c.r * (1.6 + e.quality) * brightness,
            g: c.g * (1.6 + e.quality) * brightness,
            b: c.b * (1.6 + e.quality) * brightness,
          });
        }
      }),
      world.events.on("land", (e) => {
        // Touchdown wash: ground dust ring, sized by impact; a perfect flare
        // flashes accent, a slam churns warn-colored debris.
        c.copy(
          e.grade === "perfect" ? env.uAccent.value
          : e.grade === "hard" ? env.uWarn.value
          : env.uDim.value,
        );
        const energy = e.grade === "perfect" ? 2.6 : e.grade === "hard" ? 2.2 : 1.4;
        const count = Math.max(
          5,
          Math.round((8 + e.impact * 1.6 + (e.grade === "perfect" ? 10 : 0)) * burstScale),
        );
        for (let i = 0; i < count; i++) {
          const ang = rng.range(0, Math.PI * 2);
          const sp = rng.range(2, 6 + e.impact * 0.5);
          sys.spawn({
            x: e.x + Math.cos(ang) * rng.range(0.3, 1),
            y: 0.25 + rng.range(0, 0.3),
            s: e.s + Math.sin(ang) * rng.range(0.3, 1),
            vx: Math.cos(ang) * sp,
            vy: rng.range(0.5, 2.5 + e.impact * 0.25),
            vs: Math.sin(ang) * sp - 4,
            grav: -10, drag: 1.6, life: rng.range(0.3, 0.7),
            size0: rng.range(0.09, 0.24), size1: 0.02,
            r: c.r * energy * brightness,
            g: c.g * energy * brightness,
            b: c.b * energy * brightness,
          });
        }
      }),
      world.events.on("lightning", ({ intensity }) => {
        c.copy(env.uWarn.value);
        const count = Math.max(4, Math.round(14 * burstScale * intensity));
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: world.x + rng.range(-28, 28),
            y: rng.range(5, 16),
            s: world.distance + rng.range(35, 140),
            vy: rng.range(-18, -8),
            kind: 1,
            stretch: rng.range(5, 11),
            life: rng.range(0.25, 0.55),
            size0: rng.range(0.02, 0.05),
            size1: 0.01,
            r: c.r * 1.8 * brightness,
            g: c.g * 1.8 * brightness,
            b: c.b * 1.8 * brightness,
            a: 0.65,
          });
        }
      }),
      world.events.on("death", (event) => {
        sys.deathClock = 0;
        sys.crashOrigin = { ...event };
        emit.crash = 0;
        const count = Math.max(18, Math.round(70 * burstScale));
        for (let i = 0; i < count; i++) {
          const hot = rng.chance(0.45);
          c.copy(hot ? env.uWarn.value : env.uPrimary.value);
          const ang = rng.range(0, Math.PI * 2);
          const sp = rng.range(2, 8) * (reduceMotion ? 0.4 : 1);
          sys.spawn({
            x: event.x, y: event.y + rng.range(-0.15, 0.3), s: 0, crash: true,
            vx: Math.cos(ang) * sp + event.latVel * 0.12, vy: rng.range(1.5, 6),
            vs: event.cause === "edge" ? rng.range(-2, 5) : rng.range(-6, -1),
            grav: -7, drag: 1.1, life: rng.range(1.1, 2.5),
            size0: rng.range(0.08, 0.24), size1: 0.01,
            r: c.r * 2.4 * brightness,
            g: c.g * 2.4 * brightness,
            b: c.b * 2.4 * brightness,
          });
        }
      }),
      world.events.on("slabFall", (e) => {
        c.copy(env.uDim.value);
        const count = Math.max(3, Math.round(8 * burstScale));
        for (let i = 0; i < count; i++) {
          sys.spawn({
            x: e.x + rng.range(-2, 2), y: 0.3, s: e.s + rng.range(-1.5, 1.5),
            vx: rng.range(-5, 5), vy: rng.range(1, 5), vs: rng.range(-3, 3),
            grav: -4, drag: 2.4, life: rng.range(0.5, 1),
            size0: rng.range(0.3, 0.7), size1: 0.9,
            r: c.r * 0.9, g: c.g * 0.9, b: c.b * 0.9, a: 0.5,
          });
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world, env, sys, emit, reduceMotion, reduceFlash]);

  // --- Per-frame: continuous emitters + simulation --------------------------
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();

  useFrame((_, rawDt) => {
    if (document.hidden) return;
    const dead = world.status === "dead";
    const dt = dead
      ? Math.min(0.25, Math.max(0, world.deathTimer - sys.deathClock))
      : Math.min(rawDt, 0.08);
    sys.deathClock = world.deathTimer;
    const running = world.status === "running";
    const dist = world.status === "idle" ? 0 : world.renderDistance;
    const continuousScale = reduceMotion ? 0.35 : reduceFlash ? 0.65 : 1;

    // Lingering embers trace the falling wreck after the initial impact burst.
    if (dead && sys.crashOrigin && world.deathTimer < 1.7) {
      const center = crashCenter(sys.crashOrigin, world.deathTimer, reduceMotion);
      emit.crash += dt * 22 * continuousScale * (1 - world.deathTimer / 2);
      while (emit.crash >= 1) {
        emit.crash -= 1;
        const c = env.uWarn.value;
        sys.spawn({
          x: center.x + rng.range(-0.65, 0.65), y: center.y + rng.range(0, 0.5),
          s: -center.z, crash: true,
          vx: rng.range(-0.7, 0.7), vy: rng.range(0.5, 1.8), vs: rng.range(-0.6, 0.8),
          drag: 1, grav: -1.5, life: rng.range(0.65, 1.35),
          size0: rng.range(0.06, 0.14), size1: 0.01,
          r: c.r * 1.8, g: c.g * 1.8, b: c.b * 1.8, a: reduceFlash ? 0.4 : 0.75,
        });
      }
    }

    // Boost embers.
    if (running && world.boostCharge > 0.15) {
      emit.ember += dt * 90 * world.boostCharge * continuousScale;
      while (emit.ember >= 1) {
        emit.ember -= 1;
        const side = rng.sign();
        sys.spawn({
          x: world.x + side * 0.42, y: CRAFT.HOVER_HEIGHT - 0.05, s: dist - 0.8,
          vx: rng.range(-1.5, 1.5) - world.latVel * 0.15, vy: rng.range(-0.5, 1.2),
          vs: rng.range(-26, -14),
          drag: 0.6, life: rng.range(0.25, 0.6),
          size0: rng.range(0.06, 0.16), size1: 0.01,
          r: trailColor.r * 2.6, g: trailColor.g * 2.6, b: trailColor.b * 2.6,
        });
      }
    }

    // Magnetic collection wakes make shards visibly arc toward the craft.
    if (running && !reduceMotion) {
      const seeking = world.pickups.filter(
        (pickup) => pickup.active && pickup.type === "shard" && pickup.seeking,
      );
      emit.magnet += dt * Math.min(36, seeking.length * 14);
      while (emit.magnet >= 1 && seeking.length > 0) {
        emit.magnet -= 1;
        const pickup = seeking[Math.floor(rng.next() * seeking.length)];
        const c = env.uAccent.value;
        sys.spawn({
          x: pickup.x + rng.range(-0.1, 0.1),
          y: pickup.y + rng.range(-0.1, 0.1),
          s: pickup.s,
          vx: (world.x - pickup.x) * 1.4,
          vy: (CRAFT.HOVER_HEIGHT - pickup.y) * 1.4,
          vs: (world.distance - pickup.s) * 1.4,
          drag: 4.5,
          life: rng.range(0.18, 0.34),
          size0: rng.range(0.035, 0.075),
          size1: 0.01,
          r: c.r * 2.2,
          g: c.g * 2.2,
          b: c.b * 2.2,
          a: 0.8,
        });
      }
    }

    // Speed streaks (stronger with speed/flow/boost).
    if (running) {
      const rate = 6 + world.speedNorm * 26 + world.boostCharge * 60 + world.flowTier * 4;
      emit.streak += dt * rate * (reduceMotion ? 0.25 : reduceFlash ? 0.6 : 1);
      while (emit.streak >= 1) {
        emit.streak -= 1;
        const side = rng.sign();
        sys.spawn({
          x: world.x + side * rng.range(4, 16), y: rng.range(0.6, 7), s: dist + rng.range(50, 110),
          vs: 0, kind: 1, stretch: rng.range(6, 16),
          life: rng.range(0.8, 1.6),
          size0: rng.range(0.02, 0.05), size1: 0.02,
          r: env.uAccent.value.r * 1.45,
          g: env.uAccent.value.g * 1.45,
          b: env.uAccent.value.b * 1.45,
          a: 0.5 + world.boostCharge * 0.5,
        });
      }
    }

    // Ambient motes drifting near the ground.
    const biomeMotes =
      env.uBiomeMix.value.x * 1.15 +
      env.uBiomeMix.value.y * 0.72 +
      env.uBiomeMix.value.z * 0.5 +
      env.uBiomeMix.value.w * 1.35;
    emit.mote += dt * (reduceMotion ? 3 : 10) * biomeMotes;
    while (emit.mote >= 1) {
      emit.mote -= 1;
      const c = env.uAccent.value;
      sys.spawn({
        x: rng.range(-30, 30), y: rng.range(0.4, 5), s: dist + rng.range(20, 90),
        vx: rng.range(-0.5, 0.5), vy: rng.range(0.1, 0.7), vs: 0,
        life: rng.range(1.5, 3), size0: rng.range(0.03, 0.09), size1: 0.01,
        r: c.r * 1.2, g: c.g * 1.2, b: c.b * 1.2, a: 0.7,
      });
    }

    // Simulate + write instances.
    _q.copy(camera.quaternion);
    let count = 0;
    const attrArr = sys.colorAttr.array as Float32Array;
    for (const p of sys.pool) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      p.vy += p.grav * dt;
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy *= dr; p.vs *= dr;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.s += p.vs * dt;

      const z = p.crash ? -p.s : -(p.s - dist);
      if (z > 24 || z < -420) {
        p.alive = false;
        continue;
      }

      const t = p.age / p.life;
      const size = p.size0 + (p.size1 - p.size0) * t;
      const fade = p.a * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);

      _p.set(p.x, p.y, z);
      if (p.kind === 1) {
        // Streak: plane rotated so its width runs along the track (z).
        _e.set(0, Math.PI / 2, 0);
        _s.set(size * p.stretch * (1 + world.speedNorm * 2), size, 1);
        _m.compose(_p, _q.setFromEuler(_e), _s);
      } else {
        _s.set(size, size, size);
        _m.compose(_p, _q.copy(camera.quaternion), _s);
      }
      sys.mesh.setMatrixAt(count, _m);
      const o = count * 4;
      attrArr[o] = p.r;
      attrArr[o + 1] = p.g;
      attrArr[o + 2] = p.b;
      attrArr[o + 3] = fade;
      count++;
    }
    sys.mesh.count = count;
    sys.mesh.instanceMatrix.needsUpdate = true;
    sys.colorAttr.needsUpdate = true;
  });

  return <primitive object={sys.mesh} />;
}
