"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  color as tslColor,
  dot,
  float,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  uniform,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { FIXED_DT } from "../core/constants";
import { useSettings } from "../state/settings";

const GHOST_TINT = 0x9fd8ff;

/**
 * Spectral hologram of your PB run (roadmap 3.2). Pure render layer: the
 * GhostDriver's SimWorld is stepped in GameScene; this just draws its pose
 * relative to the live craft. Endless ghosts fly their own recorded track,
 * so they legitimately drift through live geometry — they are a pace to
 * race, not a collider.
 */
export function Ghost() {
  const { world, ghost } = useGameBundle();
  const showGhost = useSettings((s) => s.showGhost);

  const uOpacity = useMemo(() => uniform(0), []);
  const warmed = useRef(false);

  const { group } = useMemo(() => {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.colorNode = Fn(() => {
      const fresnel = pow(
        saturate(float(1).sub(saturate(dot(normalView, positionViewDirection)))),
        1.8,
      );
      return tslColor(GHOST_TINT).mul(fresnel.mul(0.85).add(0.3));
    })();
    mat.opacityNode = uOpacity;

    const hull = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), mat);
    hull.scale.set(0.6, 0.3, 1.5);
    g.add(hull);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat);
    canopy.position.set(0, 0.22, -0.25);
    canopy.scale.set(0.8, 0.62, 1.5);
    g.add(canopy);
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.5), mat);
      fin.position.set(side * 0.52, 0.02, 0.42);
      fin.rotation.y = -side * 0.5;
      g.add(fin);
    }
    g.visible = false;
    return { group: g };
  }, [uOpacity]);

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

  useFrame(() => {
    if (!warmed.current && showGhost) {
      // The first completed run arms a PB ghost on retry. Compile its small
      // transparent material during startup so that retry never pays for a
      // brand-new shader after the simulation has already started moving.
      group.visible = true;
      uOpacity.value = 0;
      warmed.current = true;
      return;
    }
    if (!showGhost || !ghost.active || world.status === "idle") {
      group.visible = false;
      return;
    }
    const renderTime = world.time - (1 - world.alpha) * FIXED_DT;
    const pose = ghost.poseAt(renderTime);
    if (!pose) {
      group.visible = false;
      return;
    }
    // Render-space: z = live craft distance - ghost distance (ahead = -z).
    const z = world.renderDistance - pose.distance;
    if (z < -240 || z > 30) {
      group.visible = false;
      return;
    }
    group.visible = true;
    const bob = Math.sin((ghost.world?.time ?? 0) * 6.4) * 0.06;
    group.position.set(pose.x, pose.y + bob, z);
    group.rotation.set(0.02, 0, pose.bank);
    // Fade with distance so the hologram never reads as a solid craft, and
    // dim a crashed ghost to a faint marker while the live run flies past.
    const depthFade = 1 - Math.min(1, Math.abs(z) / 240);
    const crashed = ghost.world?.status === "dead";
    uOpacity.value = (crashed ? 0.16 : 0.34) * (0.35 + 0.65 * depthFade);
  });

  return <primitive object={group} />;
}
