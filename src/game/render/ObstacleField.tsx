"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { LOOKAHEAD, POOL_SIZES } from "../core/constants";
import { smoothstep } from "../core/mathUtils";
import type { Obstacle, ObstacleKind } from "../core/types";
import { createObstacleMaterial } from "./obstacleMaterial";

const ROLE_INDEX: Record<string, number> = { primary: 0, accent: 1, warn: 2, dim: 3 };
const SETPIECE_IDS = new Set([
  "monolithKeyhole",
  "colossalArch",
  "gravityWell",
  "closingCanyon",
  "breathingRings",
  "turbineField",
  "apexGauntlet",
]);

interface KindPool {
  kind: ObstacleKind;
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

/**
 * Renders all live obstacles through per-kind instanced pools.
 * Matrices are rebuilt each frame from the sim (cheap: <300 actives).
 */
export function ObstacleField({ shadows }: { shadows: boolean }) {
  const { world, env } = useGameBundle();
  const nearFlash = useRef({ x: 0, s: 0, value: 0 });

  const pools = useMemo(() => {
    const make = (kind: ObstacleKind, geo: THREE.BufferGeometry, capacity: number, castShadow: boolean): KindPool => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("aData", attr);
      const mat = createObstacleMaterial(env, attr, {
        emissiveBase: kind === "ring" ? 0.5 : 0.05,
        profile: kind === "crystal" ? "crystal" : kind === "ring" ? "ring" : "metal",
      });
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow && shadows;
      mesh.receiveShadow = false;
      mesh.count = 0;
      return { kind, mesh, attr, capacity, count: 0 };
    };

    const box = new THREE.BoxGeometry(2, 2, 2);
    const pillar = new THREE.CylinderGeometry(1, 1.12, 2, 6);
    const crystal = new THREE.OctahedronGeometry(1.25, 0);
    const sphere = new THREE.IcosahedronGeometry(1, 2);
    const ring = new THREE.TorusGeometry(1, 0.22, 12, 48);

    return [
      make("box", box, POOL_SIZES.box, true),
      make("pillar", pillar, POOL_SIZES.pillar, true),
      make("crystal", crystal, POOL_SIZES.crystal, true),
      make("sphere", sphere, POOL_SIZES.sphere, true),
      make("ring", ring, POOL_SIZES.ring, false),
    ] as KindPool[];
  }, [env, shadows]);
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

  useEffect(() => {
    return world.events.on("nearMiss", (event) => {
      nearFlash.current = {
        x: event.x,
        s: event.s,
        value: 0.65 + event.precision * 0.85,
      };
    });
  }, [world]);

  useFrame((_, rawDt) => {
    const dist = world.renderDistance;
    // Materialize band tracks the speed-proportional view distance so growth
    // always happens deep inside the (equally scaled) fog.
    const matStart = env.viewDistance * LOOKAHEAD.MATERIALIZE_START_FRAC;
    const matEnd = env.viewDistance * LOOKAHEAD.MATERIALIZE_END_FRAC;
    nearFlash.current.value = Math.max(0, nearFlash.current.value - Math.min(rawDt, 0.08) * 4.2);
    for (const p of pools) p.count = 0;

    for (const o of world.obstacles) {
      if (!o.active) continue;
      const pool = poolByKind.get(o.kind) ?? pools[0];
      if (pool.count >= pool.capacity) continue;
      writeInstance(pool, pool.count++, o, dist, nearFlash.current, matStart, matEnd);
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

function writeInstance(
  pool: KindPool,
  i: number,
  o: Obstacle,
  dist: number,
  nearFlash: { x: number; s: number; value: number },
  matStart: number,
  matEnd: number,
): void {
  const ahead = o.cs - dist;
  const z = -ahead;
  _p.set(o.cx, o.cy, z);

  // Materialize deep inside the fog: scale up across the far band so nothing
  // ever pops into view.
  const grow = smoothstep(matStart, matEnd, ahead);

  switch (o.kind) {
    case "pillar":
      _s.set(o.hx, o.hy, o.hx);
      _e.set(0, o.cyaw, 0);
      break;
    case "crystal":
      _s.set(o.hx, o.hy, o.hs);
      _e.set(0, o.cyaw, 0);
      break;
    case "sphere":
      _s.set(o.hx, o.hy, o.hs);
      _e.set(0, 0, 0);
      break;
    case "ring": {
      const R = (o.inner + o.hx) / 2;
      _s.set(R, R, o.hs / 0.22);
      _e.set(0, 0, 0);
      break;
    }
    default:
      _s.set(o.hx, o.hy, o.hs);
      _e.set(0, o.cyaw, 0);
  }
  if (grow < 1) _s.multiplyScalar(Math.max(grow, 0.001));

  _q.setFromEuler(_e);
  _m.compose(_p, _q, _s);
  pool.mesh.setMatrixAt(i, _m);
  const isNearFlash =
    nearFlash.value > 0 &&
    Math.abs(o.cs - nearFlash.s) < Math.max(3, o.hs + 1.5) &&
    Math.abs(o.cx - nearFlash.x) < Math.max(4, o.hx + 2);
  const setpieceGlow = SETPIECE_IDS.has(o.patternId) ? 1.3 : 1;
  const reactiveGlow = isNearFlash ? nearFlash.value * 2.1 : 0;
  pool.attr.setXY(i, ROLE_INDEX[o.role] ?? 0, o.glow * setpieceGlow + reactiveGlow);
}
