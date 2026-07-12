"use client";

import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  float,
  fract,
  hash,
  floor,
  max,
  mix,
  positionLocal,
  sin,
  smoothstep,
  step,
  dot,
  vec2,
  vec3,
  saturate,
  transformNormalToView,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { SCROLL_PERIOD } from "./env";
import type { NodeAny } from "./tsl-utils";

/**
 * Endless terrain: a static plane whose height field scrolls through it.
 * Displacement is a sum of sines periodic in SCROLL_PERIOD along the track,
 * so the scroll wrap is mathematically seamless. A flat valley hosts the
 * course; neon grid lines and biome sparkle live near the track.
 */
export function Terrain({ segments }: { segments: [number, number] }) {
  const { env } = useGameBundle();

  const mesh = useMemo(() => {
    const WIDTH = 860;
    const DEPTH = 720;
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, segments[0], segments[1]);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.metalness = 0.55;
    mat.roughness = 0.42;

    const P = SCROLL_PERIOD;
    const TAU = Math.PI * 2;

    const heightAt = (xIn: NodeAny, sIn: NodeAny): NodeAny => {
      const x = float(xIn);
      const s = float(sIn);
      const wave = sin(s.mul((TAU / P) * 3).add(x.mul(0.013))).mul(0.42)
        .add(sin(s.mul((TAU / P) * 7).add(x.mul(0.031)).add(1.7)).mul(0.26))
        .add(sin(s.mul((TAU / P) * 13).sub(x.mul(0.022)).add(4.2)).mul(0.19))
        .add(sin(s.mul((TAU / P) * 29).add(x.mul(0.047)).add(2.3)).mul(0.13));
      const ridgeMod = sin(x.mul(0.021).add(s.mul((TAU / P) * 2)).add(0.8)).mul(0.35).add(0.75);
      const mega = sin(x.mul(0.006).add(1.3)).mul(sin(s.mul(TAU / P).add(x.mul(0.004)))).mul(1.6);
      const valley = smoothstep(36, 120, abs(x));
      return float(wave.mul(ridgeMod).add(mega).mul(env.uDispAmp).mul(valley));
    };

    const worldX: NodeAny = positionLocal.x;
    const sCoord: NodeAny = env.uScroll.sub(positionLocal.z);
    const eps = 2.5;
    const h0: NodeAny = heightAt(worldX, sCoord).toVar();
    mat.positionNode = positionLocal.add(vec3(0, h0, 0));

    // Finite-difference normal (s increases toward -z).
    const hx = heightAt(worldX.add(eps), sCoord);
    const hz = heightAt(worldX, sCoord.add(eps));
    mat.normalNode = transformNormalToView(
      vec3(h0.sub(hx), float(eps), hz.sub(h0)).normalize(),
    );

    mat.colorNode = Fn(() => {
      const t = saturate(h0.div(max(env.uDispAmp, 1)).mul(0.5).add(0.5));
      return mix(env.uTerrainA, env.uTerrainB, t);
    })();

    mat.emissiveNode = Fn(() => {
      // Neon grid, strongest near the track.
      const gridScale = float(4);
      const gx = abs(fract(worldX.div(gridScale)).sub(0.5)).mul(2);
      const gz = abs(fract(sCoord.div(gridScale)).sub(0.5)).mul(2);
      const line = max(smoothstep(0.93, 1, gx), smoothstep(0.93, 1, gz));
      const trackFade = smoothstep(150, 20, abs(worldX));
      const grid = line.mul(trackFade).mul(env.uGridIntensity);

      // Track edge rails with a traveling pulse.
      const edge = smoothstep(1.6, 0.25, abs(abs(worldX).sub(31)));
      const railPulse = sin(sCoord.mul(0.35).sub(env.uTime.mul(6))).mul(0.25).add(0.75);

      // Crystal facet sparkle: tiny glints, not whole cells.
      const cellCoord = vec2(worldX, sCoord).div(3);
      const cell = floor(cellCoord);
      const hcell = hash(dot(cell, vec2(12.9898, 78.233)));
      const inCell = fract(cellCoord).sub(vec2(hash(hcell.mul(97)), hash(hcell.mul(31))));
      const dot2 = smoothstep(0.09, 0.02, inCell.length());
      const twinkle = sin(env.uTime.mul(3).add(hcell.mul(60))).mul(0.5).add(0.5);
      const sparkle = step(0.82, hcell).mul(dot2).mul(twinkle).mul(env.uSparkle).mul(trackFade);

      const e = env.uGridColor.mul(grid).mul(0.55)
        .add(env.uPrimary.mul(edge).mul(railPulse).mul(1.4))
        .add(env.uAccent.mul(sparkle).mul(2.2))
        .add(env.uGridColor.mul(env.uFlash).mul(0.12));

      return e.mul(env.uFlow.mul(0.5).add(1));
    })();

    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, 0, -DEPTH / 2 + 120);
    m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, segments[0], segments[1]]);

  return <primitive object={mesh} />;
}
