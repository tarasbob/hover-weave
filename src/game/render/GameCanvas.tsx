"use client";

import { Canvas } from "@react-three/fiber";
import { Suspense, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { useGame } from "../state/game";
import { QUALITY_CONFIGS, resolveTier, useSettings } from "../state/settings";
import { GameScene } from "./GameScene";
import { CAMERA_FAR } from "./visualConstants";

function subscribePixelRatio(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const readPixelRatio = () => window.devicePixelRatio || 1;
const serverPixelRatio = () => 1;

/**
 * R3F canvas backed by three's WebGPURenderer.
 * The renderer transparently falls back to a WebGL2 backend where WebGPU is
 * unavailable — all TSL materials compile to WGSL or GLSL accordingly.
 */
export function GameCanvas() {
  const tier = useSettings((s) => resolveTier(s));
  const scale = useGame((s) => s.graphics.drsScale);
  const pixelRatio = useSyncExternalStore(subscribePixelRatio, readPixelRatio, serverPixelRatio);
  // One owner for DPR. R3F reapplies this prop on canvas reconfiguration;
  // a separate imperative value inside the scene would be overwritten.
  const dpr = Math.min(pixelRatio, QUALITY_CONFIGS[tier].maxDpr) * scale;

  return (
    <Canvas
      className="!fixed inset-0"
      camera={{ fov: 68, near: 0.1, far: CAMERA_FAR, position: [0, 4.6, 9] }}
      gl={async (props) => {
        // `?gl=webgl` forces the WebGL2 backend (also what non-WebGPU
        // browsers get automatically).
        const forceWebGL =
          typeof location !== "undefined" &&
          new URLSearchParams(location.search).get("gl") === "webgl";
        const renderer = new THREE.WebGPURenderer({
          canvas: props.canvas as HTMLCanvasElement,
          antialias: false,
          powerPreference: "high-performance",
          forceWebGL,
        });
        await renderer.init();
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        const backend = (renderer as unknown as { backend: { isWebGPUBackend?: boolean } }).backend;
        useGame.getState().setWebgpu(backend.isWebGPUBackend === true);
        return renderer;
      }}
      frameloop="always"
      dpr={dpr}
      shadows
      flat={false}
      onCreated={({ scene }) => {
        scene.background = new THREE.Color("#030208");
      }}
    >
      <Suspense fallback={null}>
        <GameScene />
      </Suspense>
    </Canvas>
  );
}
