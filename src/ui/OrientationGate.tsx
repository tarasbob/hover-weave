"use client";

import { useEffect, useState } from "react";
import { useGameBundle } from "@/game/GameController";
import { useGame } from "@/game/state/game";
import { MobileSetup } from "@/ui/MobileSetup";

/**
 * Pause play in portrait while keeping the title and setup usable in either
 * orientation. Devices without orientation lock can rotate back and resume.
 */
export function OrientationGate() {
  const bundle = useGameBundle();
  const phase = useGame((s) => s.phase);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const coarse = matchMedia("(pointer: coarse)");
    const portrait = matchMedia("(orientation: portrait)");
    const update = () => setBlocked(coarse.matches && portrait.matches);
    update();
    coarse.addEventListener("change", update);
    portrait.addEventListener("change", update);
    return () => {
      coarse.removeEventListener("change", update);
      portrait.removeEventListener("change", update);
    };
  }, []);

  // Rotating mid-run shouldn't kill you behind the curtain.
  useEffect(() => {
    if (blocked && useGame.getState().phase === "running") bundle.togglePause();
  }, [blocked, bundle, phase]);

  if (!blocked || (phase !== "running" && phase !== "paused")) return null;

  return (
    <div
      data-ui
      className="orientation-gate fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-y-auto bg-[#07060f] px-8 text-center font-body"
      role="alert"
    >
      <PhoneRotateIcon />
      <div className="font-display text-xl font-black tracking-[0.3em] text-white">
        ROTATE YOUR DEVICE
      </div>
      <div className="text-xs tracking-[0.28em] text-cyan-200/70">
        FLIGHT PAUSED · ROTATE TO LANDSCAPE, THEN RESUME
      </div>
      <MobileSetup />
      <button className="mobile-option" onClick={() => bundle.backToTitle()}>Back to menu</button>
    </div>
  );
}

function PhoneRotateIcon() {
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 72 72"
      fill="none"
      aria-hidden
      className="animate-pulse drop-shadow-[0_0_24px_rgba(110,60,255,0.6)]"
    >
      <rect
        x="14"
        y="24"
        width="44"
        height="24"
        rx="5"
        stroke="url(#og-grad)"
        strokeWidth="3"
      />
      <circle cx="51" cy="36" r="2.5" fill="url(#og-grad)" />
      <path
        d="M24 14c9-6 21-6 30 0m0 0v-7m0 7h-7"
        stroke="url(#og-grad)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <defs>
        <linearGradient id="og-grad" x1="14" y1="14" x2="58" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#67e8f9" />
          <stop offset="1" stopColor="#e879f9" />
        </linearGradient>
      </defs>
    </svg>
  );
}
