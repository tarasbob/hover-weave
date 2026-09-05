"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { LOOKAHEAD } from "../core/constants";
import { smoothstep } from "../core/mathUtils";
import { BIOMES, biomeIndexAt } from "../track/biomes";
import { createObstacleMaterial } from "./obstacleMaterial";

type LandmarkKind = "ring" | "pillar" | "crystal";

interface LandmarkPool {
  kind: LandmarkKind;
  mesh: THREE.InstancedMesh;
  attr: THREE.InstancedBufferAttribute;
  count: number;
  capacity: number;
}

interface LandmarkPart {
  kind: LandmarkKind;
  x: number;
  y: number;
  scale: [number, number, number];
  rotation: [number, number, number];
  role: number;
  glow: number;
}

const SLOT_SPACING = 760;
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

function hash01(n: number): number {
  let h = (n | 0) ^ 0x7f4a7c15;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function landmarkParts(slot: number, biome: number): LandmarkPart[] {
  const side = hash01(slot * 17 + 3) < 0.5 ? -1 : 1;
  const wobble = hash01(slot * 97 + 11) - 0.5;
  const scale = BIOMES[biome].landmarkScale;

  switch (biome) {
    case 0:
      return [
        {
          kind: "ring",
          x: side * (235 + wobble * 45),
          y: 88,
          scale: [86 * scale, 86 * scale, 7],
          rotation: [0.12, wobble * 0.45, wobble * 0.2],
          role: 1,
          glow: 0.42,
        },
        {
          kind: "crystal",
          x: side * 178,
          y: 70 * scale,
          scale: [22 * scale, 70 * scale, 24 * scale],
          rotation: [wobble * 0.12, wobble * 2.2, 0],
          role: 3,
          glow: 0.32,
        },
      ];
    case 1:
      return [
        {
          kind: "pillar",
          x: side * (205 + wobble * 60),
          y: 72 * scale,
          scale: [14 * scale, 72 * scale, 14 * scale],
          rotation: [0, wobble, 0],
          role: 1,
          glow: 0.55,
        },
        {
          kind: "ring",
          x: side * 264,
          y: 46,
          scale: [42 * scale, 42 * scale, 5],
          rotation: [0, wobble * 0.4, 0],
          role: 0,
          glow: 0.38,
        },
      ];
    case 2:
      return [
        {
          kind: "ring",
          x: side * (225 + wobble * 70),
          y: 82,
          scale: [72 * scale, 72 * scale, 6],
          rotation: [0.4 + wobble * 0.3, wobble * 1.2, 0.28],
          role: 3,
          glow: 0.28,
        },
        {
          kind: "crystal",
          x: -side * 190,
          y: 62 * scale,
          scale: [28 * scale, 62 * scale, 20 * scale],
          rotation: [wobble * 0.4, wobble * 2.8, 0.18],
          role: 2,
          glow: 0.34,
        },
      ];
    default:
      return [
        {
          kind: "pillar",
          x: side * (198 + wobble * 35),
          y: 92 * scale,
          scale: [20 * scale, 92 * scale, 20 * scale],
          rotation: [0, wobble * 0.5, 0],
          role: 3,
          glow: 0.42,
        },
        {
          kind: "ring",
          x: -side * 248,
          y: 112,
          scale: [94 * scale, 94 * scale, 7],
          rotation: [0.05, wobble * 0.4, 0],
          role: 0,
          glow: 0.52,
        },
      ];
  }
}

/** Huge, non-collidable silhouettes that give each sector a memorable horizon. */
export function HorizonLandmarks() {
  const { world, env, ambient } = useGameBundle();

  const pools = useMemo(() => {
    const make = (
      kind: LandmarkKind,
      geometry: THREE.BufferGeometry,
      capacity: number,
    ): LandmarkPool => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("aData", attr);
      const material = createObstacleMaterial(env, attr, {
        emissiveBase: kind === "ring" ? 0.28 : 0.06,
        profile: kind === "crystal" ? "crystal" : kind === "ring" ? "ring" : "metal",
      });
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = -2;
      return { kind, mesh, attr, count: 0, capacity };
    };

    return [
      make("ring", new THREE.TorusGeometry(1, 0.035, 8, 72), 12),
      make("pillar", new THREE.CylinderGeometry(1, 1.35, 2, 8), 12),
      make("crystal", new THREE.OctahedronGeometry(1, 0), 12),
    ];
  }, [env]);

  const poolByKind = useMemo(
    () => new Map(pools.map((pool) => [pool.kind, pool])),
    [pools],
  );

  useEffect(() => {
    return () => {
      for (const pool of pools) {
        pool.mesh.geometry.dispose();
        (pool.mesh.material as THREE.Material).dispose();
      }
    };
  }, [pools]);

  useFrame(() => {
    const distance = world.status === "idle" ? ambient.value : world.renderDistance;
    const view = env.viewDistance;
    for (const pool of pools) pool.count = 0;

    const first = Math.floor((distance - 220) / SLOT_SPACING);
    const last = Math.ceil((distance + view + 260) / SLOT_SPACING);
    for (let slot = first; slot <= last; slot++) {
      const s = slot * SLOT_SPACING + 520;
      const ahead = s - distance;
      if (ahead < -260 || ahead > view + 260) continue;
      const grow = smoothstep(view + 220, view * LOOKAHEAD.MATERIALIZE_END_FRAC, ahead);
      if (grow <= 0.002) continue;

      for (const part of landmarkParts(slot, biomeIndexAt(s))) {
        const pool = poolByKind.get(part.kind);
        if (!pool || pool.count >= pool.capacity) continue;
        _position.set(part.x + world.courseOffsetAt(s), part.y, -ahead);
        _euler.set(...part.rotation);
        _rotation.setFromEuler(_euler);
        _scale.set(...part.scale).multiplyScalar(Math.max(0.001, grow));
        _matrix.compose(_position, _rotation, _scale);
        pool.mesh.setMatrixAt(pool.count, _matrix);
        pool.attr.setXY(pool.count, part.role, part.glow);
        pool.count++;
      }
    }

    for (const pool of pools) {
      pool.mesh.count = pool.count;
      pool.mesh.instanceMatrix.needsUpdate = true;
      pool.attr.needsUpdate = true;
    }
  });

  return (
    <>
      {pools.map((pool) => (
        <primitive key={pool.kind} object={pool.mesh} />
      ))}
    </>
  );
}
