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
import { CRAFT, FIXED_DT } from "../core/constants";
import { clamp } from "../core/mathUtils";
import { CRAFTS, TRAILS, useMeta } from "../state/meta";
import { useSettings } from "../state/settings";
import { createHullFragments, createHullGeometry, createWingGeometry } from "./craftGeometry";
import { CraftWreck } from "./CraftWreck";
import { TrailRibbon } from "./TrailRibbon";

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
  const uFlashScale = useMemo(() => uniform(1), []);
  useEffect(() => {
    uTrailColor.value.set(trail.color);
  }, [trail.color, uTrailColor]);
  useEffect(() => {
    uFlashScale.value = reduceFlash ? 0.2 : 1;
  }, [reduceFlash, uFlashScale]);

  const { group, engineLight, shieldMesh, exhausts, wreck } = useMemo(() => {
    const g = new THREE.Group();
    const wreck = new CraftWreck();
    const bodyColor = new THREE.Color(design.body);
    const trimColor = new THREE.Color(design.trim);
    const engineColor = new THREE.Color(design.engine);
    const [sx, sy, sz] = design.hullScale;

    const hullMat = new THREE.MeshStandardNodeMaterial();
    hullMat.metalness = 0.72;
    hullMat.roughness = 0.31;
    // Readable alloy panels carry the silhouette; energy belongs to the seams.
    hullMat.colorNode = tslColor(bodyColor.lerp(new THREE.Color("#566477"), 0.4).getHex());
    hullMat.emissiveNode = Fn(() => {
      const fresnel = pow(saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))), 2.6);
      return tslColor(trimColor.getHex())
        .mul(fresnel)
        .mul(env.uBoost.mul(0.26).add(0.2))
        .add(env.uAccent.mul(env.uFlowPulse).mul(0.12));
    })();

    const hull = new THREE.Mesh(createHullGeometry(), hullMat);
    hull.scale.set(sx, sy, sz);
    hull.castShadow = true;
    g.add(hull);
    for (const geometry of createHullFragments()) {
      const section = new THREE.Mesh(geometry, hullMat);
      section.scale.copy(hull.scale);
      section.castShadow = true;
      wreck.add(section);
    }

    // Canopy.
    const canopyMat = new THREE.MeshStandardNodeMaterial();
    canopyMat.metalness = 0.78;
    canopyMat.roughness = 0.1;
    canopyMat.colorNode = tslColor(0x0b2234);
    canopyMat.emissiveNode = Fn(() => {
      const rim = pow(saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))), 2.2);
      return tslColor(trimColor.getHex()).mul(rim.mul(0.32).add(0.035));
    })();
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), canopyMat);
    canopy.position.set(0, 0.2 * sy, -0.29 * sz);
    canopy.scale.set(0.19 * sx, 0.13 * sy, 0.48 * sz);
    g.add(canopy);
    wreck.add(canopy);

    // Swept wing plates, with inset light strips and mechanical trailing vents.
    const finGeo = createWingGeometry(design.finSweep);
    const seamMat = new THREE.MeshBasicNodeMaterial();
    seamMat.colorNode = tslColor(trimColor.getHex())
      .mul(env.uBoost.mul(0.65).add(env.uFlow.mul(0.2)).add(0.9));
    const seamGeo = new THREE.BoxGeometry(0.019, 0.012, 0.48);
    const ventGeo = new THREE.BoxGeometry(0.14, 0.012, 0.028);
    const ventMat = new THREE.MeshStandardNodeMaterial();
    ventMat.colorNode = tslColor(0x050910);
    ventMat.metalness = 0.55;
    ventMat.roughness = 0.5;
    for (const side of [-1, 1]) {
      const wingParts: THREE.Object3D[] = [];
      const fin = new THREE.Mesh(finGeo, hullMat);
      fin.scale.set(side * sx, sy, sz);
      fin.castShadow = true;
      g.add(fin);
      wingParts.push(fin);
      const seam = new THREE.Mesh(seamGeo, seamMat);
      seam.position.set(side * 0.28 * sx, 0.17 * sy, 0.17 * sz);
      seam.rotation.z = -side * 0.22;
      seam.scale.z = sz;
      g.add(seam);
      wingParts.push(seam);
      for (let vent = 0; vent < 3; vent++) {
        const slot = new THREE.Mesh(ventGeo, ventMat);
        slot.position.set(side * 0.64 * sx, 0.065 * sy, (0.49 + vent * 0.07) * sz);
        slot.rotation.y = -side * 0.18;
        g.add(slot);
        wingParts.push(slot);
      }
      wreck.add(...wingParts);
    }

    // Engine pods + glow.
    const podMat = new THREE.MeshStandardNodeMaterial();
    podMat.metalness = 0.9;
    podMat.roughness = 0.35;
    podMat.colorNode = tslColor(0x11131f);
    podMat.emissiveNode = tslColor(engineColor.getHex()).mul(0.045);
    const glowMat = new THREE.MeshBasicNodeMaterial();
    glowMat.blending = THREE.AdditiveBlending;
    glowMat.transparent = true;
    glowMat.depthWrite = false;
    glowMat.colorNode = Fn(() => {
      const flick = sin(env.uTime.mul(30)).mul(uFlashScale.mul(0.045)).add(0.955);
      return tslColor(engineColor.getHex())
        .mul(flick)
        .mul(
          env.uSpeedNorm.mul(1.4)
            .add(env.uBoost.mul(2.2))
            .add(env.uBoostPulse.mul(1.4))
            .add(0.9),
        );
    })();

    const exhausts: THREE.Mesh[] = [];
    const podGeo = new THREE.CylinderGeometry(0.145, 0.19, 0.6, 12);
    const nozzleGeo = new THREE.TorusGeometry(0.14, 0.026, 6, 16);
    const plumeGeo = new THREE.SphereGeometry(0.1, 10, 8);
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(podGeo, podMat);
      pod.rotation.x = Math.PI / 2;
      pod.position.set(side * 0.42 * sx, -0.02, 0.55 * sz);
      g.add(pod);
      const nozzle = new THREE.Mesh(nozzleGeo, seamMat);
      nozzle.position.set(side * 0.42 * sx, -0.02, 0.55 * sz + 0.31);
      g.add(nozzle);
      const glow = new THREE.Mesh(plumeGeo, glowMat);
      glow.position.set(side * 0.42 * sx, -0.02, 0.55 * sz + 0.34);
      g.add(glow);
      exhausts.push(glow);
      wreck.add(pod, nozzle, glow);
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
        .mul(env.uShieldPulse.mul(uFlashScale).mul(0.48).add(1.1));
    })();
    shieldMat.opacityNode = float(0.42).add(env.uShieldPulse.mul(uFlashScale).mul(0.16));
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 2), shieldMat);
    shield.scale.setScalar(0.001);
    g.add(shield);

    const light = new THREE.PointLight(engineColor, 14, 26, 1.8);
    light.position.set(0, 0.4, 1.2);
    // Keep this light in the scene while the intact ship is hidden. Removing
    // a light changes Three's lighting graph and recompiles every lit material
    // on the first retry frame; an intensity fade preserves compiled pipelines.

    return { group: g, engineLight: light, shieldMesh: shield, exhausts, wreck };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.id, env, uFlashScale]);

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
    return { left, right, lMesh, rMesh, material: mat };
  }, [env, uTrailColor, uTrailBoost]);

  const shieldAnim = useRef(0);
  const shieldKick = useRef(0);
  const trailFlash = useRef(0);
  /** Line-smoothness EMA (trail calligraphy): carves widen, jitter thins. */
  const smoothness = useRef(1);
  const prevBank = useRef(0);
  const engineAnchors = useMemo(() => [new THREE.Vector3(), new THREE.Vector3()], []);

  useEffect(() => {
    const offs = [
      world.events.on("runStart", () => {
        trails.left.reset();
        trails.right.reset();
        trailFlash.current = 0;
        shieldKick.current = 0;
        smoothness.current = 1;
        prevBank.current = 0;
        wreck.reset();
      }),
      world.events.on("nearMiss", (event) => {
        if (event.grade === "perfect") trailFlash.current = 1;
      }),
      world.events.on("boostStart", () => {
        trailFlash.current = Math.max(trailFlash.current, 0.6);
      }),
      world.events.on("pump", (event) => {
        trailFlash.current = Math.max(trailFlash.current, 0.5 + event.strength * 0.4);
      }),
      world.events.on("airJump", (event) => {
        trailFlash.current = Math.max(trailFlash.current, 0.45 + event.quality * 0.45);
      }),
      world.events.on("shieldPickup", () => {
        shieldKick.current = 1;
      }),
      world.events.on("shieldBreak", () => {
        shieldKick.current = -0.85;
      }),
      world.events.on("death", (event) => {
        wreck.start(event, group.rotation);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world, trails, wreck, group]);

  // Free GPU resources when a different craft design is selected.
  useEffect(() => {
    return () => {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const collect = (obj: THREE.Object3D) => {
        if (obj instanceof THREE.Mesh) {
          geometries.add(obj.geometry);
          for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
            materials.add(material);
          }
        }
      };
      group.traverse(collect);
      wreck.group.traverse(collect);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      engineLight.dispose();
    };
  }, [group, wreck, engineLight]);

  useEffect(() => () => {
    trails.left.geometry.dispose();
    trails.right.geometry.dispose();
    trails.material.dispose();
  }, [trails]);

  useFrame((_, dt) => {
    const frameDt = Math.min(dt, 0.08);
    const idle = world.status === "idle";
    const dead = world.status === "dead";
    const dist = idle ? 0 : world.renderDistance;
    const x = idle ? 0 : world.renderX;
    const bank = idle ? (reduceMotion ? 0 : Math.sin(env.uTime.value * 1.5) * 0.06) : world.renderBank;
    // Airborne the craft is a projectile, not a hovercraft: the bob fades out.
    const airLift = idle ? 0 : world.renderY - CRAFT.HOVER_HEIGHT;
    const bob =
      Math.sin(idle ? env.uTime.value * 2.5 : world.time * 6.4) * 0.06 *
      (world.airborne ? 0.25 : 1) * (reduceMotion ? 0.15 : 1);
    const y = CRAFT.HOVER_HEIGHT + airLift + bob;
    // Flight pitch: nose rides the velocity vector — up off the lip, down
    // through a dive — layered over the usual speed/boost trim.
    const flightPitch = idle || dead ? 0 : clamp(-world.vy * 0.028, -0.34, 0.42);

    if (dead) {
      group.visible = false;
      wreck.update(world.deathTimer, reduceMotion);
    } else {
      wreck.group.visible = false;
      // Nose into the winding course tangent so bends read on the craft too.
      const courseYaw = idle
        ? 0
        : -((world.courseOffsetAt(dist + 9) - world.courseOffsetAt(dist - 3)) / 12) * 0.7;
      group.position.set(x, y, 0);
      group.rotation.set(
        0.02 - world.speedNorm * 0.04 - world.boostCharge * 0.09 + flightPitch,
        -world.latVel * 0.006 + courseYaw,
        bank,
      );
      group.scale.setScalar(1);
      group.visible = true;
    }

    trailFlash.current = Math.max(0, trailFlash.current - frameDt * 3.4);
    shieldKick.current += (0 - shieldKick.current) * Math.min(1, frameDt * 5.5);
    // Trail calligraphy (fun-frontier 5.3): a steady bank reads as a clean
    // stroke, twitchy corrections thin the ink, a glide paints wide.
    const bankRate = Math.abs(bank - prevBank.current) / Math.max(frameDt, 1e-4);
    prevBank.current = bank;
    const steady = Math.max(0, 1 - bankRate * 0.55);
    smoothness.current += (steady - smoothness.current) * Math.min(1, frameDt * 3);
    engineLight.intensity = dead
      ? Math.max(0, 1 - world.deathTimer / 2) * (reduceFlash ? 3 : 7)
      : 7 + world.speedNorm * 8 + world.boostCharge * 14 + env.uBoostPulse.value * 5;
    if (dead) {
      engineLight.position.copy(wreck.group.position);
      engineLight.position.y += 0.4;
    } else {
      // Only the hull transform is needed for light/trail anchors here;
      // the renderer updates all child meshes once when drawing the scene.
      group.updateWorldMatrix(true, false);
      engineLight.position.set(0, 0.4, 1.2).applyMatrix4(group.matrixWorld);
    }
    for (const plume of exhausts) {
      plume.scale.set(1, 0.8, 1.7 + world.speedNorm * 1.3 + world.boostCharge * 3.8);
    }
    uTrailBoost.value =
      world.boostCharge + env.uFlow.value * 0.25 + world.glide * 0.5 +
      (world.airborne ? 0.3 : 0) +
      trailFlash.current * (reduceFlash ? 0.2 : 0.65);

    // Shield bubble scale animation.
    const target = world.hasShield ? 1 : 0;
    shieldAnim.current += (target - shieldAnim.current) * Math.min(1, dt * 8);
    const shieldScale = shieldAnim.current * (1 + Math.max(0, shieldKick.current) * 0.18);
    shieldMesh.scale.setScalar(Math.max(0.001, shieldScale));

    // Trails follow the engine pods.
    const trailTime = idle
      ? env.uTime.value
      : Math.max(0, world.time - FIXED_DT * (1 - world.alpha)) + (dead ? world.deathTimer : 0);
    if (!dead) {
      const sx = design.hullScale[0];
      const sz = design.hullScale[2];
      const off = 0.42 * sx;
      const nozzleZ = 0.55 * sz + 0.34;
      const left = engineAnchors[0].set(-off, -0.02, nozzleZ).applyMatrix4(group.matrixWorld);
      const right = engineAnchors[1].set(off, -0.02, nozzleZ).applyMatrix4(group.matrixWorld);
      trails.left.update(left.x, left.y, dist - left.z, trailTime);
      trails.right.update(right.x, right.y, dist - right.z, trailTime);
    }
    const trailWidth =
      (0.09 + world.boostCharge * 0.1 + env.uFlow.value * 0.025 + trailFlash.current * 0.035 +
        world.glide * 0.12 + (world.airborne ? 0.07 : 0)) *
      (0.7 + smoothness.current * 0.3);
    trails.left.write(dist, trailWidth, trailTime);
    trails.right.write(dist, trailWidth, trailTime);
  });

  return (
    <>
      <primitive object={group} />
      <primitive object={engineLight} />
      <primitive object={wreck.group} />
      <primitive object={trails.lMesh} />
      <primitive object={trails.rMesh} />
    </>
  );
}
