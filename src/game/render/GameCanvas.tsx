"use client";

import { Canvas, type GLProps } from "@react-three/fiber";
import { Suspense, useMemo, useSyncExternalStore } from "react";
import * as THREE from "three/webgpu";
import { useGame } from "../state/game";
import { QUALITY_CONFIGS, resolveTier, useSettings } from "../state/settings";
import { GameScene } from "./GameScene";
import { CAMERA_FAR } from "./visualConstants";
import { FrameScheduler, subscribeVisibility, readVisibility, serverVisibility } from "./FrameScheduler";

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
  const phase = useGame((s) => s.phase);
  const visible = useSyncExternalStore(subscribeVisibility, readVisibility, serverVisibility);
  const pixelRatio = useSyncExternalStore(subscribePixelRatio, readPixelRatio, serverPixelRatio);
  // One owner for DPR. R3F reapplies this prop on canvas reconfiguration;
  // a separate imperative value inside the scene would be overwritten.
  const dpr = Math.min(pixelRatio, QUALITY_CONFIGS[tier].maxDpr) * scale;

  const createRenderer = useMemo(() => {
    const pending = new WeakMap<object, Promise<THREE.WebGPURenderer>>();
    const factory: GLProps = (props) => {
      // R3F can configure again while async initialization is pending. Both
      // calls must receive the same renderer: otherwise the later instance
      // misses the already-applied canvas resize and retains a 300×150 depth
      // buffer. Publishing backend state only after registration also avoids
      // a parent rerender in the middle of initialization.
      let ready = pending.get(props.canvas);
      if (!ready) {
        ready = (async () => {
          const forceWebGL = new URLSearchParams(location.search).get("gl") === "webgl";
          const renderer = new THREE.WebGPURenderer({
            canvas: props.canvas as HTMLCanvasElement,
            antialias: false,
            powerPreference: "high-performance",
            trackTimestamp: true,
            forceWebGL,
          });
          await renderer.init();
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.1;
          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          return renderer;
        })();
        pending.set(props.canvas, ready);
      }
      return ready;
    };
    return factory;
  }, []);

  return (
    <Canvas
      className="!fixed inset-0"
      camera={{ fov: 68, near: 0.1, far: CAMERA_FAR, position: [0, 4.6, 9] }}
      gl={createRenderer}
      frameloop={!visible ? "never" : phase === "running" || phase === "crashing" ? "always" : "demand"}
      dpr={dpr}
      shadows
      flat={false}
      onCreated={({ scene, gl }) => {
        scene.background = new THREE.Color("#030208");
        const renderer = gl as unknown as THREE.WebGPURenderer;
        const backend = renderer.backend as typeof renderer.backend & { isWebGPUBackend?: boolean };
        useGame.getState().setWebgpu(backend.isWebGPUBackend === true);
      }}
    >
      <Suspense fallback={null}>
        <FrameScheduler />
        <GameScene />
      </Suspense>
    </Canvas>
  );
}
