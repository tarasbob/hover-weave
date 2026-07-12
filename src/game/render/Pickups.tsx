"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  dot,
  float,
  instancedBufferAttribute,
  mix,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  step,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { POOL_SIZES, TRACK } from "../core/constants";
import { smoothstep } from "../core/mathUtils";

const SHARD_CAP = POOL_SIZES.shard;
const SHIELD_CAP = POOL_SIZES.shield;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** Energy shards (spinning octahedra) + shield orbs, instanced. */
export function Pickups() {
  const { world, env } = useGameBundle();

  const { shardMesh, shieldMesh, shardData, beaconLight } = useMemo(() => {
    const shardGeometry = new THREE.OctahedronGeometry(0.42, 1);
    const pickupData = new THREE.InstancedBufferAttribute(new Float32Array(SHARD_CAP * 2), 2);
    pickupData.setUsage(THREE.DynamicDrawUsage);
    shardGeometry.setAttribute("aPickupData", pickupData);
    const data = instancedBufferAttribute<"vec2">(pickupData, "vec2");
    const risk = step(0.5, data.x);
    const seeking = step(0.5, data.y);
    const shardColor = mix(env.uAccent, env.uWarn, risk);
    const shardMat = new THREE.MeshStandardNodeMaterial();
    shardMat.metalness = 0.48;
    shardMat.roughness = 0.12;
    shardMat.colorNode = shardColor.mul(risk.mul(0.18).add(0.28));
    shardMat.emissiveNode = Fn(() => {
      const pulse = sin(env.uTime.mul(risk.mul(2.8).add(5.2))).mul(0.22).add(1);
      return shardColor
        .mul(pulse)
        .mul(risk.mul(0.55).add(seeking.mul(0.45)).add(1.9));
    })();
    const shard = new THREE.InstancedMesh(
      shardGeometry,
      shardMat,
      SHARD_CAP,
    );
    shard.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shard.frustumCulled = false;

    const shieldMat = new THREE.MeshStandardNodeMaterial();
    shieldMat.metalness = 0.3;
    shieldMat.roughness = 0.25;
    shieldMat.colorNode = env.uWarn.mul(0.3);
    shieldMat.emissiveNode = Fn(() => {
      const fresnel = pow(saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))), 1.8);
      const pulse = sin(env.uTime.mul(3.4)).mul(0.25).add(1);
      return env.uWarn.mul(fresnel.mul(1.6).add(0.35)).mul(pulse).mul(1.6);
    })();
    const shield = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.62, 0.16, 10, 24),
      shieldMat,
      SHIELD_CAP,
    );
    shield.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shield.frustumCulled = false;

    const light = new THREE.PointLight("#ffd166", 0, 44, 2);
    return {
      shardMesh: shard,
      shieldMesh: shield,
      shardData: pickupData,
      beaconLight: light,
    };
  }, [env]);

  useEffect(() => {
    return () => {
      shardMesh.geometry.dispose();
      shieldMesh.geometry.dispose();
      (shardMesh.material as THREE.Material).dispose();
      (shieldMesh.material as THREE.Material).dispose();
    };
  }, [shardMesh, shieldMesh]);

  useFrame(() => {
    const dist = world.renderDistance;
    const t = world.time;
    let si = 0;
    let hi = 0;
    let nearestShield: { x: number; y: number; z: number; ahead: number } | null = null;

    for (const p of world.pickups) {
      if (!p.active) continue;
      const ahead = p.s - dist;
      const z = -ahead;
      if (z > 30 || ahead > TRACK.GEN_HORIZON) continue;
      const grow = smoothstep(TRACK.MATERIALIZE_START, TRACK.MATERIALIZE_END, ahead);

      if (p.type === "shard" && si < SHARD_CAP) {
        const index = si;
        const bob = Math.sin(t * 3.1 + p.id * 1.7) * 0.16;
        _p.set(p.x, p.y + bob, z);
        _e.set(
          p.magnetic ? 0 : Math.sin(t * 2.7 + p.id) * 0.28,
          t * (p.magnetic ? 2.4 : 3.8) + p.id,
          Math.PI * (p.magnetic ? 0.13 : 0.22),
        );
        _q.setFromEuler(_e);
        const riskScale = p.magnetic ? 1 : 1.32;
        const seekPulse = p.seeking ? 0.72 + Math.sin(t * 18 + p.id) * 0.08 : riskScale;
        const sc = seekPulse * Math.max(grow, 0.001);
        _s.set(sc, (p.magnetic ? 1.5 : 1.9) * sc, sc);
        _m.compose(_p, _q, _s);
        shardMesh.setMatrixAt(si++, _m);
        shardData.setXY(index, p.magnetic ? 0 : 1, p.seeking ? 1 : 0);
      } else if (p.type === "shield" && hi < SHIELD_CAP) {
        const bob = Math.sin(t * 2.2 + p.id) * 0.2;
        _p.set(p.x, p.y + 0.4 + bob, z);
        _e.set(t * 1.4, t * 0.9, 0);
        _q.setFromEuler(_e);
        const sc = 1.4 * Math.max(grow, 0.001);
        _s.set(sc, sc, sc);
        _m.compose(_p, _q, _s);
        shieldMesh.setMatrixAt(hi++, _m);
        if (!nearestShield || ahead < nearestShield.ahead) {
          nearestShield = { x: p.x, y: p.y + 0.4 + bob, z, ahead };
        }
      }
    }

    shardMesh.count = si;
    shieldMesh.count = hi;
    shardMesh.instanceMatrix.needsUpdate = true;
    shardData.needsUpdate = true;
    shieldMesh.instanceMatrix.needsUpdate = true;
    if (nearestShield && nearestShield.ahead < 120) {
      beaconLight.position.set(nearestShield.x, nearestShield.y, nearestShield.z);
      beaconLight.color.copy(env.uWarn.value);
      beaconLight.intensity =
        (1 - nearestShield.ahead / 120) * (8 + Math.sin(t * 3.4) * 2);
    } else {
      beaconLight.intensity = 0;
    }
  });

  return (
    <>
      <primitive object={shardMesh} />
      <primitive object={shieldMesh} />
      <primitive object={beaconLight} />
    </>
  );
}
