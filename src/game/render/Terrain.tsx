"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  float,
  fract,
  fwidth,
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
  uniformArray,
  clamp,
} from "three/tsl";
import { useGameBundle } from "../GameController";
import { TRACK } from "../core/constants";
import { SCROLL_PERIOD } from "./env";
import { TERRAIN_DEPTH } from "./visualConstants";
import type { NodeAny } from "./tsl-utils";

/**
 * Endless terrain: a static plane whose height field scrolls through it.
 * Displacement is a sum of sines periodic in SCROLL_PERIOD along the track,
 * so the scroll wrap is mathematically seamless. A flat valley hosts the
 * course; neon grid lines and biome sparkle live near the track.
 */
export function Terrain({ segments }: { segments: [number, number] }) {
  const { env, world, ambient } = useGameBundle();
  // Sampling the simulation's course keeps terrain, markings and collisions
  // on the same centerline, including seeded bends and late-run easing.
  const course = useMemo(() => {
    const rows = Math.ceil(TERRAIN_DEPTH / 8);
    const values = Array<number>(rows + 1).fill(0);
    return { rows, step: TERRAIN_DEPTH / rows, values, node: uniformArray<"float">(values, "float") };
  }, []);

  useFrame(() => {
    const distance = world.status === "idle" ? ambient.value : world.renderDistance;
    for (let i = 0; i <= course.rows; i++) {
      course.values[i] = world.courseOffsetAt(distance - 120 + i * course.step);
    }
  });

  const mesh = useMemo(() => {
    const WIDTH = 860;
    const DEPTH = TERRAIN_DEPTH;
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, segments[0], segments[1]);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial();
    mat.metalness = 0.55;
    mat.roughness = 0.42;
    mat.metalnessNode = mix(float(0.5), float(0.82), env.uBiomeMix.y.mul(env.uReflectivity));
    mat.roughnessNode = mix(float(0.46), float(0.16), env.uBiomeMix.y.mul(env.uReflectivity));

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
      const near = wave.mul(ridgeMod).add(mega).mul(env.uDispAmp).mul(valley);
      // Distant mountain range framing the corridor (sharper, taller ridges).
      const farMask = smoothstep(150, 330, abs(x));
      const ridgeShape = float(1).sub(abs(sin(x.mul(0.011).add(s.mul((TAU / P) * 2)).add(2.1)))).pow(1.6)
        .add(float(1).sub(abs(sin(x.mul(0.0053).sub(s.mul(TAU / P)).add(0.6)))).pow(2.2).mul(1.4));
      const farRidge = ridgeShape.mul(farMask).mul(env.uDispAmp.mul(1.15).add(13));
      return float(near.add(farRidge));
    };

    const centerAt = (ahead = 0): NodeAny => {
      const index = clamp(
        float(DEPTH / 2 + ahead).sub(positionLocal.z).div(course.step),
        0, course.rows - 0.0001,
      );
      const row = floor(index);
      return mix(course.node.element(row), course.node.element(row.add(1)), fract(index));
    };
    const worldX: NodeAny = positionLocal.x.sub(centerAt());
    const sCoord: NodeAny = env.uScroll.sub(positionLocal.z);
    const eps = 2.5;
    const h0: NodeAny = heightAt(worldX, sCoord).toVar();
    mat.positionNode = positionLocal.add(vec3(0, h0, 0));

    // Finite-difference normal (s increases toward -z).
    const hx = heightAt(worldX.add(eps), sCoord);
    const hz = heightAt(positionLocal.x.sub(centerAt(eps)), sCoord.add(eps));
    mat.normalNode = transformNormalToView(
      vec3(h0.sub(hx), float(eps), hz.sub(h0)).normalize(),
    );

    mat.colorNode = Fn(() => {
      const t = saturate(h0.div(max(env.uDispAmp, 1)).mul(0.5).add(0.5));
      const terrain = mix(env.uTerrainA, env.uTerrainB, t);
      const road = float(1).sub(smoothstep(TRACK.X_LIMIT - 0.4, TRACK.X_LIMIT + 0.4, abs(worldX)));
      return mix(terrain, terrain.mul(0.48).add(env.uGridColor.mul(0.016)), road);
    })();

    mat.emissiveNode = Fn(() => {
      // Neon grid, strongest near the track.
      const gridScale = float(8);
      const gridCoord = vec2(worldX, sCoord).div(gridScale);
      const edgeDistance = vec2(0.5).sub(abs(fract(gridCoord).sub(0.5)));
      const pixelWidth = max(fwidth(gridCoord), vec2(0.001)).mul(0.75);
      const lineWidth = vec2(0.012);
      const coverage = vec2(1).sub(
        smoothstep(lineWidth.sub(pixelWidth), lineWidth.add(pixelWidth), edgeDistance),
      );
      const squareGrid = max(coverage.x, coverage.y);

      // Crystal Desert: sparse diamond inlays, leaving the driving plane calm.
      const diamondCoord = vec2(worldX.add(sCoord), worldX.sub(sCoord)).div(16);
      const diamondDistance = vec2(0.5).sub(abs(fract(diamondCoord).sub(0.5)));
      const diamondAA = max(fwidth(diamondCoord), vec2(0.001)).mul(0.8);
      const diamondCoverage = vec2(1).sub(
        smoothstep(
          vec2(0.01).sub(diamondAA),
          vec2(0.01).add(diamondAA),
          diamondDistance,
        ),
      );
      const crystalGrid = max(diamondCoverage.x, diamondCoverage.y).mul(0.42);

      // Digital Ocean: long luminous wave fronts instead of a rigid lattice.
      const waveSignal = abs(
        sin(sCoord.mul(0.17).add(sin(worldX.mul(0.045)).mul(1.8)).sub(env.uTime.mul(1.7))),
      );
      const waveAA = fwidth(waveSignal).mul(1.5);
      const oceanWaves = smoothstep(float(0.91).sub(waveAA), float(0.99).add(waveAA), waveSignal);
      const oceanGrid = max(squareGrid.mul(0.24), oceanWaves);

      // Storm Front: damaged circuitry that reconnects during lightning.
      const stormCell = floor(gridCoord.div(3));
      const circuitGate = step(0.36, hash(dot(stormCell, vec2(37.1, 91.7))));
      const stormGrid = squareGrid
        .mul(circuitGate)
        .mul(float(0.58).add(env.uFlash.mul(1.25)));

      // Void Tunnel: sparse radial marks and faint crosshair traces.
      const voidSignal = abs(sin(vec2(worldX, sCoord).length().mul(0.19).sub(env.uTime.mul(0.55))));
      const voidAA = fwidth(voidSignal).mul(1.8);
      const voidRings = smoothstep(float(0.94).sub(voidAA), float(1).add(voidAA), voidSignal);
      const voidGrid = max(squareGrid.mul(0.12), voidRings.mul(0.82));

      const line = crystalGrid.mul(env.uBiomeMix.x)
        .add(oceanGrid.mul(env.uBiomeMix.y))
        .add(stormGrid.mul(env.uBiomeMix.z))
        .add(voidGrid.mul(env.uBiomeMix.w));
      const trackFade = smoothstep(110, 20, abs(worldX));
      // Subpixel patterns otherwise average into a luminous sheet at the horizon.
      const resolved = float(1).sub(smoothstep(0.08, 0.65, max(fwidth(gridCoord.x), fwidth(gridCoord.y))));
      const grid = line.mul(trackFade).mul(resolved).mul(env.uGridIntensity);

      // Continuous boundaries trace each bend. Amber approach stripes make
      // the lethal edge legible without suggesting a physical guardrail.
      const boundaryDistance = abs(abs(worldX).sub(TRACK.X_LIMIT));
      const edgeAA = max(fwidth(worldX), 0.025);
      const edge = float(1).sub(smoothstep(float(0.16).sub(edgeAA), float(0.16).add(edgeAA), boundaryDistance));
      const shoulder = smoothstep(TRACK.X_LIMIT - 1.7, TRACK.X_LIMIT - 1.45, abs(worldX))
        .mul(float(1).sub(smoothstep(TRACK.X_LIMIT - 0.6, TRACK.X_LIMIT - 0.4, abs(worldX))));
      const warningPattern = sin(sCoord.mul(0.85).add(abs(worldX).mul(1.8)));
      const warningAA = max(fwidth(warningPattern), 0.02);
      const stripes = shoulder.mul(smoothstep(warningAA.negate(), warningAA, warningPattern));

      // Crystal facet sparkle: tiny glints, not whole cells.
      const cellCoord = vec2(worldX, sCoord).div(3);
      const cell = floor(cellCoord);
      const hcell = hash(dot(cell, vec2(12.9898, 78.233)));
      const inCell = fract(cellCoord).sub(vec2(hash(hcell.mul(97)), hash(hcell.mul(31))));
      const dot2 = smoothstep(0.09, 0.02, inCell.length());
      const twinkle = sin(env.uTime.mul(3).add(hcell.mul(60))).mul(0.5).add(0.5);
      const sparkle = step(0.82, hcell).mul(dot2).mul(twinkle).mul(env.uSparkle).mul(trackFade);

      const e = env.uGridColor.mul(grid).mul(0.24)
        .add(env.uPrimary.mul(edge).mul(1.3))
        .add(vec3(1, 0.3, 0.06).mul(stripes).mul(0.46))
        .add(env.uAccent.mul(sparkle).mul(0.65))
        .add(env.uGridColor.mul(env.uFlash).mul(0.12))
        .add(env.uAccent.mul(env.uTransition).mul(edge).mul(0.48))
        .add(env.uPrimary.mul(env.uFlowPulse).mul(grid).mul(0.22));

      return e.mul(env.uFlow.mul(0.2).add(1));
    })();

    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, 0, -DEPTH / 2 + 120);
    m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, course, segments[0], segments[1]]);

  useEffect(() => () => {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }, [mesh]);

  return <primitive object={mesh} />;
}
