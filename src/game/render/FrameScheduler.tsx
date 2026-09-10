"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useSyncExternalStore } from "react";
import { useGameBundle } from "../GameController";
import { useGame } from "../state/game";
import { useSettings } from "../state/settings";

export function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
export const readVisibility = () => !document.hidden;
export const serverVisibility = () => true;

/** Idle UI must remain responsive without running the entire scene and post chain. */
export function FrameScheduler() {
  const invalidate = useThree((s) => s.invalidate);
  const { input } = useGameBundle();
  const phase = useGame((s) => s.phase);
  const visible = useSyncExternalStore(subscribeVisibility, readVisibility, serverVisibility);

  useEffect(() => {
    if (!visible || phase === "running" || phase === "crashing") return;

    // Settings/cosmetics and menu shortcuts may change the frozen scene. Read
    // them once on demand; ordinary HUD/diagnostic store writes never wake it.
    const wake = () => invalidate();
    const offSettings = useSettings.subscribe(wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("focus", wake);
    invalidate();

    // Keep the flight deck alive at 30 Hz, independent of 120/144/240 Hz screens.
    // Results and pause screens retain their last completed frame indefinitely.
    const ambient = phase === "title" ? window.setInterval(wake, 1000 / 30) : null;
    let padTimer: number | null = null;
    const updateGamepads = () => {
      if (padTimer !== null) window.clearInterval(padTimer);
      padTimer = null;
      if (phase === "title" || !Array.from(navigator.getGamepads?.() ?? []).some(Boolean)) return;
      // Browsers provide gamepad buttons by polling. A connected controller
      // needs only a cheap input poll while idle, never a speculative GPU frame.
      padTimer = window.setInterval(() => {
        input.poll(useSettings.getState().sensitivity);
        if (input.state.pause || input.state.restart) invalidate();
      }, 50);
    };
    updateGamepads();
    window.addEventListener("gamepadconnected", updateGamepads);
    window.addEventListener("gamepaddisconnected", updateGamepads);

    return () => {
      offSettings();
      window.removeEventListener("keydown", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("gamepadconnected", updateGamepads);
      window.removeEventListener("gamepaddisconnected", updateGamepads);
      if (ambient !== null) window.clearInterval(ambient);
      if (padTimer !== null) window.clearInterval(padTimer);
    };
  }, [input, invalidate, phase, visible]);

  return null;
}
