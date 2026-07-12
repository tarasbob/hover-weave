"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { float, mix, uniform } from "three/tsl";
import { useGameBundle } from "../GameController";
import { createRng } from "../core/rng";
import { useSettings } from "../state/settings";

interface BoltPoint {
  x: number;
  y: number;
  s: number;
}

const MAX_SEGMENTS = 22;
const UP = new THREE.Vector3(0, 1, 0);
const rng = createRng("lightning-visual");
const _start = new THREE.Vector3();
const _end = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/** Short-lived world-space bolts synchronized with storm flashes and thunder. */
export function Lightning() {
  const { world, env } = useGameBundle();
  const reduceFlash = useSettings((state) => state.reduceFlash);
  const reduceMotion = useSettings((state) => state.reduceMotion);
  const bolt = useRef<{ points: BoltPoint[]; life: number; intensity: number }>({
    points: [],
    life: 0,
    intensity: 0,
  });

  const { mesh, opacity } = useMemo(() => {
    const opacityNode = uniform(0);
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.colorNode = mix(env.uAccent, env.uWarn, float(0.42)).mul(opacityNode.mul(3.2));
    material.opacityNode = opacityNode;

    const geometry = new THREE.CylinderGeometry(0.028, 0.052, 1, 5, 1, true);
    const instanced = new THREE.InstancedMesh(geometry, material, MAX_SEGMENTS);
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instanced.frustumCulled = false;
    instanced.renderOrder = 12;
    instanced.count = 0;
    return { mesh: instanced, opacity: opacityNode };
  }, [env]);

  useEffect(() => {
    const off = world.events.on("lightning", ({ intensity }) => {
      const segments = reduceMotion ? 10 : MAX_SEGMENTS;
      const targetX = rng.range(-92, 92);
      const targetS = world.renderDistance + rng.range(125, 270);
      const points: BoltPoint[] = [];
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const taper = Math.sin(t * Math.PI);
        points.push({
          x: targetX * t + rng.range(-12, 12) * taper,
          y: 92 * (1 - t) + rng.range(-3.8, 3.8) * taper,
          s: targetS + rng.range(-7, 7) * taper,
        });
      }
      bolt.current = {
        points,
        life: reduceFlash ? 0.16 : 0.34,
        intensity: intensity * (reduceFlash ? 0.34 : 1),
      };
    });
    return off;
  }, [reduceFlash, reduceMotion, world]);

  useEffect(() => {
    return () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    };
  }, [mesh]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.08);
    const state = bolt.current;
    state.life = Math.max(0, state.life - dt);
    if (state.life <= 0 || state.points.length < 2) {
      mesh.count = 0;
      opacity.value = 0;
      return;
    }

    const fade = Math.min(1, state.life * 8) * state.intensity;
    opacity.value = fade;
    let count = 0;
    for (let i = 0; i < state.points.length - 1 && count < MAX_SEGMENTS; i++) {
      const a = state.points[i];
      const b = state.points[i + 1];
      _start.set(a.x, a.y, -(a.s - world.renderDistance));
      _end.set(b.x, b.y, -(b.s - world.renderDistance));
      _mid.copy(_start).add(_end).multiplyScalar(0.5);
      _direction.copy(_end).sub(_start);
      const length = _direction.length();
      if (length <= 0.001) continue;
      _rotation.setFromUnitVectors(UP, _direction.normalize());
      const width = 0.75 + state.intensity * 0.55;
      _scale.set(width, length, width);
      _matrix.compose(_mid, _rotation, _scale);
      mesh.setMatrixAt(count++, _matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
