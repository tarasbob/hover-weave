"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  float,
  mix,
  mx_fractal_noise_float,
  normalLocal,
  positionLocal,
  pow,
  sin,
  smoothstep,
  vec3,
  hash,
  floor,
  fract,
  dot,
  saturate,
  vec2,
} from "three/tsl";
import { useGameBundle } from "../GameController";

/**
 * Procedural sky: vertical gradient, drifting nebula, hash-grid stars,
 * aurora ribbons, horizon glow and lightning flash — all TSL, no textures.
 */
export function SkyDome() {
  const { env } = useGameBundle();
  const camera = useThree((s) => s.camera);

  const mesh = useMemo(() => {
    const geo = new THREE.SphereGeometry(980, 48, 32);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.side = THREE.BackSide;
    mat.depthWrite = false;
    mat.fog = false;

    mat.colorNode = Fn(() => {
      const dir = positionLocal.normalize().toVar();
      const up = dir.y.toVar();

      // Base vertical gradient with a hot horizon band.
      const grad = smoothstep(-0.08, 0.55, up);
      const col = mix(env.uSkyBottom, env.uSkyTop, grad).toVar();
      const horizon = pow(saturate(float(1).sub(abs(up.add(0.03)))), 7);
      col.addAssign(env.uHorizon.mul(horizon).mul(1.35));

      // Nebula clouds (two fbm layers drifting at different rates).
      const nCoord = dir.mul(2.6).add(vec3(env.uTime.mul(0.004), 0, env.uTime.mul(0.0022)));
      const neb1 = mx_fractal_noise_float(nCoord, 4, 2.1, 0.55).mul(0.5).add(0.5);
      const neb2 = mx_fractal_noise_float(nCoord.mul(2.3).add(vec3(7.7)), 3, 2, 0.5).mul(0.5).add(0.5);
      const nebMask = saturate(neb1.mul(neb2).sub(0.12).mul(1.7))
        .mul(smoothstep(-0.02, 0.3, up))
        .mul(env.uNebulaAmt);
      col.addAssign(env.uNebula.mul(nebMask).mul(0.85));

      // Stars: hashed cells, twinkling, fading toward horizon.
      const sCoord = dir.mul(90).toVar();
      const cell = floor(sCoord);
      const h = hash(dot(cell, vec3(127.1, 311.7, 74.7)));
      const local = fract(sCoord).sub(0.5);
      const starDist = local.length();
      const starCore = smoothstep(0.28, 0.04, starDist);
      const isStar = smoothstep(0.982, 0.998, h);
      const twinkle = sin(env.uTime.mul(2.2).add(h.mul(80))).mul(0.4).add(0.7);
      const starLum = isStar.mul(starCore).mul(twinkle)
        .mul(smoothstep(0.02, 0.24, up))
        .mul(env.uStars);
      col.addAssign(vec3(0.95, 0.97, 1).mul(starLum).mul(1.6));

      // Aurora ribbons: ridged sine bands warped by noise.
      const warp = mx_fractal_noise_float(dir.mul(3.2).add(vec3(0, env.uTime.mul(0.02), 0)), 3, 2, 0.5);
      const band = sin(dir.x.mul(5.2).add(warp.mul(2.4)).add(env.uTime.mul(0.12)));
      const ridge = float(1).sub(abs(band)).pow(3.2);
      const auroraMask = ridge
        .mul(smoothstep(0.04, 0.22, up))
        .mul(smoothstep(0.75, 0.3, up))
        .mul(env.uAuroraAmt);
      const auroraCol = mix(env.uAuroraA, env.uAuroraB, saturate(warp.mul(0.5).add(0.5)));
      col.addAssign(auroraCol.mul(auroraMask).mul(0.9));

      // Lightning wash + subtle flow tint.
      col.addAssign(vec3(0.9, 0.92, 1).mul(env.uFlash).mul(0.75));
      col.addAssign(env.uAccent.mul(env.uFlow).mul(horizon).mul(0.25));

      // Boost warps a faint radial shimmer near the horizon ahead.
      const ahead = saturate(dir.z.negate());
      const shimmer = sin(dir.y.mul(90).add(env.uTime.mul(9))).mul(0.5).add(0.5);
      col.addAssign(env.uAccent.mul(env.uBoost).mul(ahead).mul(horizon).mul(shimmer).mul(0.35));

      void normalLocal;
      void vec2;
      return col;
    })();

    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = -100;
    return m;
  }, [env]);

  useFrame(() => {
    mesh.position.set(camera.position.x, 0, camera.position.z);
  });

  return <primitive object={mesh} />;
}
