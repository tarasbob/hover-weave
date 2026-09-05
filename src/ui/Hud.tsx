"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useGameBundle } from "@/game/GameController";
import { LAB_BY_ID } from "@/game/core/lab";
import { MODE_LABELS } from "@/game/core/modes";
import { trialById } from "@/game/track/trials";
import {
  useGame,
  type AheadCue,
  type FlightLessonStep,
  type SectionGradeToast,
  type SkillMoment,
} from "@/game/state/game";
import { useMeta } from "@/game/state/meta";
import { useSettings } from "@/game/state/settings";

/** In-run heads-up display. Pure DOM over the canvas, throttled by the loop. */
export function Hud() {
  const bundle = useGameBundle();
  const phase = useGame((s) => s.phase);
  const hud = useGame((s) => s.hud);
  const mode = useGame((s) => s.mode);
  const trialId = useGame((s) => s.trialId);
  const callout = useGame((s) => s.callout);
  const skillMoment = useGame((s) => s.skillMoment);
  const sectionGrade = useGame((s) => s.sectionGrade);
  const aheadCue = useGame((s) => s.aheadCue);
  const lesson = useGame((s) => s.lesson);
  const fps = useGame((s) => s.fps);
  const graphics = useGame((s) => s.graphics);
  const showFps = useSettings((s) => s.showFps);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const bestScore = useMeta((s) => s.bestScore);

  const inRun = phase === "running" || phase === "paused" || phase === "dead";
  if (!inRun) return null;

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div
        className="safe-frame pointer-events-none fixed z-10 font-display"
        data-reduce-motion={reduceMotion}
      >
        {phase === "running" && (
          <button
            className="pointer-events-auto absolute bottom-3 left-3 grid h-11 w-11 place-items-center rounded-lg border border-white/20 bg-[#08151f]/80 text-slate-200 hover:bg-white/15 sm:bottom-5 sm:left-5"
            aria-label="Pause flight"
            title="Pause flight (Esc / P)"
            data-ui
            onClick={() => bundle.togglePause()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="3" y="2" width="3" height="12" rx="0.5" />
              <rect x="10" y="2" width="3" height="12" rx="0.5" />
            </svg>
          </button>
        )}
      {/* Score block */}
      <div className="absolute left-3 top-3 sm:left-5 sm:top-5">
        <div className="text-[11px] tracking-[0.3em] text-white/50">SCORE</div>
        <div className="text-3xl font-bold tabular-nums text-white drop-shadow-[0_0_12px_rgba(90,220,255,0.55)] sm:text-4xl">
          {hud.score.toLocaleString()}
        </div>
        {/* Pressure line: a quiet mode-aware target that flips gold once cleared. */}
        {hud.objectiveHit ? (
          <div className="mt-0.5 text-[10px] font-bold tracking-[0.22em] text-amber-200">
            {hud.objectiveHit}
          </div>
        ) : hud.objective ? (
          <div className="mt-0.5 text-[10px] tracking-[0.22em] text-white/35 tabular-nums">
            {hud.objective}
          </div>
        ) : null}
        <div className="mt-2 flex max-w-[62vw] flex-wrap items-center gap-1.5 sm:gap-2">
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
          <div
            className={`h-1.5 w-20 overflow-hidden rounded-full bg-white/10 sm:w-28 ${
              hud.flowTier > 0 && hud.flowGrace < 0.22 && !reduceMotion ? "animate-pulse" : ""
            }`}
            title={hud.flowGrace < 0.22 ? "Flow is decaying" : "Flow tier progress"}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-fuchsia-400 transition-[width] duration-150"
              style={{ width: `${Math.min(hud.flowFrac * 100, 100)}%` }}
            />
          </div>
          {hud.flowTier > 0 && (
            <div className="text-xs font-semibold text-cyan-200/90">FLOW {hud.flowTier}</div>
          )}
          {hud.flowChain > 1 && (
            <div className="text-xs font-bold tabular-nums text-fuchsia-200">
              CHAIN {hud.flowChain}
            </div>
          )}
        </div>
      </div>

      {/* Mode / timer / biome / best */}
      <div className="absolute right-3 top-3 text-right sm:right-5 sm:top-5">
        <div className="text-[11px] tracking-[0.3em] text-white/50">
          {mode === "trial" && trialId
            ? `TRIAL · ${(trialById(trialId)?.name ?? trialId).toUpperCase()}`
            : MODE_LABELS[mode]}
        </div>
        {hud.timeLeft !== null && (
          <div
            className={`mt-0.5 text-xl font-bold tabular-nums ${
              hud.timeLeft <= 10
                ? `text-rose-300 ${reduceMotion ? "" : "animate-pulse"}`
                : "text-white/85"
            }`}
            role="timer"
            aria-label="Sprint time remaining"
          >
            {formatTimer(hud.timeLeft)}
          </div>
        )}
        {hud.heatMult > 1 && (
          <div className="mt-0.5 text-[10px] font-bold tracking-[0.2em] text-orange-300/90">
            HEAT ×{hud.heatMult.toFixed(2)}
          </div>
        )}
        {hud.lab.length > 0 && (
          <div
            className="mt-0.5 text-[10px] font-bold tracking-[0.2em] text-violet-300/90"
            title="Lab prototype active — this run is unranked"
          >
            LAB · {hud.lab.map((id) => LAB_BY_ID[id].name.toUpperCase()).join(" · ")}
          </div>
        )}
        <div className="text-sm text-white/80">{hud.biome}</div>
        {mode !== "trial" && (
          <div className="mt-1 text-[11px] tabular-nums text-white/40">
            BEST {bestScore.toLocaleString()}
          </div>
        )}
        {showFps && (
          <div
            className="mt-1 font-mono text-[10px] tabular-nums text-emerald-300/80"
            data-performance={JSON.stringify(graphics)}
          >
            <div>{fps} FPS · DPR {graphics.dpr.toFixed(2)} · DRS {graphics.drsScale.toFixed(2)}</div>
            <div>
              Frame {graphics.frameMs.toFixed(1)}ms · p95 {graphics.frameP95Ms.toFixed(1)} · p99 {graphics.frameP99Ms.toFixed(1)}
            </div>
            <div>
              CPU {graphics.cpuMs.toFixed(2)}ms · GPU {graphics.gpuMs === null
                ? graphics.gpuStatus
                : `${graphics.gpuMs.toFixed(2)}ms · p95 ${graphics.gpuP95Ms?.toFixed(2)}`}
            </div>
            <div>
              {graphics.drawCalls} calls · {(graphics.triangles / 1000).toFixed(0)}k tris ·{" "}
              {graphics.textures} tex
            </div>
          </div>
        )}
      </div>

      {/* Distance + speed + ghost race */}
      <div className="absolute bottom-3 right-3 text-right sm:bottom-5 sm:right-5">
        <div className="text-2xl font-bold tabular-nums text-white/90">
          {hud.distance.toLocaleString()}
          <span className="ml-1 text-sm font-normal text-white/50">m</span>
        </div>
        <div className="text-sm tabular-nums text-white/60">{hud.speedKmh} km/h</div>
        {hud.ghostDelta !== null && (
          <div
            className={`mt-0.5 text-[11px] font-semibold tabular-nums tracking-[0.14em] ${
              hud.ghostDelta >= 0 ? "text-emerald-300/90" : "text-sky-300/70"
            }`}
          >
            {hud.ghostDelta >= 0 ? "+" : "−"}
            {Math.abs(Math.round(hud.ghostDelta)).toLocaleString()} m GHOST
          </div>
        )}
      </div>

      {/* Energy + shield + dash */}
      <div className="absolute bottom-4 left-1/2 flex w-[min(18rem,calc(100vw-8rem))] -translate-x-1/2 items-center gap-2 sm:bottom-6 sm:gap-3">
        {hud.dash !== null && (
          <div
            className={`flex h-9 shrink-0 items-center rounded-full border px-2 text-[8px] font-bold tracking-wider transition-all ${
              hud.dash <= 0
                ? "border-violet-300/80 bg-violet-300/15 text-violet-200 shadow-[0_0_12px_rgba(167,139,250,0.45)]"
                : "border-white/15 bg-white/5 text-white/25"
            }`}
            title={hud.dash <= 0 ? "Phase dash ready" : "Phase dash recharging"}
            role="status"
            aria-label={hud.dash <= 0 ? "Phase dash ready" : "Phase dash recharging"}
          >
            {hud.dash <= 0 ? "DASH" : `${hud.dash.toFixed(1)}s`}
          </div>
        )}
        <div
          className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-2 transition-all ${
            hud.shield
              ? "border-amber-300/80 bg-amber-300/15 text-amber-200 shadow-[0_0_14px_rgba(252,211,77,0.5)]"
              : "border-white/15 bg-white/5 text-white/25"
          }`}
          title={hud.shield ? "Shield active" : "No shield"}
          role="status"
          aria-label={hud.shield ? "Shield active" : "No shield"}
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
          <span className="text-[8px] font-bold tracking-wider">
            {hud.shield ? "SHIELD" : "NO SHIELD"}
          </span>
        </div>
        <div className="flex-1">
          <div className="mb-1 flex justify-between text-[10px] tracking-[0.25em] text-white/45">
            <span>ENERGY</span>
            <span className={hud.surge ? "text-emerald-300" : hud.boosting ? "text-amber-300" : ""}>
              {hud.surge
                ? "SURGE — FREE BOOST"
                : hud.boosting
                  ? "BOOSTING"
                  : hud.shardCombo > 1
                    ? `SHARDS ×${hud.shardCombo}`
                    : boostHint()}
            </span>
          </div>
          <div
            className={`h-2 overflow-hidden rounded-full bg-white/10 transition-shadow ${
              hud.surge ? "shadow-[0_0_14px_rgba(52,211,153,0.55)]" : ""
            }`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${
                hud.surge
                  ? "bg-gradient-to-r from-emerald-300 to-cyan-300"
                  : hud.boosting
                    ? "bg-gradient-to-r from-amber-300 to-orange-400"
                    : "bg-gradient-to-r from-cyan-300 to-sky-400"
              }`}
              // While a surge window is open the bar reads as the surge
              // indicator (boost is free), not the energy meter.
              style={{ width: `${hud.surge ? 100 : hud.energy}%` }}
            />
          </div>
        </div>
      </div>

      {/* Center callouts */}
      <AheadCueToast key={`ahead-${aheadCue?.at ?? "none"}`} cue={aheadCue} />
      {phase === "running" && lesson && <FlightLesson step={lesson} />}
      <CalloutToast
        key={`callout-${callout?.at ?? "none"}`}
        text={callout?.text}
        sub={callout?.sub}
        at={callout?.at}
      />
      <SkillMomentToast
        key={`skill-${skillMoment?.at ?? "none"}`}
        moment={skillMoment}
      />
      <SectionGradeChip
        key={`grade-${sectionGrade?.at ?? "none"}`}
        toast={sectionGrade}
      />
      <UnlockToasts />
      </div>
    </MotionConfig>
  );
}

export const GRADE_COLORS: Record<string, string> = {
  S: "text-amber-200 border-amber-300/50 bg-amber-300/10",
  A: "text-emerald-200 border-emerald-300/40 bg-emerald-300/10",
  B: "text-sky-200 border-sky-300/35 bg-sky-300/10",
  C: "text-white/55 border-white/20 bg-white/5",
};

/** Transient per-chunk line grade (roadmap 3.4) beside the distance readout. */
function SectionGradeChip({ toast }: { toast: SectionGradeToast | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <AnimatePresence>
      {visible && toast && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, x: 14 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 10 }}
          transition={{ duration: 0.2 }}
          className="absolute bottom-20 right-3 flex items-center gap-2 sm:bottom-24 sm:right-5"
        >
          <span className="text-[9px] tracking-[0.24em] text-white/45">
            {formatPatternId(toast.patternId)}
          </span>
          <span
            className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border font-display text-sm font-black ${
              GRADE_COLORS[toast.grade]
            }`}
          >
            {toast.grade}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function formatPatternId(id: string): string {
  return id.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}

/** Sprint countdown, m:ss.d — precise enough to feel the last seconds. */
function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const whole = Math.floor(s);
  const tenth = Math.floor((s - whole) * 10);
  return `${m}:${String(whole).padStart(2, "0")}.${tenth}`;
}

function boostHint(): string {
  const touch = typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches;
  return touch ? "2ND FINGER" : "SHIFT / SPACE";
}

/** Quiet visual twin of the audio leitmotif at the lookahead horizon. */
function AheadCueToast({ cue }: { cue: AheadCue | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!cue) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2400);
    return () => clearTimeout(timer);
  }, [cue]);
  return (
    <AnimatePresence>
      {visible && cue && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="absolute left-1/2 top-[14%] -translate-x-1/2 rounded-full border border-white/10 bg-[#080817]/65 px-4 py-1.5 text-center backdrop-blur"
        >
          <div className="text-[9px] tracking-[0.24em] text-white/45">
            {Math.max(1, Math.round(cue.lead))}s AHEAD
          </div>
          <div className="mt-0.5 text-[10px] font-bold tracking-[0.18em] text-fuchsia-200/85">
            {formatPatternId(cue.patternId)}
            {cue.skills.length > 0 && ` · ${cue.skills.slice(0, 2).join(" · ").toUpperCase()}`}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Progressive first-flight prompt: one idea at a time, dismissed by play. */
function FlightLesson({ step }: { step: FlightLessonStep }) {
  const touch = typeof window !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const copy: Record<FlightLessonStep, { title: string; detail: string }> = {
    steer: {
      title: touch ? "HOLD EITHER SCREEN HALF" : "HOLD ← / → OR A / D",
      detail: "MOMENTUM IS REAL · TURN BEFORE THE GAP",
    },
    graze: {
      title: "SKIM A GLOWING EDGE",
      detail: "CLOSE PASSES BUILD FLOW AND REFILL BOOST",
    },
    boost: {
      title: touch ? "SECOND FINGER TO BOOST" : "HOLD SHIFT / SPACE TO BOOST",
      detail: "FASTER, BUT WITH LESS TURN AUTHORITY",
    },
    rhythm: {
      title: "MOVERS FOLLOW THE BEAT",
      detail: "WATCH, LISTEN, THEN ARRIVE IN THE OPENING",
    },
    jump: {
      title: "RIDE THE GLOWING RAMP",
      detail: touch
        ? "TAP THE BOOST FINGER MID-AIR TO DOUBLE JUMP · HOLD IT TO DIVE"
        : "TAP BOOST MID-AIR TO DOUBLE JUMP · HOLD IT TO DIVE",
    },
  };
  const message = copy[step];
  return (
    <motion.div
      key={step}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flight-lesson absolute rounded-xl border border-emerald-200/20 bg-[#08151f]/90 px-4 py-3 backdrop-blur-md"
    >
      <div className="font-body text-xs font-semibold tracking-[0.06em] text-emerald-100">
        {message.title}
      </div>
      <div className="mt-1 font-body text-[10px] leading-relaxed tracking-[0.04em] text-slate-400">
        {message.detail}
      </div>
    </motion.div>
  );
}

function CalloutToast({ text, sub, at }: { text?: string; sub?: string; at?: number }) {
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
          role="status"
          aria-live="polite"
          aria-atomic="true"
          initial={{ opacity: 0, y: 18, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -14, scale: 1.04 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="absolute left-1/2 top-[24%] -translate-x-1/2 text-center"
        >
          <div className="bg-gradient-to-r from-cyan-200 via-white to-fuchsia-300 bg-clip-text text-3xl font-black tracking-[0.35em] text-transparent drop-shadow-[0_0_18px_rgba(120,200,255,0.45)]">
            {text}
          </div>
          {sub && <div className="mt-1 text-[10px] tracking-[0.35em] text-white/55">{sub}</div>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SkillMomentToast({
  moment,
}: {
  moment: SkillMoment | null;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!moment) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 950);
    return () => clearTimeout(t);
  }, [moment]);

  const tone =
    moment?.tone === "perfect"
      ? "text-amber-200"
      : moment?.tone === "razor"
        ? "text-fuchsia-200"
        : moment?.tone === "shard"
          ? "text-cyan-200"
          : moment?.tone === "thread"
            ? "text-emerald-200"
            : "text-white/85";

  return (
    <AnimatePresence>
      {visible && moment && (
        <motion.div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          initial={{ opacity: 0, y: 8, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 1.03 }}
          transition={{ duration: 0.18 }}
          className="absolute left-1/2 top-[38%] -translate-x-1/2 text-center"
        >
          <div className={`font-display text-lg font-black tracking-[0.22em] ${tone}`}>
            {moment.text}
          </div>
          <div className="mt-0.5 text-[10px] font-semibold tracking-[0.16em] text-white/60">
            {moment.detail}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function UnlockToasts() {
  const outcome = useGame((s) => s.outcome);
  const markCelebrated = useMeta((s) => s.markCelebrated);
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    if (!outcome) {
      setNames([]);
      return;
    }
    const celebrated = useMeta.getState().celebrated;
    const fresh = outcome.unlocked.filter((item) => !celebrated.includes(item.id));
    if (fresh.length === 0) {
      setNames([]);
      return;
    }
    setNames(fresh.map((item) => item.name));
    for (const item of fresh) markCelebrated(item.id);
    const t = setTimeout(() => setNames([]), 3200);
    return () => clearTimeout(t);
  }, [outcome, markCelebrated]);

  return (
    <AnimatePresence>
      {names.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-xl border border-cyan-300/30 bg-[#08131d]/85 px-5 py-3 text-center backdrop-blur"
        >
          <div className="font-display text-xs font-black tracking-[0.25em] text-cyan-200">
            NEW COSMETIC UNLOCKED
          </div>
          <div className="mt-1 text-sm text-white/80">{names.join(" · ")}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
