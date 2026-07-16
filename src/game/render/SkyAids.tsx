"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three/webgpu";
import { useGameBundle } from "../GameController";
import { CRAFT, onBeatAt, RAMP } from "../core/constants";
import { clamp01, lerp } from "../core/mathUtils";
import { useSettings } from "../state/settings";

/**
 * Flight readability aids (fun-frontier 6.1). Height is the hardest thing to
 * judge from a chase camera, so a flying craft gets two honest instruments:
 *
 * - a soft ground shadow that tracks straight beneath the hull (altitude at
 *   a glance), and
 * - a landing reticle projected from the live ballistic state under the
 *   currently *held* inputs — dive or steer and the ring drags across the
 *   ground in real time, which is precisely what teaches the dive.
 *
 * The reticle brightens when the projected touchdown falls on the beat grid:
 * the resonant-landing timing is readable, not memorized.
 */
export function SkyAids() {
  const { world } = useGameBundle();
  const reduceFlash = useSettings((s) => s.reduceFlash);

  const shadow = useMemo(() => {
    const geo = new THREE.CircleGeometry(1, 28);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: "#02010a",
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    mesh.visible = false;
    return mesh;
  }, []);

  const reticle = useMemo(() => {
    const geo = new THREE.RingGeometry(0.7, 1, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: "#7df7ff",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.visible = false;
    return mesh;
  }, []);

  useEffect(() => {
    return () => {
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      reticle.geometry.dispose();
      (reticle.material as THREE.Material).dispose();
    };
  }, [shadow, reticle]);

  useFrame(() => {
    const running = world.status === "running";
    const lift = Math.max(0, world.renderY - CRAFT.HOVER_HEIGHT);

    // Hull shadow: always under a live craft, spreading and thinning with
    // altitude so the gap between hull and blob *is* the altimeter.
    shadow.visible = running;
    if (running) {
      shadow.position.set(world.renderX, 0.05, 0);
      const spread = 0.9 + lift * 0.14;
      shadow.scale.setScalar(spread);
      (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(
        0.1,
        0.32 - lift * 0.016,
      );
    }

    // Landing reticle: closed-form ballistic touchdown under held inputs.
    // (Signed vy: 0 = h + vy·t − g/2·t² ⇒ t = (vy + √(vy² + 2gh)) / g.)
    const showReticle = running && world.airborne && lift > 0.15;
    reticle.visible = showReticle;
    if (showReticle) {
      const g = RAMP.GRAVITY + (world.boosting ? RAMP.DIVE_ACCEL : 0);
      const vy = world.vy;
      const t = (vy + Math.sqrt(vy * vy + 2 * g * lift)) / g;
      // Lateral drift decays under air drag; integrate it exactly.
      const drift =
        (world.latVel * (1 - Math.exp(-RAMP.AIR_DRAG * t))) / RAMP.AIR_DRAG;
      const xLand = world.renderX + drift;
      const zLand = -(world.speed * t);
      reticle.position.set(xLand, 0.07, zLand);
      const closeness = clamp01(1 - t / 1.4);
      reticle.scale.setScalar(lerp(2.6, 1.15, closeness));
      const resonant = onBeatAt(world.time + t);
      const mat = reticle.material as THREE.MeshBasicMaterial;
      const pulse = resonant && !reduceFlash ? 0.35 : 0;
      mat.opacity = 0.28 + closeness * 0.42 + pulse;
      mat.color.set(resonant ? "#ffe28a" : "#7df7ff");
    }
  });

  return (
    <>
      <primitive object={shadow} />
      <primitive object={reticle} />
    </>
  );
}
