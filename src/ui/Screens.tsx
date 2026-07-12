"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useGameBundle } from "@/game/GameController";
import { useGame } from "@/game/state/game";
import { CRAFTS, TRAILS, metaSnapshot, useMeta } from "@/game/state/meta";
import { resolveTier, useSettings, type QualityPreset } from "@/game/state/settings";
import { dailyKey } from "@/game/core/rng";
import { FLOW } from "@/game/core/constants";

const panel =
  "rounded-2xl border border-white/10 bg-[#0b0a1a]/70 backdrop-blur-xl shadow-[0_0_60px_rgba(80,40,180,0.25)]";

const btn =
  "pointer-events-auto rounded-xl px-6 py-3 font-display font-bold tracking-[0.2em] transition-all duration-150 active:scale-[0.97]";
const btnPrimary = `${btn} bg-gradient-to-r from-cyan-400/90 to-fuchsia-500/90 text-[#07060f] hover:brightness-110 shadow-[0_0_24px_rgba(80,220,255,0.35)]`;
const btnGhost = `${btn} border border-white/15 bg-white/5 text-white/85 hover:bg-white/10`;

export function Screens() {
  const phase = useGame((s) => s.phase);
  const overlay = useGame((s) => s.overlay);

  return (
    <div className="pointer-events-none fixed inset-0 z-20 font-body" data-ui>
      <AnimatePresence mode="wait">
        {phase === "boot" && <BootScreen key="boot" />}
        {phase === "title" && overlay === "none" && <TitleScreen key="title" />}
        {phase === "paused" && overlay === "none" && <PauseScreen key="pause" />}
        {phase === "dead" && overlay === "none" && <GameOverScreen key="dead" />}
      </AnimatePresence>
      <AnimatePresence>
        {overlay === "hangar" && <HangarOverlay key="hangar" />}
        {overlay === "settings" && <SettingsOverlay key="settings" />}
        {overlay === "help" && <HelpOverlay key="help" />}
      </AnimatePresence>
    </div>
  );
}

function Screen({ children, dim = true }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className={`absolute inset-0 flex items-center justify-center ${dim ? "bg-[#05030c]/55" : ""}`}
    >
      {children}
    </motion.div>
  );
}

function BootScreen() {
  return (
    <Screen>
      <div className="text-center">
        <Logo />
        <div className="mt-6 h-1 w-48 overflow-hidden rounded-full bg-white/10 mx-auto">
          <motion.div
            className="h-full w-1/3 rounded-full bg-cyan-300"
            animate={{ x: [-64, 192] }}
            transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
          />
        </div>
        <div className="mt-3 text-xs tracking-[0.3em] text-white/40">CALIBRATING GRAVITICS</div>
      </div>
    </Screen>
  );
}

function Logo() {
  return (
    <div className="font-display">
      <div className="bg-gradient-to-br from-cyan-200 via-white to-fuchsia-400 bg-clip-text text-6xl font-black tracking-[0.28em] text-transparent drop-shadow-[0_0_30px_rgba(110,60,255,0.6)] md:text-7xl">
        CUBEFIELD
      </div>
      <div className="mt-2 text-[11px] tracking-[0.62em] text-cyan-200/70">
        NEON HORIZON RUNNER
      </div>
    </div>
  );
}

function TitleScreen() {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  const webgpu = useGame((s) => s.webgpu);
  const meta = useMeta();
  const today = dailyKey();
  const dailyRecord = meta.dailyBest[today];

  return (
    <Screen dim={false}>
      <div className="pointer-events-auto flex flex-col items-center gap-8 text-center">
        <motion.div
          initial={{ y: -26, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <Logo />
        </motion.div>

        <motion.div
          initial={{ y: 22, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="flex flex-col items-center gap-3"
        >
          <button className={`${btnPrimary} text-lg`} onClick={() => bundle.startRun("endless")}>
            LAUNCH
          </button>
          <button className={btnGhost} onClick={() => bundle.startRun("daily")}>
            DAILY COURSE
            <span className="ml-2 text-[10px] text-cyan-200/70 tracking-widest">
              {dailyRecord ? `BEST ${dailyRecord.score.toLocaleString()}` : today}
            </span>
          </button>
          <div className="mt-1 flex gap-2">
            <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("hangar")}>
              HANGAR
            </button>
            <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("settings")}>
              SETTINGS
            </button>
            <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("help")}>
              HOW TO FLY
            </button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="text-xs text-white/45"
        >
          {meta.bestScore > 0 && (
            <div className="mb-1 tabular-nums">
              PERSONAL BEST {meta.bestScore.toLocaleString()} · {Math.floor(meta.bestDistance).toLocaleString()} m
            </div>
          )}
          <div className="tracking-[0.2em]">
            {webgpu === null ? "" : webgpu ? "WEBGPU ENGAGED" : "WEBGL2 COMPATIBILITY MODE"}
          </div>
        </motion.div>
      </div>
    </Screen>
  );
}

function PauseScreen() {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  return (
    <Screen>
      <div className={`${panel} pointer-events-auto flex flex-col items-center gap-5 px-12 py-10`}>
        <div className="font-display text-3xl font-black tracking-[0.3em] text-white">PAUSED</div>
        <div className="flex flex-col gap-2.5">
          <button className={btnPrimary} onClick={() => bundle.togglePause()}>
            RESUME
          </button>
          <button className={btnGhost} onClick={() => setOverlay("settings")}>
            SETTINGS
          </button>
          <button className={btnGhost} onClick={() => bundle.backToTitle()}>
            ABANDON RUN
          </button>
        </div>
        <div className="text-xs text-white/40">ESC / P to resume</div>
      </div>
    </Screen>
  );
}

function GameOverScreen() {
  const bundle = useGameBundle();
  const outcome = useGame((s) => s.outcome);
  const mode = useGame((s) => s.mode);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 700);
    return () => clearTimeout(t);
  }, []);

  if (!outcome || !show) return null;
  const s = outcome.stats;

  return (
    <Screen>
      <motion.div
        initial={{ y: 26, opacity: 0, scale: 0.97 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className={`${panel} pointer-events-auto w-[min(92vw,480px)] px-8 py-8`}
      >
        <div className="text-center">
          <div className="font-display text-2xl font-black tracking-[0.3em] text-rose-300">
            SIGNAL LOST
          </div>
          {(outcome.newBestScore || (mode === "daily" && outcome.newDailyBest)) && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.3, type: "spring", stiffness: 240 }}
              className="mt-2 inline-block rounded-full bg-gradient-to-r from-amber-300/25 to-fuchsia-400/25 px-4 py-1 font-display text-sm font-bold tracking-[0.2em] text-amber-200"
            >
              {mode === "daily" && outcome.newDailyBest ? "NEW DAILY BEST" : "NEW PERSONAL BEST"}
            </motion.div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 text-center">
          <Stat label="SCORE" value={s.score.toLocaleString()} big />
          <Stat label="DISTANCE" value={`${Math.floor(s.distance).toLocaleString()} m`} big />
          <Stat label="NEAR MISSES" value={String(s.nearMisses)} />
          <Stat label="SHARDS" value={String(s.shards)} />
          <Stat label="PEAK FLOW" value={`×${(1 + s.maxFlowPoints * FLOW.MULT_PER_POINT).toFixed(2)}`} />
          <Stat label="TIME" value={`${s.duration.toFixed(1)}s`} />
        </div>

        {outcome.unlocked.length > 0 && (
          <div className="mt-5 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-3">
            {outcome.unlocked.map((u) => (
              <div key={u.id} className="font-display text-sm font-bold tracking-[0.15em] text-cyan-200">
                UNLOCKED · {u.name} {u.kind === "craft" ? "CRAFT" : "TRAIL"}
              </div>
            ))}
          </div>
        )}

        <div className="mt-7 flex justify-center gap-3">
          <button className={btnPrimary} onClick={() => bundle.restart()}>
            RETRY
          </button>
          <button className={btnGhost} onClick={() => bundle.backToTitle()}>
            MENU
          </button>
        </div>
        <div className="mt-3 text-center text-xs text-white/40">R / ENTER for instant restart</div>
      </motion.div>
    </Screen>
  );
}

function Stat({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="rounded-xl bg-white/5 px-3 py-2.5">
      <div className="text-[10px] tracking-[0.25em] text-white/45">{label}</div>
      <div className={`font-display font-bold tabular-nums text-white ${big ? "text-xl" : "text-base"}`}>
        {value}
      </div>
    </div>
  );
}

function OverlayShell({ title, children }: { title: string; children: React.ReactNode }) {
  const setOverlay = useGame((s) => s.setOverlay);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-[#05030c]/70"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOverlay("none");
      }}
    >
      <motion.div
        initial={{ y: 24, scale: 0.97, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 18, scale: 0.98, opacity: 0 }}
        transition={{ duration: 0.28, ease: "easeOut" }}
        className={`${panel} max-h-[86vh] w-[min(94vw,660px)] overflow-y-auto px-7 py-6`}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="font-display text-xl font-black tracking-[0.3em] text-white">{title}</div>
          <button
            className="rounded-lg border border-white/15 px-3 py-1 text-sm text-white/70 hover:bg-white/10"
            onClick={() => setOverlay("none")}
          >
            ✕
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

function HangarOverlay() {
  const meta = useMeta();
  const snap = useMemo(() => metaSnapshot(meta), [meta]);

  return (
    <OverlayShell title="HANGAR">
      <div className="mb-2 text-xs tracking-[0.25em] text-white/50">CRAFT</div>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        {CRAFTS.map((c) => {
          const unlocked = c.unlock.check(snap);
          const selected = meta.selectedCraft === c.id;
          return (
            <button
              key={c.id}
              disabled={!unlocked}
              onClick={() => meta.selectCraft(c.id)}
              className={`rounded-xl border p-3 text-left transition-all ${
                selected
                  ? "border-cyan-300/70 bg-cyan-300/10 shadow-[0_0_18px_rgba(90,220,255,0.25)]"
                  : unlocked
                    ? "border-white/10 bg-white/5 hover:bg-white/10"
                    : "border-white/5 bg-white/[0.02] opacity-50"
              }`}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ background: c.trim, boxShadow: `0 0 8px ${c.trim}` }}
                />
                <span className="font-display text-sm font-bold tracking-wider text-white">
                  {c.name}
                </span>
              </div>
              <div className="text-[11px] leading-snug text-white/55">
                {unlocked ? c.desc : c.unlock.label}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mb-2 mt-6 text-xs tracking-[0.25em] text-white/50">TRAIL</div>
      <div className="grid grid-cols-3 gap-2.5 md:grid-cols-6">
        {TRAILS.map((t) => {
          const unlocked = t.unlock.check(snap);
          const selected = meta.selectedTrail === t.id;
          return (
            <button
              key={t.id}
              disabled={!unlocked}
              title={unlocked ? t.name : t.unlock.label}
              onClick={() => meta.selectTrail(t.id)}
              className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-all ${
                selected
                  ? "border-cyan-300/70 bg-cyan-300/10"
                  : unlocked
                    ? "border-white/10 bg-white/5 hover:bg-white/10"
                    : "border-white/5 bg-white/[0.02] opacity-45"
              }`}
            >
              <span
                className="h-8 w-1.5 rounded-full"
                style={{ background: t.color, boxShadow: `0 0 10px ${t.color}` }}
              />
              <span className="text-[10px] text-white/70">{t.name.split(" ")[0]}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 text-center md:grid-cols-4">
        <Stat label="RUNS" value={String(meta.totalRuns)} />
        <Stat label="LIFETIME KM" value={(meta.totalDistance / 1000).toFixed(1)} />
        <Stat label="SHARDS" value={String(meta.totalShards)} />
        <Stat label="NEAR MISSES" value={String(meta.totalNearMisses)} />
      </div>
    </OverlayShell>
  );
}

function SettingsOverlay() {
  const s = useSettings();
  const tier = resolveTier(s);

  return (
    <OverlayShell title="SETTINGS">
      <div className="flex flex-col gap-5">
        <Row label="QUALITY" hint={`active tier: ${["LOW", "MEDIUM", "HIGH"][tier]}`}>
          <div className="flex gap-1.5">
            {(["auto", "low", "medium", "high"] as QualityPreset[]).map((q) => (
              <button
                key={q}
                onClick={() => s.setQuality(q)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold tracking-wider transition-colors ${
                  s.quality === q ? "bg-cyan-300/25 text-cyan-100" : "bg-white/5 text-white/55 hover:bg-white/10"
                }`}
              >
                {q.toUpperCase()}
              </button>
            ))}
          </div>
        </Row>
        <Row label="MUSIC">
          <Slider value={s.musicVolume} onChange={s.setMusicVolume} />
        </Row>
        <Row label="SFX">
          <Slider value={s.sfxVolume} onChange={s.setSfxVolume} />
        </Row>
        <Row label="STEERING SENSITIVITY">
          <Slider value={s.sensitivity} min={0.5} max={1.5} onChange={s.setSensitivity} />
        </Row>
        <Row label="REDUCE MOTION" hint="Softer camera shake and FOV kicks">
          <Toggle value={s.reduceMotion} onChange={s.setReduceMotion} />
        </Row>
        <Row label="REDUCE FLASHES" hint="Caps lightning and flash effects">
          <Toggle value={s.reduceFlash} onChange={s.setReduceFlash} />
        </Row>
        <Row label="SHOW FPS">
          <Toggle value={s.showFps} onChange={s.setShowFps} />
        </Row>
      </div>
    </OverlayShell>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-semibold tracking-wider text-white/85">{label}</div>
        {hint && <div className="text-[11px] text-white/40">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Slider({
  value, onChange, min = 0, max = 1,
}: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={0.05}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-white/15 accent-cyan-300"
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative h-6 w-11 rounded-full transition-colors ${value ? "bg-cyan-400/80" : "bg-white/15"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          value ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function HelpOverlay() {
  return (
    <OverlayShell title="HOW TO FLY">
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-white/75">
        <div>
          Your craft accelerates on its own. You only steer —{" "}
          <Key>←</Key> <Key>→</Key> or <Key>A</Key> <Key>D</Key>, drag on touch, or a gamepad stick.
          Momentum is real: commit to lines early.
        </div>
        <div>
          <span className="font-bold text-cyan-200">Near misses build FLOW.</span> Graze obstacles
          to raise your multiplier — it decays if you play safe. Higher flow intensifies the music
          and the world.
        </div>
        <div>
          <span className="font-bold text-cyan-200">Shards are fuel.</span> Hold <Key>SHIFT</Key> or{" "}
          <Key>SPACE</Key> to spend them on a boost. Boosting is fast, but steering authority drops —
          respect it.
        </div>
        <div>
          <span className="font-bold text-amber-200">Shields</span> are rare. One hit is forgiven;
          the second is not.
        </div>
        <div>
          <Key>R</Key> restarts instantly. <Key>ESC</Key> pauses. The{" "}
          <span className="font-bold text-fuchsia-300">Daily Course</span> is the same seed for
          everyone — one course, one leaderboard-worthy score.
        </div>
      </div>
    </OverlayShell>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-block rounded-md border border-white/20 bg-white/10 px-1.5 py-0.5 font-display text-[11px] font-bold text-white">
      {children}
    </span>
  );
}
