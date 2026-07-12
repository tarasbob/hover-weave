"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { TRACK } from "../core/constants";
import { smoothstep } from "../core/mathUtils";
import { BIOMES, biomeIndexAt } from "../track/biomes";
import { createObstacleMaterial } from "./obstacleMaterial";

/**
 * Ambient, purely cosmetic scenery streamed alongside the track: crystal
 * spires, beacon buoys, storm shards, drifting ring fragments. Stateless —
 * every "slot" along the track derives its look from a hash of its index, so
 * the same stretch always decorates identically (and jumps cost nothing).
 */

const SLOT_SPACING = 21;
const FLOAT_SPACING = 47;

type DecorKind = "crystal" | "pillar" | "sphere" | "ring";

interface DecorPool {
  kind: DecorKind;
  mesh: THREE.InstancedMesh;
  attr: THREE.InstancedBufferAttribute;
  capacity: number;
  count: number;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** Deterministic hash -> [0, 1). */
function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface SlotDesc {
  kind: DecorKind;
  x: number;
  y: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  pitch: number;
  role: number; // 0 primary, 1 accent, 2 warn, 3 dim
  glow: number;
  bobAmp: number;
  bobSpeed: number;
  spin: number;
  phase: number;
}

/** Derive the decoration living at ground slot `i` (side ±1). */
function groundSlot(i: number, side: number, biome: number): SlotDesc | null {
  const h0 = hash01(i * 2 + (side > 0 ? 1 : 0));
  const h1 = hash01(i * 7919 + 13);
  const h2 = hash01(i * 104729 + 29);
  const h3 = hash01(i * 6151 + 47);
  if (h0 > BIOMES[biome].decorDensity) return null;

  const x = side * (48 + h1 * 125);
  const far = h1; // 0 near track .. 1 far out.
  const size = 1 + far * 2.2;

  switch (biome) {
    case 0: // Crystal desert: tilted spires.
      return {
        kind: h2 < 0.75 ? "crystal" : "pillar",
        x, y: 0,
        sx: (1.2 + h2 * 2.4) * size, sy: (3 + h3 * 9) * size, sz: (1.2 + h2 * 2) * size,
        yaw: h2 * Math.PI, pitch: (h3 - 0.5) * 0.35,
        role: h3 < 0.2 ? 1 : 3, glow: 0.5 + h3 * 0.5,
        bobAmp: 0, bobSpeed: 0, spin: 0, phase: 0,
      };
    case 1: // Digital ocean: beacon buoys + half-sunk arcs.
      if (h2 < 0.62) {
        return {
          kind: "sphere",
          x: side * (44 + h1 * 90), y: 1.1,
          sx: 0.9 + h3 * 1.4, sy: 0.9 + h3 * 1.4, sz: 0.9 + h3 * 1.4,
          yaw: 0, pitch: 0,
          role: h3 < 0.55 ? 1 : 0, glow: 0.9 + h3 * 0.9,
          bobAmp: 0.35 + h3 * 0.4, bobSpeed: 0.7 + h2, spin: 0, phase: h0 * 9,
        };
      }
      return {
        kind: "ring",
        x, y: -(2 + h3 * 4),
        sx: (4 + h3 * 7) * 1, sy: (4 + h3 * 7) * 1, sz: 2.2,
        yaw: (h2 - 0.5) * 0.8, pitch: 0,
        role: 3, glow: 0.55 + h3 * 0.4,
        bobAmp: 0, bobSpeed: 0, spin: 0, phase: 0,
      };
    case 2: // Storm front: jagged dark shards.
      return {
        kind: h2 < 0.6 ? "crystal" : "pillar",
        x, y: 0,
        sx: (1.5 + h2 * 3) * size, sy: (4 + h3 * 13) * size, sz: (1.5 + h2 * 2.4) * size,
        yaw: h2 * Math.PI, pitch: (h3 - 0.5) * 0.5,
        role: 3, glow: 0.35 + h3 * 0.35,
        bobAmp: 0, bobSpeed: 0, spin: 0, phase: 0,
      };
    default: // Void: sparse obelisks.
      if (h2 < 0.45) return null;
      return {
        kind: "pillar",
        x: side * (52 + h1 * 130), y: 0,
        sx: (0.8 + h2 * 1.6) * size, sy: (5 + h3 * 14) * size, sz: (0.8 + h2 * 1.6) * size,
        yaw: h2 * Math.PI, pitch: 0,
        role: h3 < 0.25 ? 0 : 3, glow: 0.5 + h3 * 0.6,
        bobAmp: 0, bobSpeed: 0, spin: 0, phase: 0,
      };
  }
}

/** Derive the floating decoration at float slot `i`. */
function floatSlot(i: number, biome: number): SlotDesc | null {
  const h0 = hash01(i * 3 + 101);
  const h1 = hash01(i * 12289 + 7);
  const h2 = hash01(i * 24593 + 3);
  const h3 = hash01(i * 49157 + 11);
  if (h0 > BIOMES[biome].decorDensity * 0.76) return null;

  const side = h1 < 0.5 ? -1 : 1;
  const x = side * (40 + h1 * 110);
  const y = 7 + h2 * 16;

  switch (biome) {
    case 0: // Floating crystal shards.
      return {
        kind: "crystal", x, y,
        sx: 0.7 + h3 * 1.6, sy: 1.2 + h3 * 2.6, sz: 0.7 + h3 * 1.4,
        yaw: h2 * Math.PI, pitch: (h3 - 0.5) * 0.7,
        role: h3 < 0.4 ? 1 : 3, glow: 0.8 + h3 * 0.8,
        bobAmp: 0.5 + h2 * 0.8, bobSpeed: 0.35 + h3 * 0.5, spin: 0.2 + h2 * 0.4, phase: h0 * 12,
      };
    case 1: // Drifting light orbs.
      if (h2 < 0.35) return null;
      return {
        kind: "sphere", x, y: 4 + h2 * 8,
        sx: 0.5 + h3 * 0.8, sy: 0.5 + h3 * 0.8, sz: 0.5 + h3 * 0.8,
        yaw: 0, pitch: 0,
        role: 1, glow: 1.2 + h3 * 1,
        bobAmp: 0.8 + h2, bobSpeed: 0.3 + h3 * 0.4, spin: 0, phase: h0 * 12,
      };
    case 2: // Storm: floating rubble.
      if (h2 < 0.5) return null;
      return {
        kind: "crystal", x, y: y + 4,
        sx: 0.8 + h3 * 1.8, sy: 0.9 + h3 * 1.8, sz: 0.8 + h3 * 1.5,
        yaw: h2 * Math.PI, pitch: (h3 - 0.5) * 1.2,
        role: 3, glow: 0.4 + h3 * 0.4,
        bobAmp: 0.6 + h2 * 0.9, bobSpeed: 0.25 + h3 * 0.35, spin: 0.3 + h2 * 0.5, phase: h0 * 12,
      };
    default: // Void: drifting ring fragments.
      return {
        kind: "ring", x, y: y + 3,
        sx: 2.5 + h3 * 6, sy: 2.5 + h3 * 6, sz: 1.6,
        yaw: h2 * Math.PI * 2, pitch: (h3 - 0.5) * 1.6,
        role: h3 < 0.3 ? 0 : 3, glow: 0.7 + h3 * 0.7,
        bobAmp: 0.7 + h2, bobSpeed: 0.2 + h3 * 0.3, spin: 0.15 + h2 * 0.35, phase: h0 * 12,
      };
  }
}

export function Decor() {
  const { world, env, ambient } = useGameBundle();

  const pools = useMemo(() => {
    const make = (kind: DecorKind, geo: THREE.BufferGeometry, capacity: number): DecorPool => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aData", attr);
      const mat = createObstacleMaterial(env, attr, {
        emissiveBase: 0.12,
        profile: kind === "crystal" ? "crystal" : kind === "ring" ? "ring" : "metal",
      });
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.count = 0;
      return { kind, mesh, attr, capacity, count: 0 };
    };
    return [
      make("crystal", new THREE.OctahedronGeometry(1.25, 0), 96),
      make("pillar", new THREE.CylinderGeometry(1, 1.18, 2, 6), 80),
      make("sphere", new THREE.IcosahedronGeometry(1, 2), 48),
      make("ring", new THREE.TorusGeometry(1, 0.16, 10, 36), 48),
    ] as DecorPool[];
  }, [env]);
  const poolByKind = useMemo(
    () => new Map(pools.map((pool) => [pool.kind, pool])),
    [pools],
  );

  useEffect(() => {
    return () => {
      for (const p of pools) {
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      }
    };
  }, [pools]);

  useFrame(() => {
    const dist = world.status === "idle" ? ambient.value : world.renderDistance;
    const t = world.status === "idle" ? performance.now() * 0.001 : world.time;
    for (const p of pools) p.count = 0;

    const place = (slot: SlotDesc, s: number) => {
      const pool = poolByKind.get(slot.kind);
      if (!pool || pool.count >= pool.capacity) return;
      const ahead = s - dist;
      const grow = smoothstep(TRACK.MATERIALIZE_START, TRACK.MATERIALIZE_END, ahead);
      if (grow <= 0.002) return;
      const bob = slot.bobAmp > 0 ? Math.sin(t * slot.bobSpeed + slot.phase) * slot.bobAmp : 0;
      _p.set(slot.x, slot.y + bob, -(ahead));
      _e.set(slot.pitch, slot.yaw + (slot.spin ? t * slot.spin : 0), 0);
      _q.setFromEuler(_e);
      _s.set(slot.sx, slot.sy, slot.sz).multiplyScalar(Math.max(grow, 0.001));
      _m.compose(_p, _q, _s);
      pool.mesh.setMatrixAt(pool.count, _m);
      pool.attr.setXY(pool.count, slot.role, slot.glow);
      pool.count++;
    };

    // Ground slots on both sides.
    const g0 = Math.floor((dist - 40) / SLOT_SPACING);
    const g1 = Math.ceil((dist + TRACK.GEN_HORIZON + 60) / SLOT_SPACING);
    for (let i = g0; i <= g1; i++) {
      const s = i * SLOT_SPACING + (hash01(i * 31 + 5) - 0.5) * SLOT_SPACING * 0.8;
      const biome = biomeIndexAt(s);
      for (const side of [-1, 1]) {
        const slot = groundSlot(i, side, biome);
        if (slot) place(slot, s);
      }
    }

    // Floaters.
    const f0 = Math.floor((dist - 40) / FLOAT_SPACING);
    const f1 = Math.ceil((dist + TRACK.GEN_HORIZON + 60) / FLOAT_SPACING);
    for (let i = f0; i <= f1; i++) {
      const s = i * FLOAT_SPACING + (hash01(i * 17 + 3) - 0.5) * FLOAT_SPACING * 0.7;
      const slot = floatSlot(i, biomeIndexAt(s));
      if (slot) place(slot, s);
    }

    for (const p of pools) {
      p.mesh.count = p.count;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.attr.needsUpdate = true;
    }
  });

  return (
    <>
      {pools.map((p) => (
        <primitive key={p.kind} object={p.mesh} />
      ))}
    </>
  );
}
