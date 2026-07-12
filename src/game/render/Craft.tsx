"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  color as tslColor,
  dot,
  float,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  sin,
  uniform,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { CRAFT } from "../core/constants";
import { CRAFTS, TRAILS, useMeta } from "../state/meta";
import { useSettings } from "../state/settings";

const TRAIL_POINTS = 44;

class TrailRibbon {
  geometry = new THREE.BufferGeometry();
  positions: Float32Array;
  history: { x: number; y: number; s: number }[] = [];
  private tArr: Float32Array;

  constructor() {
    // Two crossed quad strips (horizontal + vertical) per segment.
    const vertCount = TRAIL_POINTS * 4;
    this.positions = new Float32Array(vertCount * 3);
    this.tArr = new Float32Array(vertCount);
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      for (const off of [0, TRAIL_POINTS * 2]) {
        const a = off + i * 2, b = off + i * 2 + 1, c = off + i * 2 + 2, d = off + i * 2 + 3;
        indices.push(a, b, c, b, d, c);
      }
    }
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const t = i / (TRAIL_POINTS - 1);
      this.tArr[i * 2] = t;
      this.tArr[i * 2 + 1] = t;
      this.tArr[TRAIL_POINTS * 2 + i * 2] = t;
      this.tArr[TRAIL_POINTS * 2 + i * 2 + 1] = t;
    }
    this.geometry.setIndex(indices);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aT", new THREE.BufferAttribute(this.tArr, 1));
  }

  push(x: number, y: number, s: number): void {
    this.history.unshift({ x, y, s });
    if (this.history.length > TRAIL_POINTS) this.history.pop();
  }

  reset(): void {
    this.history.length = 0;
  }

  write(dist: number, width: number): void {
    const n = this.history.length;
    const pos = this.positions;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const h = this.history[Math.min(i, n - 1)] ?? { x: 0, y: -10, s: dist };
      const t = i / (TRAIL_POINTS - 1);
      const w = width * (1 - t) * (0.4 + 0.6 * (1 - t));
      const z = dist - h.s;
      // Horizontal blade.
      let o = i * 6;
      pos[o] = h.x - w; pos[o + 1] = h.y; pos[o + 2] = z;
      pos[o + 3] = h.x + w; pos[o + 4] = h.y; pos[o + 5] = z;
      // Vertical blade.
      o = TRAIL_POINTS * 6 + i * 6;
      pos[o] = h.x; pos[o + 1] = h.y - w; pos[o + 2] = z;
      pos[o + 3] = h.x; pos[o + 4] = h.y + w; pos[o + 5] = z;
    }
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}

export function Craft() {
  const { world, env } = useGameBundle();
  const selectedCraft = useMeta((s) => s.selectedCraft);
  const selectedTrail = useMeta((s) => s.selectedTrail);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const reduceFlash = useSettings((s) => s.reduceFlash);
  const design = CRAFTS.find((c) => c.id === selectedCraft) ?? CRAFTS[0];
  const trail = TRAILS.find((t) => t.id === selectedTrail) ?? TRAILS[0];

  // eslint-disable-next-line react-hooks/exhaustive-deps -- uniform identity must be stable; color is synced below
  const uTrailColor = useMemo(() => uniform(new THREE.Color(trail.color)), []);
  const uTrailBoost = useMemo(() => uniform(0), []);
  useEffect(() => {
    uTrailColor.value.set(trail.color);
  }, [trail.color, uTrailColor]);

  const { group, engineLight, shieldMesh } = useMemo(() => {
    const g = new THREE.Group();
    const bodyColor = new THREE.Color(design.body);
    const trimColor = new THREE.Color(design.trim);
    const engineColor = new THREE.Color(design.engine);
    const [sx, sy, sz] = design.hullScale;

    const hullMat = new THREE.MeshStandardNodeMaterial();
    hullMat.metalness = 0.85;
    hullMat.roughness = 0.28;
    hullMat.colorNode = tslColor(bodyColor.getHex());
    hullMat.emissiveNode = Fn(() => {
      const fresnel = pow(saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))), 2.6);
      const pulse = sin(env.uTime.mul(5)).mul(0.1).add(0.95);
      return tslColor(trimColor.getHex())
        .mul(fresnel)
        .mul(pulse)
        .mul(env.uBoost.mul(1.4).add(1))
        .add(env.uAccent.mul(env.uFlowPulse).mul(0.38));
    })();

    // Hull: stretched octahedron dart.
    const hull = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), hullMat);
    hull.scale.set(0.6 * sx, 0.3 * sy, 1.5 * sz);
    hull.castShadow = true;
    g.add(hull);

    // Canopy.
    const canopyMat = new THREE.MeshStandardNodeMaterial();
    canopyMat.metalness = 0.4;
    canopyMat.roughness = 0.12;
    canopyMat.colorNode = tslColor(0x0a0d18);
    canopyMat.emissiveNode = tslColor(trimColor.getHex()).mul(0.75);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), canopyMat);
    canopy.position.set(0, 0.22 * sy, -0.25);
    canopy.scale.set(0.8, 0.62, 1.5);
    g.add(canopy);

    // Fins.
    const finGeo = new THREE.BoxGeometry(0.72, 0.05, 0.5);
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(finGeo, hullMat);
      fin.position.set(side * 0.52 * sx, 0.02, 0.42 * sz);
      fin.rotation.y = -side * design.finSweep;
      fin.rotation.z = side * 0.16;
      fin.castShadow = true;
      g.add(fin);
    }

    // Engine pods + glow.
    const podMat = new THREE.MeshStandardNodeMaterial();
    podMat.metalness = 0.9;
    podMat.roughness = 0.35;
    podMat.colorNode = tslColor(0x11131f);
    podMat.emissiveNode = tslColor(engineColor.getHex()).mul(0.22);
    const glowMat = new THREE.MeshBasicNodeMaterial();
    glowMat.blending = THREE.AdditiveBlending;
    glowMat.transparent = true;
    glowMat.depthWrite = false;
    glowMat.colorNode = Fn(() => {
      const flick = sin(env.uTime.mul(30)).mul(0.08).add(0.92);
      return tslColor(engineColor.getHex())
        .mul(flick)
        .mul(
          env.uSpeedNorm.mul(1.4)
            .add(env.uBoost.mul(2.2))
            .add(env.uBoostPulse.mul(1.4))
            .add(0.9),
        );
    })();

    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.5, 10), podMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * 0.42 * sx, -0.02, 0.55 * sz);
      g.add(pod);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), glowMat);
      glow.position.set(side * 0.42 * sx, -0.02, 0.82 * sz);
      glow.scale.set(1, 1, 1.9);
      g.add(glow);
    }

    // Shield bubble.
    const shieldMat = new THREE.MeshBasicNodeMaterial();
    shieldMat.transparent = true;
    shieldMat.depthWrite = false;
    shieldMat.side = THREE.DoubleSide;
    shieldMat.blending = THREE.AdditiveBlending;
    shieldMat.colorNode = Fn(() => {
      const fresnel = pow(saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))), 3.2);
      const scan = sin(env.uTime.mul(14)).mul(0.12).add(0.88);
      return env.uAccent
        .mul(fresnel)
        .mul(scan)
        .mul(env.uShieldPulse.mul(reduceFlash ? 0.16 : 0.48).add(1.1));
    })();
    shieldMat.opacityNode = float(0.42).add(env.uShieldPulse.mul(reduceFlash ? 0.04 : 0.16));
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 2), shieldMat);
    shield.scale.setScalar(0.001);
    g.add(shield);

    const light = new THREE.PointLight(engineColor, 14, 26, 1.8);
    light.position.set(0, 0.4, 1.2);
    g.add(light);

    return { group: g, engineLight: light, shieldMesh: shield };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.id, env, reduceFlash]);

  const trails = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.blending = THREE.AdditiveBlending;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    const aT = attribute<"float">("aT", "float");
    mat.colorNode = uTrailColor
      .mul(float(1).sub(aT).pow(1.4))
      .mul(uTrailBoost.mul(1.65).add(env.uFlow.mul(0.45)).add(1.1));
    mat.opacityNode = float(1).sub(aT).pow(1.6).mul(
      env.uSpeedNorm.mul(0.55).add(env.uFlow.mul(0.16)).add(0.35),
    );

    const left = new TrailRibbon();
    const right = new TrailRibbon();
    const lMesh = new THREE.Mesh(left.geometry, mat);
    const rMesh = new THREE.Mesh(right.geometry, mat);
    lMesh.frustumCulled = false;
    rMesh.frustumCulled = false;
    return { left, right, lMesh, rMesh };
  }, [env, uTrailColor, uTrailBoost]);

  const shieldAnim = useRef(0);
  const shieldKick = useRef(0);
  const trailFlash = useRef(0);
  const deathSpin = useRef(new THREE.Vector3(2.3, 3.1, Math.PI * 2.4));

  useEffect(() => {
    const offs = [
      world.events.on("runStart", () => {
        trails.left.reset();
        trails.right.reset();
        trailFlash.current = 0;
      }),
      world.events.on("nearMiss", (event) => {
        if (event.grade === "perfect") trailFlash.current = 1;
      }),
      world.events.on("boostStart", () => {
        trailFlash.current = Math.max(trailFlash.current, 0.6);
      }),
      world.events.on("shieldPickup", () => {
        shieldKick.current = 1;
      }),
      world.events.on("shieldBreak", () => {
        shieldKick.current = -0.85;
      }),
      world.events.on("death", (event) => {
        deathSpin.current.set(
          event.obstacleKind === "ring" ? 1.2 : 2.3,
          event.obstacleKind === "pillar" ? 4.2 : 3.1,
          event.obstacleKind === "crystal" ? Math.PI * 3.1 : Math.PI * 2.4,
        );
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world, trails]);

  // Free GPU resources when a different craft design is selected.
  useEffect(() => {
    return () => {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    };
  }, [group]);

  useFrame((_, dt) => {
    const frameDt = Math.min(dt, 0.08);
    const idle = world.status === "idle";
    const dead = world.status === "dead";
    const dist = idle ? 0 : world.renderDistance;
    const x = idle ? 0 : world.renderX;
    const bank = idle ? Math.sin(performance.now() * 0.0011) * 0.08 : world.renderBank;
    const bob = Math.sin((idle ? performance.now() * 0.002 : world.time * 6.4)) * 0.06;
    const y = CRAFT.HOVER_HEIGHT + bob;

    if (dead) {
      const t = Math.min(world.deathTimer / 1.1, 1);
      const motion = reduceMotion ? 0.28 : 1;
      group.position.set(x + world.latVel * t * 0.025, y + t * 1.2 * motion, t * 3.4);
      group.rotation.set(
        -0.12 - t * deathSpin.current.x * motion,
        -world.latVel * 0.006 + t * deathSpin.current.y * motion,
        bank + t * deathSpin.current.z * motion,
      );
      group.scale.setScalar(1 - t * 0.18);
      group.visible = world.deathTimer < 1.08;
    } else {
      group.position.set(x, y, 0);
      group.rotation.set(
        0.02 - world.speedNorm * 0.04 - world.boostCharge * 0.09,
        -world.latVel * 0.006,
        bank,
      );
      group.scale.setScalar(1);
      group.visible = true;
    }

    trailFlash.current = Math.max(0, trailFlash.current - frameDt * 3.4);
    shieldKick.current += (0 - shieldKick.current) * Math.min(1, frameDt * 5.5);
    engineLight.intensity =
      10 + world.speedNorm * 14 + world.boostCharge * 26 + env.uBoostPulse.value * 12;
    uTrailBoost.value =
      world.boostCharge + env.uFlow.value * 0.25 + trailFlash.current * (reduceFlash ? 0.2 : 0.65);

    // Shield bubble scale animation.
    const target = world.hasShield ? 1 : 0;
    shieldAnim.current += (target - shieldAnim.current) * Math.min(1, dt * 8);
    const shieldScale = shieldAnim.current * (1 + Math.max(0, shieldKick.current) * 0.18);
    shieldMesh.scale.setScalar(Math.max(0.001, shieldScale));

    // Trails follow the engine pods.
    if (!dead) {
      const sx = design.hullScale[0];
      const sz = design.hullScale[2];
      const c = Math.cos(bank), s = Math.sin(bank);
      const podY = y - 0.02;
      const off = 0.42 * sx;
      trails.left.push(x + -off * c, podY + -off * s, dist - 0.55 * sz);
      trails.right.push(x + off * c, podY + off * s, dist - 0.55 * sz);
    }
    const trailWidth =
      0.09 + world.boostCharge * 0.1 + env.uFlow.value * 0.025 + trailFlash.current * 0.035;
    trails.left.write(dist, trailWidth);
    trails.right.write(dist, trailWidth);
  });

  return (
    <>
      <primitive object={group} />
      <primitive object={trails.lMesh} />
      <primitive object={trails.rMesh} />
    </>
  );
}
