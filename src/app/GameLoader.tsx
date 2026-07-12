"use client";

import dynamic from "next/dynamic";

/**
 * The entire game (three/webgpu, Tone.js, sim) is client-only —
 * skip SSR and stream it in after the shell paints.
 */
const GameRoot = dynamic(() => import("@/game/GameRoot"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 grid place-items-center bg-[#07060f]">
      <div className="text-center font-mono text-sm tracking-[0.4em] text-cyan-200/60">
        WEAVING COURSE…
      </div>
    </div>
  ),
});

export function GameLoader() {
  return <GameRoot />;
}
