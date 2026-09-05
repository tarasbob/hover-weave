"use client";

import { useEffect } from "react";
import { getGPUTier } from "detect-gpu";
import { GameProvider } from "./GameController";
import { GameCanvas } from "./render/GameCanvas";
import { Hud } from "@/ui/Hud";
import { OrientationGate } from "@/ui/OrientationGate";
import { Screens } from "@/ui/Screens";
import { useGame } from "./state/game";
import { useSettings, type QualityTier } from "./state/settings";

export default function GameRoot() {
  const phase = useGame((s) => s.phase);
  const mode = useGame((s) => s.mode);
  const webgpu = useGame((s) => s.webgpu);
  const setPhase = useGame((s) => s.setPhase);
  const setAutoTier = useSettings((s) => s.setAutoTier);

  useEffect(() => {
    let cancelled = false;
    const proceed = () => {
      if (!cancelled && useGame.getState().phase === "boot") setPhase("title");
    };
    // detect-gpu can stall (throttled tabs, blocked CDN) — never gate the
    // title screen on it for more than a moment.
    const failsafe = setTimeout(proceed, 2500);
    void getGPUTier()
      .then((result) => {
        if (cancelled) return;
        const tier: QualityTier = result.tier >= 3 ? 2 : result.tier === 2 ? 1 : 0;
        setAutoTier(result.isMobile ? (Math.max(0, tier - 1) as QualityTier) : tier);
      })
      .catch(() => undefined)
      .finally(proceed);
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
    };
  }, [setAutoTier, setPhase]);

  return (
    <GameProvider>
      <div
        className="fixed inset-0 overflow-hidden bg-[#030208] select-none"
        data-game-phase={phase}
        data-game-mode={mode}
        data-renderer-backend={webgpu === null ? "initializing" : webgpu ? "webgpu" : "webgl2"}
      >
        {phase !== "boot" && <GameCanvas />}
        <Hud />
        <Screens />
        <OrientationGate />
      </div>
    </GameProvider>
  );
}
