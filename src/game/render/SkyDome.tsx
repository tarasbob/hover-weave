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
import { SUN_DIRECTION } from "./visualConstants";

/**
 * Procedural sky: vertical gradient, drifting nebula, hash-grid stars,
 * aurora ribbons, horizon glow and lightning flash — all TSL, no textures.
 */
export function SkyDome({ detail }: { detail: 0 | 1 | 2 }) {
  const { env } = useGameBundle();
  const camera = useThree((s) => s.camera);

  const mesh = useMemo(() => {
    const [widthSegments, heightSegments] =
      detail === 0 ? [32, 20] : detail === 1 ? [48, 32] : [64, 40];
    const geo = new THREE.SphereGeometry(980, widthSegments, heightSegments);
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

      // A coherent key-light source shared with the scene's directional light.
      const sunDot = saturate(dot(dir, vec3(...SUN_DIRECTION).normalize()));
      const sunDisc = pow(sunDot, detail === 2 ? 720 : 420);
      const sunCorona = pow(sunDot, 42).mul(0.32);
      col.addAssign(
        mix(env.uHorizon, vec3(1, 0.92, 0.78), 0.55)
          .mul(sunDisc.mul(5.5).add(sunCorona))
          .mul(env.uSkyEnergy),
      );

      // Nebula clouds (two fbm layers drifting at different rates).
      const nCoord = dir.mul(2.6).add(vec3(env.uTime.mul(0.004), 0, env.uTime.mul(0.0022)));
      const neb1 = mx_fractal_noise_float(nCoord, 4, 2.1, 0.55).mul(0.5).add(0.5);
      const neb2 = detail > 0
        ? mx_fractal_noise_float(nCoord.mul(2.3).add(vec3(7.7)), detail === 2 ? 3 : 2, 2, 0.5)
          .mul(0.5)
          .add(0.5)
        : float(0.72);
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
      const starCore = smoothstep(0.2, 0.03, starDist);
      const isStar = smoothstep(0.978, 0.998, h);
      const twinkle = sin(env.uTime.mul(2.2).add(h.mul(80))).mul(0.4).add(0.7);
      const starLum = isStar.mul(starCore).mul(twinkle)
        .mul(smoothstep(0.02, 0.24, up))
        .mul(env.uStars);
      col.addAssign(vec3(0.95, 0.97, 1).mul(starLum).mul(2));

      if (detail > 0) {
        // Faint tilted milky-way band with denser micro-stars inside it.
        const bandN = vec3(0.36, 0.7, 0.62).normalize();
        const bandDist = abs(dot(dir, bandN));
        const bandGlow = pow(float(1).sub(bandDist), 5.5).mul(smoothstep(0.0, 0.18, up));
        const bandNoise = mx_fractal_noise_float(
          dir.mul(7.5).add(vec3(3.3)),
          detail === 2 ? 3 : 2,
          2.2,
          0.55,
        ).mul(0.5).add(0.5);
        col.addAssign(
          vec3(0.72, 0.78, 1).mul(bandGlow).mul(bandNoise).mul(env.uStars).mul(0.32),
        );
      }

      // Aurora ribbons: ridged sine bands warped by noise.
      const warp = mx_fractal_noise_float(dir.mul(3.2).add(vec3(0, env.uTime.mul(0.02), 0)), 3, 2, 0.5);
      const band = sin(dir.x.mul(5.2).add(warp.mul(2.4)).add(env.uTime.mul(0.12)));
      const ridge = float(1).sub(abs(band)).pow(3.2);
      const auroraMask = ridge
        .mul(smoothstep(0.04, 0.22, up))
        .mul(smoothstep(0.75, 0.3, up))
        .mul(env.uAuroraAmt.add(env.uTransition.mul(0.35)).add(env.uFlowPulse.mul(0.2)));
      const auroraCol = mix(env.uAuroraA, env.uAuroraB, saturate(warp.mul(0.5).add(0.5)));
      col.addAssign(auroraCol.mul(auroraMask).mul(0.9));

      // Each biome has a recognisable procedural sky silhouette.
      const crystalArc = pow(
        float(1).sub(abs(sin(dir.x.mul(8).add(dir.y.mul(5.5)).add(env.uTime.mul(0.06))))),
        8,
      ).mul(smoothstep(0.04, 0.48, up));
      col.addAssign(env.uPrimary.mul(crystalArc).mul(env.uBiomeMix.x).mul(0.42));

      const dataColumns = pow(
        float(1).sub(abs(sin(dir.x.mul(88).add(env.uTime.mul(0.12))))),
        14,
      )
        .mul(pow(sin(dir.y.mul(72).sub(env.uTime.mul(3.2))).mul(0.5).add(0.5), 6))
        .mul(smoothstep(0.06, 0.5, up));
      col.addAssign(env.uAccent.mul(dataColumns).mul(env.uBiomeMix.y).mul(0.46));

      const stormCloud = saturate(
        mx_fractal_noise_float(dir.mul(4.2).add(vec3(env.uTime.mul(0.025), 0, 0)), 3, 2, 0.54)
          .mul(0.5)
          .add(0.5)
          .sub(0.28)
          .mul(1.35),
      ).mul(smoothstep(-0.04, 0.5, up));
      col.mulAssign(float(1).sub(stormCloud.mul(env.uBiomeMix.z).mul(0.42)));
      col.addAssign(env.uWarn.mul(stormCloud).mul(env.uFlash).mul(env.uBiomeMix.z).mul(1.4));

      const riftDistance = abs(dot(dir, vec3(0.76, 0.18, 0.62).normalize()));
      const voidRift = pow(float(1).sub(riftDistance), detail === 2 ? 26 : 18)
        .mul(smoothstep(0.0, 0.42, up));
      col.addAssign(
        mix(env.uPrimary, env.uAccent, saturate(dir.y.mul(1.4)))
          .mul(voidRift)
          .mul(env.uBiomeMix.w)
          .mul(detail === 2 ? 1.4 : 0.9),
      );

      // Lightning wash + subtle flow tint.
      col.addAssign(vec3(0.9, 0.92, 1).mul(env.uFlash).mul(0.75));
      col.addAssign(env.uAccent.mul(env.uFlow).mul(horizon).mul(0.25));
      col.addAssign(env.uAccent.mul(env.uTransition).mul(horizon).mul(0.42));

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
  }, [detail, env]);

  useFrame(() => {
    mesh.position.set(camera.position.x, 0, camera.position.z);
  });

  return <primitive object={mesh} />;
}
