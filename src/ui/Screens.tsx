"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useGameBundle } from "@/game/GameController";
import { useGame, type RunOutcome } from "@/game/state/game";
import { CRAFTS, TRAILS, metaSnapshot, useMeta } from "@/game/state/meta";
import { useReplays } from "@/game/state/replays";
import { resolveTier, useSettings, type QualityPreset } from "@/game/state/settings";
import { dailyKey, weeklyKey } from "@/game/core/rng";
import { FLOW, SPRINT_MODE } from "@/game/core/constants";
import { HEATS, HEAT_BY_ID, heatScoreMult } from "@/game/core/heat";
import { LABS, LAB_BY_ID } from "@/game/core/lab";
import { questsForDay } from "@/game/core/quests";
import { ratingTier } from "@/game/core/rating";
import { flightFilename, parseFlight, serializeFlight } from "@/game/core/replay";
import {
  GRADE_MIN_INTENSITY,
  type RunStats,
  type SectionResult,
} from "@/game/core/world";
import {
  MEDAL_ORDER,
  TRIALS,
  medalFor,
  nextMedalFor,
  trialById,
  type Medal,
  type TrialDef,
} from "@/game/track/trials";
import { DeathForensicsPanel } from "@/ui/DeathForensics";
import { GRADE_COLORS } from "@/ui/Hud";

const panel =
  "rounded-2xl border border-white/10 bg-[#0b0a1a]/70 backdrop-blur-xl shadow-[0_0_60px_rgba(80,40,180,0.25)]";

const btn =
  "pointer-events-auto rounded-xl px-6 py-3 font-display font-bold tracking-[0.2em] transition-all duration-150 active:scale-[0.97]";
const btnPrimary = `${btn} bg-gradient-to-r from-cyan-400/90 to-fuchsia-500/90 text-[#07060f] hover:brightness-110 shadow-[0_0_24px_rgba(80,220,255,0.35)]`;
const btnGhost = `${btn} border border-white/15 bg-white/5 text-white/85 hover:bg-white/10`;

export function Screens() {
  const phase = useGame((s) => s.phase);
  const overlay = useGame((s) => s.overlay);
  const setOverlay = useGame((s) => s.setOverlay);
  const reduceMotion = useSettings((s) => s.reduceMotion);

  useEffect(() => {
    if (overlay === "none") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOverlay("none");
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [overlay, setOverlay]);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div
        className="pointer-events-none fixed inset-0 z-20 font-body"
        data-ui
        data-reduce-motion={reduceMotion}
      >
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {phase === "running"
          ? "Run started"
          : phase === "paused"
            ? "Game paused"
            : phase === "dead"
              ? "Run ended"
              : phase === "title"
                ? "Main menu"
                : "Game loading"}
      </div>
      <AnimatePresence mode="sync">
        {phase === "boot" && <BootScreen key="boot" />}
        {phase === "title" && overlay === "none" && <TitleScreen key="title" />}
        {phase === "paused" && overlay === "none" && <PauseScreen key="pause" />}
        {phase === "dead" && overlay === "none" && <GameOverScreen key="dead" />}
      </AnimatePresence>
      <AnimatePresence>
        {overlay === "hangar" && <HangarOverlay key="hangar" />}
        {overlay === "trials" && <TrialsOverlay key="trials" />}
        {overlay === "heat" && <HeatOverlay key="heat" />}
        {overlay === "lab" && <LabOverlay key="lab" />}
        {overlay === "settings" && <SettingsOverlay key="settings" />}
        {overlay === "help" && <HelpOverlay key="help" />}
      </AnimatePresence>
      </div>
    </MotionConfig>
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
      role="region"
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
      <div className="inline-flex max-w-full flex-col items-center">
        <div className="whitespace-nowrap bg-gradient-to-br from-cyan-200 via-white to-fuchsia-400 bg-clip-text text-[clamp(1.75rem,8.5vw,4.5rem)] font-black leading-none tracking-[0.08em] text-transparent drop-shadow-[0_0_30px_rgba(110,60,255,0.6)] sm:tracking-[0.14em] md:tracking-[0.18em]">
          HOVER WEAVE
        </div>
        <svg
          aria-hidden="true"
          className="mt-1.5 h-3 w-[min(76vw,24rem)] overflow-visible"
          viewBox="0 0 320 20"
          fill="none"
        >
          <path
            d="M2 5C45 5 55 15 88 15S133 5 160 5 207 15 232 15 278 5 318 5"
            className="stroke-cyan-300/80"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M2 15C45 15 55 5 88 5S133 15 160 15 207 5 232 5 278 15 318 15"
            className="stroke-fuchsia-400/70"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <div className="mt-1.5 whitespace-nowrap text-[8px] tracking-[0.28em] text-cyan-200/70 sm:text-[10px] sm:tracking-[0.5em]">
          THREAD THE IMPOSSIBLE
        </div>
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
  const week = weeklyKey();
  const sprintRecord = meta.sprintBest[week];
  const heatMult = heatScoreMult(meta.selectedHeat);
  const tier = ratingTier(meta.rating);
  const firstFlight = !meta.onboardingComplete;
  const [importError, setImportError] = useState("");
  const flightInput = useRef<HTMLInputElement>(null);

  const importFlight = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const recording = parseFlight(await file.text());
      setImportError("");
      bundle.raceRecording(recording);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not read that flight");
    }
  };

  return (
    <Screen dim={false}>
      <div className="pointer-events-auto flex flex-col items-center gap-5 px-4 text-center sm:gap-8">
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
          <div className="flex items-stretch justify-center gap-2">
            <button className={`${btnPrimary} text-lg`} onClick={() => bundle.startRun("endless")}>
              {firstFlight ? "BEGIN FIRST FLIGHT" : "LAUNCH"}
              {!firstFlight && heatMult > 1 && (
                <span className="ml-2 text-xs tracking-widest text-orange-900/90">
                  HEAT ×{heatMult.toFixed(2)}
                </span>
              )}
              {!firstFlight && meta.selectedLab.length > 0 && (
                <span className="ml-2 text-xs tracking-widest text-violet-900/90">LAB</span>
              )}
            </button>
            {!firstFlight && (
              <>
                <button
                  className={`${btnGhost} !px-3 ${meta.selectedHeat.length > 0 ? "!border-orange-300/50 !text-orange-200" : ""}`}
                  onClick={() => setOverlay("heat")}
                  title="Opt-in burdens for a multiplied score"
                  aria-label="Configure heat modifiers"
                >
                  HEAT
                </button>
                <button
                  className={`${btnGhost} !px-3 ${meta.selectedLab.length > 0 ? "!border-violet-300/50 !text-violet-200" : ""}`}
                  onClick={() => setOverlay("lab")}
                  title="Experimental prototypes — lab runs are unranked"
                  aria-label="Configure lab prototypes"
                >
                  LAB
                </button>
              </>
            )}
          </div>
          {firstFlight ? (
            <div className="max-w-sm text-xs leading-relaxed tracking-[0.12em] text-white/55">
              STEER · GRAZE · BOOST
              <div className="mt-1 tracking-normal text-white/40">
                The opening teaches each system while you fly. No setup required.
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap justify-center gap-2">
                <button className={btnGhost} onClick={() => bundle.startRun("daily")}>
                  DAILY COURSE
                  <span className="ml-2 text-[10px] text-cyan-200/70 tracking-widest">
                    {dailyRecord ? `BEST ${dailyRecord.score.toLocaleString()}` : today}
                  </span>
                </button>
                <button className={btnGhost} onClick={() => bundle.startRun("sprint")}>
                  SPRINT
                  <span className="ml-2 text-[10px] text-fuchsia-200/70 tracking-widest">
                    {sprintRecord
                      ? `BEST ${sprintRecord.score.toLocaleString()}`
                      : `${SPRINT_MODE.DURATION}s · ${week}`}
                  </span>
                </button>
              </div>
              <DailyQuestCard />
            </>
          )}
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            {!firstFlight && (
              <>
                <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("trials")}>
                  TRIALS
                </button>
                <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("hangar")}>
                  HANGAR
                </button>
                <button
                  className={`${btnGhost} !px-4 !py-2 text-sm`}
                  onClick={() => flightInput.current?.click()}
                >
                  RACE FLIGHT
                </button>
                <input
                  ref={flightInput}
                  type="file"
                  accept=".flight,application/json"
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={importFlight}
                />
              </>
            )}
            <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("settings")}>
              SETTINGS
            </button>
            <button className={`${btnGhost} !px-4 !py-2 text-sm`} onClick={() => setOverlay("help")}>
              HOW TO FLY
            </button>
          </div>
          {importError && (
            <div role="alert" className="max-w-md text-xs text-rose-300/85">
              {importError}
            </div>
          )}
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
          {meta.ratedRuns > 0 && (
            <div className="mb-1 tabular-nums tracking-[0.14em] text-cyan-200/70">
              PILOT RATING {meta.rating.toLocaleString()} · {tier.name}
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
      <div
        className={`${panel} pointer-events-auto flex flex-col items-center gap-5 px-7 py-8 sm:px-12 sm:py-10`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-title"
      >
        <div id="pause-title" className="font-display text-3xl font-black tracking-[0.3em] text-white">
          PAUSED
        </div>
        <div className="flex flex-col gap-2.5">
          <button autoFocus className={btnPrimary} onClick={() => bundle.togglePause()}>
            RESUME
          </button>
          <button className={btnGhost} onClick={() => setOverlay("settings")}>
            SETTINGS
          </button>
          <button className={btnGhost} onClick={() => bundle.restart()}>
            RESTART RUN
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
  const lastRun = useReplays((s) => s.lastRun);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), 260);
    return () => clearTimeout(t);
  }, []);

  if (!outcome || !show) return null;
  const s = outcome.stats;
  const labRun = s.lab.length > 0;
  const unranked = labRun || outcome.rival;
  const graded = s.sections.filter(
    (section) => section.intensity >= GRADE_MIN_INTENSITY,
  );
  const weakest = graded.reduce<SectionResult | null>(
    (worst, section) =>
      worst === null || section.composite < worst.composite ? section : worst,
    null,
  );
  const trial = mode === "trial" && s.trialId ? trialById(s.trialId) : undefined;
  // Practice-room shortcut: the pattern that just killed an open-track run
  // may exist as a trial — offer to drill it (roadmap 4.1).
  const drillTrial =
    mode !== "trial" && s.deathCause ? trialById(s.deathCause.patternId) : undefined;
  const bestBadge =
    mode === "daily" && outcome.newDailyBest
      ? "NEW DAILY BEST"
      : mode === "sprint" && outcome.newSprintBest
        ? "NEW WEEKLY BEST"
        : mode === "trial" && outcome.newTrialBest
          ? "NEW TRIAL BEST"
          : outcome.newBestScore
            ? "NEW PERSONAL BEST"
            : null;
  const scoreDeltaLabel = mode === "sprint" ? "WEEK BEST" : "PB";
  const coaching = deathCoach(outcome);
  const exportRun = () => {
    if (!lastRun) return;
    const blob = new Blob([serializeFlight(lastRun)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = flightFilename(lastRun);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <Screen>
      <motion.div
        initial={{ y: 26, opacity: 0, scale: 0.97 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className={`${panel} pointer-events-auto max-h-[92vh] w-[min(94vw,540px)] overflow-y-auto px-5 py-6 sm:px-8 sm:py-8`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-over-title"
      >
        <div className="text-center">
          <div
            id="game-over-title"
            className={`font-display text-2xl font-black tracking-[0.3em] ${
              outcome.finished ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {outcome.finished ? "TRANSMISSION COMPLETE" : "SIGNAL LOST"}
          </div>
          {mode === "trial" && trial && (
            <div className="mt-1 text-[11px] tracking-[0.3em] text-white/50">
              TRIAL · {trial.name.toUpperCase()}
            </div>
          )}
          {bestBadge && (
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.3, type: "spring", stiffness: 240 }}
              className="mt-2 inline-block rounded-full bg-gradient-to-r from-amber-300/25 to-fuchsia-400/25 px-4 py-1 font-display text-sm font-bold tracking-[0.2em] text-amber-200"
            >
              {bestBadge}
            </motion.div>
          )}
        </div>

        {trial && (
          <TrialResult trial={trial} distance={s.distance} medal={outcome.medal} />
        )}

        <div className="mt-6 grid grid-cols-2 gap-3 text-center">
          <Stat label="SCORE" value={s.score.toLocaleString()} big />
          <Stat label="DISTANCE" value={`${Math.floor(s.distance).toLocaleString()} m`} big />
          <Stat label="NEAR MISSES" value={String(s.nearMisses)} />
          <Stat label="SHARDS" value={String(s.shards)} />
          <Stat label="PEAK FLOW" value={`×${(1 + s.maxFlowPoints * FLOW.MULT_PER_POINT).toFixed(2)}`} />
          <Stat label="TIME" value={`${s.duration.toFixed(1)}s`} />
          <Stat label="PERFECT PASSES" value={String(s.perfectPasses)} />
          <Stat label="THREADS" value={String(s.threads)} />
          <Stat label="BEST CHAIN" value={String(s.bestFlowChain)} />
          <Stat label="BOOST TIME" value={`${s.boostTime.toFixed(1)}s`} />
          {s.dashes > 0 && <Stat label="DASHES" value={String(s.dashes)} />}
          {s.pumps > 0 && <Stat label="PUMPS" value={String(s.pumps)} />}
          {s.resonantPasses > 0 && <Stat label="RESONANT" value={String(s.resonantPasses)} />}
          {s.glassSmashed > 0 && <Stat label="GLASS" value={String(s.glassSmashed)} />}
          {s.bounces > 0 && <Stat label="BOUNCES" value={String(s.bounces)} />}
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center">
          <div className="text-[10px] tracking-[0.24em] text-white/40">RUN READOUT</div>
          <div className="mt-1 text-sm text-white/75">
            {outcome.finished
              ? "FULL TRANSMISSION · CROSSED THE HORIZON INTACT"
              : s.deathCause
                ? `${formatPattern(s.deathCause.patternId)} · ${s.deathCause.obstacleKind.toUpperCase()} IMPACT`
                : "SIGNAL TERMINATED"}
          </div>
          {coaching && (
            <div className="mt-2 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-3 py-2">
              <div className="text-[9px] tracking-[0.24em] text-cyan-200/55">
                NEXT ATTEMPT
              </div>
              <div className="mt-0.5 text-xs font-semibold text-cyan-100/85">
                {coaching}
              </div>
            </div>
          )}
          {s.heat.length > 0 && (
            <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-orange-300/90">
              HEAT ×{heatScoreMult(s.heat).toFixed(2)} ·{" "}
              {s.heat.map((id) => HEAT_BY_ID[id].name.toUpperCase()).join(" · ")}
            </div>
          )}
          {labRun && (
            <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-violet-300/90">
              LAB · {s.lab.map((id) => LAB_BY_ID[id].name.toUpperCase()).join(" · ")} — UNRANKED,
              NOTHING SAVED
            </div>
          )}
          {outcome.rival && (
            <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-sky-300/90">
              IMPORTED RIVAL FLIGHT — UNRANKED, NOTHING SAVED
            </div>
          )}
          {outcome.deathStreak >= 2 && s.deathCause && (
            <div className="mt-1 text-[11px] font-semibold tracking-[0.14em] text-rose-300/90">
              {ordinal(outcome.deathStreak).toUpperCase()} RUN IN A ROW ENDED BY{" "}
              {formatPattern(s.deathCause.patternId).toUpperCase()}
            </div>
          )}
          {s.lineRating && (
            <div className="mt-2 flex items-center justify-center gap-2 text-xs text-white/70">
              <span className="tracking-[0.18em] text-white/45">LINE RATING</span>
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-md border font-display text-sm font-black ${
                  GRADE_COLORS[s.lineRating]
                }`}
              >
                {s.lineRating}
              </span>
              {weakest && weakest.grade !== "S" && (
                <span className="text-[11px] text-white/55">
                  weakest: {formatPattern(weakest.patternId)} ({weakest.grade})
                </span>
              )}
            </div>
          )}
          {mode !== "trial" && !unranked && (
            <div className={`mt-1 text-xs font-semibold ${outcome.scoreDelta > 0 ? "text-amber-200" : "text-white/50"}`}>
              {outcome.scoreDelta > 0
                ? `${scoreDeltaLabel} +${outcome.scoreDelta.toLocaleString()}`
                : outcome.scoreDelta === 0
                  ? `MATCHED ${scoreDeltaLabel === "PB" ? "PERSONAL BEST" : scoreDeltaLabel}`
                : `${Math.abs(outcome.scoreDelta).toLocaleString()} short of ${scoreDeltaLabel}`}
            </div>
          )}
          {unranked ? null : mode === "trial" ? (
            outcome.newTrialBest ? (
              <div className="mt-0.5 text-xs font-semibold text-amber-200">
                DEEPEST RUN ON THIS TRIAL
              </div>
            ) : outcome.distanceDelta > 0 ? (
              <div className="mt-0.5 text-xs text-white/50">
                {Math.ceil(outcome.distanceDelta).toLocaleString()} m short of your trial best
              </div>
            ) : null
          ) : outcome.newBestDistance ? (
            <div className="mt-0.5 text-xs font-semibold text-amber-200">
              FARTHEST FLIGHT YET
            </div>
          ) : outcome.distanceDelta > 0 ? (
            <div className="mt-0.5 text-xs text-white/50">
              {Math.ceil(outcome.distanceDelta).toLocaleString()} m short of your farthest flight
            </div>
          ) : null}
          {outcome.ratingDelta !== null && <RatingLine delta={outcome.ratingDelta} />}
        </div>

        <TechniqueDebrief stats={s} />

        {mode === "daily" && (
          <div className="mt-4 flex justify-center">
            <DailyQuestCard />
          </div>
        )}

        {outcome.forensics && <DeathForensicsPanel forensics={outcome.forensics} />}

        {outcome.unlocked.length > 0 && (
          <div className="mt-5 rounded-xl border border-cyan-300/25 bg-cyan-300/10 px-4 py-3">
            {outcome.unlocked.map((u) => (
              <div key={u.id} className="font-display text-sm font-bold tracking-[0.15em] text-cyan-200">
                UNLOCKED · {u.name} {u.kind === "craft" ? "CRAFT" : "TRAIL"}
              </div>
            ))}
          </div>
        )}

        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <button autoFocus className={btnPrimary} onClick={() => bundle.restart()}>
            RETRY
          </button>
          {drillTrial && (
            <button
              className={btnGhost}
              onClick={() => bundle.startRun("trial", drillTrial.id)}
              title={`Practice ${drillTrial.name} as a trial`}
            >
              DRILL · {drillTrial.name.toUpperCase()}
            </button>
          )}
          {lastRun && !unranked && (
            <button className={btnGhost} onClick={exportRun}>
              EXPORT .FLIGHT
            </button>
          )}
          <button className={btnGhost} onClick={() => bundle.backToTitle()}>
            MENU
          </button>
        </div>
        <div className="mt-3 text-center text-xs text-white/40">R / ENTER for instant restart</div>
      </motion.div>
    </Screen>
  );
}

/** One actionable diagnosis distilled from the richer kill-cam data. */
export function deathCoach(outcome: RunOutcome): string | null {
  const cause = outcome.stats.deathCause;
  if (outcome.finished || !cause) return null;
  const { stats, forensics } = outcome;
  if (forensics) {
    const points = forensics.path.flat();
    let nearest: [number, number] | null = null;
    let nearestDs = Infinity;
    for (const point of points) {
      const ds = Math.abs(point[0] - forensics.deathS);
      if (ds < nearestDs) {
        nearestDs = ds;
        nearest = point;
      }
    }
    if (nearest) {
      const offset = forensics.deathX - nearest[1];
      if (Math.abs(offset) >= 2) {
        const side = offset > 0 ? "RIGHT" : "LEFT";
        const correction = offset > 0 ? "LEFT" : "RIGHT";
        return `ENTERED ${Math.abs(offset).toFixed(1)} m TOO FAR ${side} · COMMIT ${correction} EARLIER`;
      }
    }
  }
  if (cause.motion !== 0) {
    return "MOVING HAZARDS REPEAT ON THE BEAT · WATCH ONE CYCLE, THEN COMMIT";
  }
  if (stats.distance < 500) {
    return "STEER BEFORE THE GAP · LATERAL MOMENTUM TAKES TIME TO BUILD";
  }
  if (stats.nearMisses === 0) {
    return "USE THE SAFE LINE FIRST · MOVE CLOSER ONLY AFTER THE ROUTE IS STABLE";
  }
  return "COMPARE YOUR LINE WITH THE DASHED SAFE ROUTE · CORRECT THE ENTRY, NOT THE IMPACT";
}

interface TechniqueMetric {
  label: string;
  value: string;
  score: number;
  advice: string;
  focusEligible?: boolean;
}

/** Deterministic, actionable technique summary built only from run telemetry. */
export function techniqueReport(stats: RunStats): {
  metrics: TechniqueMetric[];
  focus: string;
} {
  const precision =
    stats.nearMisses > 0
      ? (stats.perfectPasses + stats.razorPasses * 0.65 + stats.closePasses * 0.3) /
        stats.nearMisses
      : 0;
  const rhythm =
    stats.perfectPasses > 0 ? stats.resonantPasses / stats.perfectPasses : 0;
  const thrust = stats.duration > 0 ? stats.boostChargeTime / stats.duration : 0;
  const flow = Math.min(1, stats.maxFlowPoints / 40);
  const metrics: TechniqueMetric[] = [
    {
      label: "PRECISION",
      value: stats.nearMisses > 0 ? `${Math.round(precision * 100)}%` : "—",
      score: precision,
      advice: "Approach the safe line first, then trim clearance one pass at a time.",
    },
    {
      label: "RESONANCE",
      value: stats.perfectPasses > 0
        ? `${stats.resonantPasses}/${stats.perfectPasses}`
        : "—",
      score: rhythm,
      advice: "Use the mover pulse and soundtrack to arrive on the shared beat.",
    },
    {
      label: "THRUST",
      value: `${Math.round(thrust * 100)}%`,
      score: Math.min(1, thrust / 0.65),
      advice: "Convert graze energy into boost, then release before high-curvature entries.",
    },
    {
      label: "FLOW",
      value: `×${(1 + stats.maxFlowPoints * FLOW.MULT_PER_POINT).toFixed(1)}`,
      score: flow,
      advice: "Link close passes before the grace window expires.",
    },
  ];
  if (stats.pumps > 0) {
    const quality = stats.pumpQualitySum / stats.pumps;
    metrics.push({
      label: "CARVE",
      value: `${Math.round(quality * 100)}%`,
      score: quality,
      advice: "Reverse nearer peak lateral velocity; early flips return less momentum.",
    });
  }
  if (stats.jumps > 0) {
    // Flight quality: landings resolved (perfect > clean > hard), sweetened
    // by airborne grazes — dead airtime is the thing to coach away.
    const landings = Math.max(1, stats.perfectLandings + stats.hardLandings +
      (stats.jumps - stats.perfectLandings - stats.hardLandings));
    const flight = Math.min(
      1,
      (stats.perfectLandings + (landings - stats.perfectLandings - stats.hardLandings) * 0.45) /
        landings +
        Math.min(0.25, stats.airGrazes * 0.05),
    );
    metrics.push({
      label: "FLIGHT",
      value: `${stats.perfectLandings}/${stats.jumps}${stats.airGrazes > 0 ? ` · A${stats.airGrazes}` : ""}`,
      score: flight,
      advice: "Dive with boost to place the reticle, then flick opposite just before touchdown.",
    });
  }
  if (stats.routeChoices.length > 0) {
    const counts = { energy: 0, flow: 0, tempo: 0 };
    for (const choice of stats.routeChoices) counts[choice.reward]++;
    metrics.push({
      label: "ROUTES",
      value: `E${counts.energy} F${counts.flow} T${counts.tempo}`,
      score: 1,
      advice: "Route mix is descriptive; the correct branch depends on current state.",
      focusEligible: false,
    });
  }
  const candidates = metrics.filter(
    (metric) => metric.value !== "—" && metric.focusEligible !== false,
  );
  const focus = (candidates.length > 0
    ? candidates.reduce((lowest, metric) => (metric.score < lowest.score ? metric : lowest))
    : metrics[0]
  ).advice;
  return { metrics, focus };
}

function TechniqueDebrief({ stats }: { stats: RunStats }) {
  const report = techniqueReport(stats);
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-[0.24em] text-white/40">
          TECHNIQUE
        </span>
        <span className="text-[9px] tracking-[0.16em] text-cyan-200/55">
          NEXT FOCUS
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
        {report.metrics.map((metric) => (
          <div key={metric.label}>
            <div className="flex items-baseline justify-between text-[9px] tracking-[0.14em] text-white/45">
              <span>{metric.label}</span>
              <span className="font-semibold tabular-nums text-white/75">{metric.value}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-300/75 to-fuchsia-300/75"
                style={{ width: `${Math.max(2, Math.min(100, metric.score * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 text-[11px] leading-relaxed text-cyan-100/70">
        {report.focus}
      </div>
    </div>
  );
}

/** Post-run pilot-rating movement (roadmap 4.4). */
function RatingLine({ delta }: { delta: number }) {
  const rating = useMeta((s) => s.rating);
  const tier = ratingTier(rating);
  return (
    <div className="mt-1.5 text-xs tabular-nums text-white/60">
      <span className="tracking-[0.14em] text-white/40">PILOT RATING </span>
      <span className="font-semibold text-cyan-200/90">
        {rating.toLocaleString()} · {tier.name}
      </span>
      <span
        className={`ml-1.5 font-semibold ${
          delta > 0 ? "text-emerald-300/90" : delta < 0 ? "text-rose-300/80" : "text-white/40"
        }`}
      >
        {delta > 0 ? `+${delta}` : delta}
      </span>
    </div>
  );
}

const MEDAL_STYLES: Record<Medal, { chip: string; label: string }> = {
  bronze: { chip: "border-orange-300/50 bg-orange-400/15 text-orange-200", label: "BRONZE" },
  silver: { chip: "border-slate-200/50 bg-slate-200/15 text-slate-100", label: "SILVER" },
  gold: { chip: "border-amber-300/60 bg-amber-300/20 text-amber-200", label: "GOLD" },
  author: { chip: "border-fuchsia-300/60 bg-fuchsia-400/20 text-fuchsia-200", label: "AUTHOR" },
};

/** Medal ladder for one trial: earned rungs lit, the next target called out. */
function MedalLadder({
  trial,
  distance,
  compact = false,
}: {
  trial: TrialDef;
  distance: number;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-wrap items-center ${compact ? "gap-1" : "justify-center gap-1.5"}`}>
      {MEDAL_ORDER.map((medal) => {
        const earned = distance >= trial.medals[medal];
        const style = MEDAL_STYLES[medal];
        return (
          <span
            key={medal}
            title={`${style.label} at ${trial.medals[medal].toLocaleString()} m`}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.12em] ${
              earned ? style.chip : "border-white/10 bg-white/[0.03] text-white/30"
            }`}
          >
            {style.label}
            <span className="font-normal tabular-nums opacity-70">
              {compact
                ? `${(trial.medals[medal] / 1000).toFixed(1)}k`
                : `${trial.medals[medal].toLocaleString()} m`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** A run as a percentage of the trial's deepest automated reference distance. */
export function referencePct(trial: TrialDef, distance: number): number {
  return (distance / trial.reference) * 100;
}

/** Trial result: medal ladder plus progress toward the deepest automated run. */
function TrialResult({
  trial,
  distance,
  medal,
}: {
  trial: TrialDef;
  distance: number;
  medal: Medal | null;
}) {
  const next = nextMedalFor(trial, distance);
  const pct = referencePct(trial, distance);
  return (
    <div className="mt-5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-center">
      {medal ? (
        <div
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-display text-base font-black tracking-[0.2em] ${MEDAL_STYLES[medal].chip}`}
        >
          {MEDAL_STYLES[medal].label} MEDAL
        </div>
      ) : (
        <div className="font-display text-sm font-bold tracking-[0.2em] text-white/55">
          NO MEDAL — BRONZE AT {trial.medals.bronze.toLocaleString()} m
        </div>
      )}
      {next && (
        <div className="mt-1.5 text-xs text-white/55 tabular-nums">
          {MEDAL_STYLES[next.medal].label} was {Math.ceil(next.at - distance).toLocaleString()} m
          further
        </div>
      )}
      <div className="mt-2.5">
        <MedalLadder trial={trial} distance={distance} />
      </div>
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between text-[10px] tracking-[0.24em] text-white/45">
          <span>REFERENCE DISTANCE</span>
          <span className="tabular-nums text-white/70">{pct.toFixed(1)}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-300/70 to-fuchsia-300/70"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <div className="mt-1 text-[10px] text-white/40">
          the deepest automated run reaches {trial.reference.toLocaleString()} m
        </div>
      </div>
    </div>
  );
}

/** Today's three skill quests, shared by every pilot (roadmap 4.5). */
function DailyQuestCard() {
  const questDay = useMeta((s) => s.questDay);
  const questDone = useMeta((s) => s.questDone);
  const today = dailyKey();
  const quests = useMemo(() => questsForDay(today), [today]);
  const done = questDay === today ? questDone : [];
  const doneCount = done.filter(Boolean).length;

  return (
    <div className="w-[min(88vw,26rem)] rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-left">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] tracking-[0.3em] text-white/45">DAILY QUESTS</span>
        <span className="text-[10px] tabular-nums text-white/45">
          {doneCount}/{quests.length}
        </span>
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {quests.map((q, i) => (
          <div key={q.id} className="flex items-center gap-2 text-[11px] leading-tight">
            <span
              className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                done[i]
                  ? "border-emerald-300/70 bg-emerald-300/20 text-emerald-200"
                  : "border-white/20 text-transparent"
              }`}
              aria-hidden="true"
            >
              ✓
            </span>
            <span className={done[i] ? "text-white/40 line-through" : "text-white/70"}>
              {q.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pre-run heat configuration: opt-in burdens, multiplied payout (4.3). */
function HeatOverlay() {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  const selectedHeat = useMeta((s) => s.selectedHeat);
  const selectHeat = useMeta((s) => s.selectHeat);
  const mult = heatScoreMult(selectedHeat);

  return (
    <OverlayShell title="HEAT">
      <div className="mb-4 text-xs leading-relaxed text-white/55">
        Burdens for the endless track — each one makes the run genuinely harder and multiplies
        every point you score. Stack them if you dare. Daily, sprint, and trials always run pure.
      </div>
      <div className="flex flex-col gap-2">
        {HEATS.map((h) => {
          const on = selectedHeat.includes(h.id);
          return (
            <button
              key={h.id}
              role="switch"
              aria-checked={on}
              onClick={() =>
                selectHeat(
                  on ? selectedHeat.filter((id) => id !== h.id) : [...selectedHeat, h.id],
                )
              }
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all ${
                on
                  ? "border-orange-300/60 bg-orange-400/10 shadow-[0_0_16px_rgba(251,146,60,0.2)]"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
            >
              <div>
                <div className={`font-display text-sm font-bold tracking-wider ${on ? "text-orange-200" : "text-white"}`}>
                  {h.name}
                </div>
                <div className="mt-0.5 text-[11px] text-white/55">{h.desc}</div>
              </div>
              <div
                className={`shrink-0 rounded-md px-2 py-1 font-display text-xs font-bold tabular-nums ${
                  on ? "bg-orange-300/25 text-orange-100" : "bg-white/10 text-white/50"
                }`}
              >
                ×{h.mult.toFixed(2)}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-sm text-white/70">
          TOTAL{" "}
          <span className={`font-display font-bold tabular-nums ${mult > 1 ? "text-orange-200" : "text-white/50"}`}>
            ×{mult.toFixed(2)}
          </span>
        </div>
        <button
          className={btnPrimary}
          onClick={() => {
            setOverlay("none");
            bundle.startRun("endless");
          }}
        >
          {mult > 1 ? "IGNITE" : "LAUNCH CLEAN"}
        </button>
      </div>
    </OverlayShell>
  );
}

/** Lab prototypes (roadmap Phase 5): flag-gated experiments, default off. */
function LabOverlay() {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  const selectedLab = useMeta((s) => s.selectedLab);
  const selectLab = useMeta((s) => s.selectLab);

  return (
    <OverlayShell title="LAB">
      <div className="mb-4 text-xs leading-relaxed text-white/55">
        Experimental flight systems, still on the bench. Lab runs are unranked sandboxes —
        no personal bests, no rating, no ghosts; nothing persists. Endless track only.
      </div>
      <div className="flex flex-col gap-2">
        {LABS.map((l) => {
          const on = selectedLab.includes(l.id);
          return (
            <button
              key={l.id}
              role="switch"
              aria-checked={on}
              onClick={() =>
                selectLab(on ? selectedLab.filter((id) => id !== l.id) : [...selectedLab, l.id])
              }
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all ${
                on
                  ? "border-violet-300/60 bg-violet-400/10 shadow-[0_0_16px_rgba(167,139,250,0.2)]"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
            >
              <div>
                <div className={`font-display text-sm font-bold tracking-wider ${on ? "text-violet-200" : "text-white"}`}>
                  {l.name}
                </div>
                <div className="mt-0.5 text-[11px] text-white/55">{l.desc}</div>
              </div>
              <div
                className={`shrink-0 rounded-md px-2 py-1 font-display text-[10px] font-bold tracking-[0.12em] ${
                  on ? "bg-violet-300/25 text-violet-100" : "bg-white/10 text-white/50"
                }`}
              >
                {on ? "ARMED" : "OFF"}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-sm text-white/70">
          {selectedLab.length > 0 ? (
            <span className="font-display font-bold tracking-[0.12em] text-violet-200">
              UNRANKED RUN
            </span>
          ) : (
            <span className="text-white/50">ALL SYSTEMS STOCK</span>
          )}
        </div>
        <button
          className={btnPrimary}
          onClick={() => {
            setOverlay("none");
            bundle.startRun("endless");
          }}
        >
          {selectedLab.length > 0 ? "ENGAGE" : "LAUNCH CLEAN"}
        </button>
      </div>
    </OverlayShell>
  );
}

/** Trial roster overlay: the practice room's front door (roadmap 4.1). */
function TrialsOverlay() {
  const bundle = useGameBundle();
  const setOverlay = useGame((s) => s.setOverlay);
  const trialBest = useMeta((s) => s.trialBest);

  return (
    <OverlayShell title="TRIALS">
      <div className="mb-4 text-xs leading-relaxed text-white/55">
        One pattern, looped, at ever-escalating speed — fly until it breaks you. Fixed course per
        trial: your best run returns as a ghost. Bronze is a warm-up; Author is a statement.
      </div>
      <div className="flex flex-col gap-2.5">
        {TRIALS.map((trial) => {
          const best = trialBest[trial.id];
          const bestMedal = best ? (medalFor(trial, best.distance) ?? best.medal) : null;
          return (
            <div
              key={trial.id}
              className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-bold tracking-wider text-white">
                    {trial.name}
                  </span>
                  {bestMedal && (
                    <span
                      className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.12em] ${MEDAL_STYLES[bestMedal].chip}`}
                    >
                      {MEDAL_STYLES[bestMedal].label}
                    </span>
                  )}
                  <span className="text-[9px] tracking-[0.2em] text-white/35">
                    {trial.skills.join(" · ").toUpperCase()}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-white/55">{trial.desc}</div>
                <div className="mt-1.5">
                  <MedalLadder trial={trial} distance={best?.distance ?? 0} compact />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
                <div className="text-[10px] tabular-nums text-white/45">
                  {best ? `PB ${best.distance.toLocaleString()} m` : "NOT FLOWN"}
                </div>
                {best && (
                  <div
                    className="text-[10px] tabular-nums text-cyan-200/70"
                    title={`Deepest automated reference distance: ${trial.reference.toLocaleString()} m`}
                  >
                    {referencePct(trial, best.distance).toFixed(1)}% OF REF
                  </div>
                )}
                <button
                  className={`${btnGhost} !px-4 !py-1.5 !text-xs`}
                  onClick={() => {
                    setOverlay("none");
                    bundle.startRun("trial", trial.id);
                  }}
                >
                  FLY
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </OverlayShell>
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

function formatPattern(id: string): string {
  return id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function OverlayShell({ title, children }: { title: string; children: React.ReactNode }) {
  const setOverlay = useGame((s) => s.setOverlay);
  const titleId = `overlay-${title.toLowerCase().replaceAll(" ", "-")}`;
  const returnFocus = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    const target = returnFocus.current;
    return () => target?.focus();
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-[#05030c]/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={trapFocus}
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
          <div id={titleId} className="font-display text-xl font-black tracking-[0.3em] text-white">{title}</div>
          <button
            autoFocus
            className="rounded-lg border border-white/15 px-3 py-1 text-sm text-white/70 hover:bg-white/10"
            onClick={() => setOverlay("none")}
            aria-label={`Close ${title}`}
          >
            <span aria-hidden="true">✕</span>
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
          const progress = c.unlock.progress?.(snap);
          return (
            <button
              key={c.id}
              disabled={!unlocked}
              aria-pressed={selected}
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
              {!unlocked && progress && (
                <UnlockProgress value={progress.value} target={progress.target} />
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-2 mt-6 text-xs tracking-[0.25em] text-white/50">TRAIL</div>
      <div className="grid grid-cols-3 gap-2.5 md:grid-cols-6">
        {TRAILS.map((t) => {
          const unlocked = t.unlock.check(snap);
          const selected = meta.selectedTrail === t.id;
          const progress = t.unlock.progress?.(snap);
          return (
            <button
              key={t.id}
              disabled={!unlocked}
              aria-pressed={selected}
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
              {!unlocked && progress && (
                <span className="text-[9px] tabular-nums text-white/45">
                  {Math.floor(progress.value).toLocaleString()}/{progress.target.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 text-center md:grid-cols-4">
        <Stat label="RUNS" value={String(meta.totalRuns)} />
        <Stat label="LIFETIME KM" value={(meta.totalDistance / 1000).toFixed(1)} />
        <Stat label="SHARDS" value={String(meta.totalShards)} />
        <Stat label="NEAR MISSES" value={String(meta.totalNearMisses)} />
        <Stat label="PERFECT" value={String(meta.totalPerfectPasses)} />
        <Stat label="BEST CHAIN" value={String(meta.bestFlowChain)} />
        <Stat label="SHARD COMBO" value={String(meta.bestShardCombo)} />
        <Stat
          label="PEAK RATING"
          value={meta.peakRating > 0 ? meta.peakRating.toLocaleString() : "—"}
        />
        <Stat label="GOLD TRIALS" value={String(snap.goldTrials)} />
        <Stat label="SPRINTS DONE" value={String(meta.sprintsFinished)} />
        <Stat label="QUESTS DONE" value={String(meta.questsCompleted)} />
        <Stat
          label="HEAT CLEARED"
          value={meta.bestHeatCleared > 1 ? `×${meta.bestHeatCleared.toFixed(2)}` : "—"}
        />
      </div>
    </OverlayShell>
  );
}

function UnlockProgress({ value, target }: { value: number; target: number }) {
  const pct = Math.min(100, (value / Math.max(1, target)) * 100);
  return (
    <div className="mt-2">
      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-cyan-300/70" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[9px] tabular-nums text-white/35">
        {Math.floor(value).toLocaleString()} / {target.toLocaleString()}
      </div>
    </div>
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
                aria-pressed={s.quality === q}
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
          <Slider label="Music volume" value={s.musicVolume} onChange={s.setMusicVolume} />
        </Row>
        <Row label="SFX">
          <Slider label="Sound effects volume" value={s.sfxVolume} onChange={s.setSfxVolume} />
        </Row>
        <Row label="STEERING SENSITIVITY">
          <Slider
            label="Steering sensitivity"
            value={s.sensitivity}
            min={0.5}
            max={1.5}
            onChange={s.setSensitivity}
          />
        </Row>
        <Row label="PB GHOST" hint="Race a hologram of your best run">
          <Toggle label="PB ghost" value={s.showGhost} onChange={s.setShowGhost} />
        </Row>
        <Row label="GAMEPAD RUMBLE" hint="Graze ticks, boost floor, and impact haptics">
          <Toggle label="Gamepad rumble" value={s.haptics} onChange={s.setHaptics} />
        </Row>
        <Row label="REDUCE MOTION" hint="Softer camera shake and FOV kicks">
          <Toggle label="Reduce motion" value={s.reduceMotion} onChange={s.setReduceMotion} />
        </Row>
        <Row label="REDUCE FLASHES" hint="Caps lightning and flash effects">
          <Toggle label="Reduce flashes" value={s.reduceFlash} onChange={s.setReduceFlash} />
        </Row>
        <Row label="HIGH CONTRAST" hint="Brighter obstacle edges and calmer distortion">
          <Toggle label="High contrast" value={s.highContrast} onChange={s.setHighContrast} />
        </Row>
        <Row label="SHOW FPS">
          <Toggle label="Show FPS" value={s.showFps} onChange={s.setShowFps} />
        </Row>
      </div>
    </OverlayShell>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div>
        <div className="text-sm font-semibold tracking-wider text-white/85">{label}</div>
        {hint && <div className="text-[11px] text-white/40">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Slider({
  label, value, onChange, min = 0, max = 1,
}: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={0.05}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-cyan-300 sm:w-40"
    />
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      aria-label={label}
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
          Your craft accelerates on its own. You only steer, and steering is two buttons —{" "}
          <Key>←</Key> <Key>→</Key> or <Key>A</Key> <Key>D</Key>, hold the left or right half of
          the screen on touch, or a gamepad d-pad / stick. Momentum is real: commit to lines
          early.
        </div>
        <div>
          <span className="font-bold text-cyan-200">Near misses build FLOW.</span> Graze obstacles
          to raise your multiplier — Close, Razor, and Perfect passes pay increasingly more.
          Chain precise passes before Flow decays to reach the highest scores; every chain climbs
          the melody. Pass tightly between obstacles on both sides to{" "}
          <span className="font-bold text-emerald-200">THREAD</span> the gap.
        </div>
        <div>
          <span className="font-bold text-fuchsia-300">The world moves on the beat.</span> Every
          crusher, pendulum, and beam is phase-locked to the soundtrack&apos;s tempo — you can
          time gaps by ear. A Perfect pass landed exactly on the beat rings{" "}
          <span className="font-bold text-fuchsia-300">RESONANT</span> and pays ×1.25.
        </div>
        <div>
          <span className="font-bold text-cyan-200">Shards are fuel.</span> Collect them quickly to
          build a combo, then hold <Key>SHIFT</Key> or <Key>SPACE</Key> to spend that energy on a
          boost. On touch, a second finger boosts — hold both halves of the screen to boost
          straight ahead, or two fingers on one half to boost through a turn. Larger risk-route
          shards do not magnetize, but pay 60% extra. Boosting is fast, but steering authority
          drops — respect it.
        </div>
        <div>
          <span className="font-bold text-amber-200">Shields</span> are rare. One hit is forgiven;
          the second is not, and a shield break costs Flow.
        </div>
        <div>
          <span className="font-bold text-cyan-200">The track winds.</span> The corridor drifts and
          breathes — read the bends early. Not everything lethal is solid, either:{" "}
          <span className="font-bold text-cyan-200">glass panes</span> shatter if you hit them
          boosting (loot lanes hide behind them),{" "}
          <span className="font-bold text-amber-200">bumpers</span> fling you sideways instead of
          killing you, and <span className="font-bold text-rose-300">pulse beams</span> breathe on
          a rhythm — dive through while they charge. When the sky calls a{" "}
          <span className="font-bold text-rose-300">METEOR BARRAGE</span>, watch the glowing ground
          markers; when it calls a <span className="font-bold text-amber-200">GOLDEN RUSH</span>,
          ride the shard river.
        </div>
        <div>
          <Key>R</Key> restarts instantly. <Key>ESC</Key> pauses. The{" "}
          <span className="font-bold text-fuchsia-300">Daily Course</span> is the same seed for
          everyone — one course, one leaderboard-worthy score.
        </div>
        <div>
          <span className="font-bold text-emerald-200">Sprint</span> is a fixed {SPRINT_MODE.DURATION}s
          score attack on a weekly course — survive the clock and bank everything.{" "}
          <span className="font-bold text-amber-200">Trials</span> loop a single pattern at
          ever-rising speed: chase Bronze, Silver, Gold, and Author medals, compare against the
          deepest automated reference distance, and race your own ghost line.
        </div>
        <div>
          <span className="font-bold text-orange-300">Heat</span> stacks opt-in burdens on the
          endless track — scarcer shields, denser fields, narrower gaps — and multiplies every
          point you score. Your <span className="font-bold text-cyan-200">Pilot Rating</span>{" "}
          climbs on fixed-seed trials normalized against their automated references, and
          three fresh <span className="font-bold text-lime-200">daily quests</span> reward
          skill, never grind.
        </div>
        <div>
          The <span className="font-bold text-violet-300">Lab</span> hosts experimental flight
          systems still on the bench, including Carve&apos;s timed reversals, glides, and
          wall-kisses. Lab runs are unranked and save nothing — fly them for the feel, not the
          ladder. Export a <span className="font-bold text-sky-200">.flight</span> after a run
          to share it; imported flights launch an unranked ghost race on the exact course.
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
