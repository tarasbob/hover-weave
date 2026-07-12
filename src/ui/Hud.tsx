"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGame } from "@/game/state/game";
import { useMeta } from "@/game/state/meta";
import { useSettings } from "@/game/state/settings";

/** In-run heads-up display. Pure DOM over the canvas, throttled by the loop. */
export function Hud() {
  const phase = useGame((s) => s.phase);
  const hud = useGame((s) => s.hud);
  const mode = useGame((s) => s.mode);
  const callout = useGame((s) => s.callout);
  const fps = useGame((s) => s.fps);
  const showFps = useSettings((s) => s.showFps);
  const bestScore = useMeta((s) => s.bestScore);

  const inRun = phase === "running" || phase === "paused" || phase === "dead";
  if (!inRun) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 font-display">
      {/* Score block */}
      <div className="absolute left-5 top-5">
        <div className="text-[11px] tracking-[0.3em] text-white/50">SCORE</div>
        <div className="text-4xl font-bold tabular-nums text-white drop-shadow-[0_0_12px_rgba(90,220,255,0.55)]">
          {hud.score.toLocaleString()}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div
            className={`rounded-md px-2 py-0.5 text-sm font-bold tabular-nums transition-colors ${
              hud.flowTier >= 4
                ? "bg-fuchsia-400/25 text-fuchsia-200"
                : hud.flowTier >= 2
                  ? "bg-cyan-300/20 text-cyan-200"
                  : "bg-white/10 text-white/70"
            }`}
          >
            ×{hud.multiplier.toFixed(2)}
          </div>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-fuchsia-400 transition-[width] duration-150"
              style={{ width: `${Math.min(hud.flowFrac * 100, 100)}%` }}
            />
          </div>
          {hud.flowTier > 0 && (
            <div className="text-xs font-semibold text-cyan-200/90">FLOW {hud.flowTier}</div>
          )}
        </div>
      </div>

      {/* Mode / biome / best */}
      <div className="absolute right-5 top-5 text-right">
        <div className="text-[11px] tracking-[0.3em] text-white/50">
          {mode === "daily" ? "DAILY COURSE" : "ENDLESS"}
        </div>
        <div className="text-sm text-white/80">{hud.biome}</div>
        <div className="mt-1 text-[11px] tabular-nums text-white/40">
          BEST {bestScore.toLocaleString()}
        </div>
        {showFps && <div className="mt-1 text-[11px] tabular-nums text-emerald-300/80">{fps} FPS</div>}
      </div>

      {/* Distance + speed */}
      <div className="absolute bottom-5 right-5 text-right">
        <div className="text-2xl font-bold tabular-nums text-white/90">
          {hud.distance.toLocaleString()}
          <span className="ml-1 text-sm font-normal text-white/50">m</span>
        </div>
        <div className="text-sm tabular-nums text-white/60">{hud.speedKmh} km/h</div>
      </div>

      {/* Energy + shield */}
      <div className="absolute bottom-6 left-1/2 flex w-72 -translate-x-1/2 items-center gap-3">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-all ${
            hud.shield
              ? "border-amber-300/80 bg-amber-300/15 text-amber-200 shadow-[0_0_14px_rgba(252,211,77,0.5)]"
              : "border-white/15 bg-white/5 text-white/25"
          }`}
          title={hud.shield ? "Shield active" : "No shield"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"
              stroke="currentColor"
              strokeWidth="2"
              fill={hud.shield ? "currentColor" : "none"}
              fillOpacity={hud.shield ? 0.35 : 0}
            />
          </svg>
        </div>
        <div className="flex-1">
          <div className="mb-1 flex justify-between text-[10px] tracking-[0.25em] text-white/45">
            <span>ENERGY</span>
            <span className={hud.boosting ? "text-amber-300" : ""}>
              {hud.boosting ? "BOOSTING" : boostHint()}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${
                hud.boosting
                  ? "bg-gradient-to-r from-amber-300 to-orange-400"
                  : "bg-gradient-to-r from-cyan-300 to-sky-400"
              }`}
              style={{ width: `${hud.energy}%` }}
            />
          </div>
        </div>
      </div>

      {/* Center callouts */}
      <CalloutToast key={callout?.at ?? "none"} text={callout?.text} at={callout?.at} />
      <UnlockToasts />
    </div>
  );
}

function boostHint(): string {
  const touch = typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches;
  return touch ? "SECOND FINGER TO BOOST" : "HOLD SHIFT / SPACE TO BOOST";
}

function CalloutToast({ text, at }: { text?: string; at?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!text || !at) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2100);
    return () => clearTimeout(t);
  }, [text, at]);

  return (
    <AnimatePresence>
      {visible && text && (
        <motion.div
          initial={{ opacity: 0, y: 18, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -14, scale: 1.04 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="absolute left-1/2 top-[24%] -translate-x-1/2 text-center"
        >
          <div className="bg-gradient-to-r from-cyan-200 via-white to-fuchsia-300 bg-clip-text text-3xl font-black tracking-[0.35em] text-transparent drop-shadow-[0_0_18px_rgba(120,200,255,0.45)]">
            {text}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function UnlockToasts() {
  const outcome = useGame((s) => s.outcome);
  void outcome; // Unlocks are surfaced on the game-over screen.
  return null;
}
