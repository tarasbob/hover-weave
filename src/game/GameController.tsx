"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { SimWorld } from "./core/world";
import { CARVE, RAMP } from "./core/constants";
import { GhostDriver } from "./core/ghost";
import { GamepadHaptics } from "./core/haptics";
import { InputManager } from "./core/input";
import { lockLandscape } from "./core/orientation";
import { EnvState } from "./render/env";
import { AudioEngine } from "./audio/engine";
import type { RunConfig } from "./core/modes";
import { questsForDay, type QuestCounters, type QuestDef } from "./core/quests";
import {
  ghostEligible,
  recordingConfig,
  type RunRecording,
} from "./core/replay";
import { dailyKey, dailySeed, randomSeed, weeklyKey, weeklySeed } from "./core/rng";
import { trialSeed } from "./track/trials";
import { useGame, type GameMode } from "./state/game";
import { CRAFTS, TRAILS, metaSnapshot, useMeta } from "./state/meta";
import { useReplays } from "./state/replays";
import { useSettings } from "./state/settings";

export interface GameBundle {
  world: SimWorld;
  ghost: GhostDriver;
  input: InputManager;
  env: EnvState;
  audio: AudioEngine;
  haptics: GamepadHaptics;
  /** Imported rival currently being raced; mutable run-session state. */
  rival: { recording: RunRecording | null };
  /** Ambient scroll distance used on the title screen. */
  ambient: { value: number };
  startRun(mode: GameMode, trialId?: string): void;
  /** Launch the exact course carried by an imported flight and race its ghost. */
  raceRecording(recording: RunRecording): void;
  /** Re-run the last config (defaults to endless before any run). */
  restart(): void;
  togglePause(): void;
  backToTitle(): void;
}

const GameContext = createContext<GameBundle | null>(null);

export function useGameBundle(): GameBundle {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGameBundle outside provider");
  return ctx;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const bundle = useMemo<GameBundle>(() => {
    const world = new SimWorld();
    const ghost = new GhostDriver();
    const input = new InputManager();
    const env = new EnvState();
    const audio = new AudioEngine();
    const haptics = new GamepadHaptics();
    const ambient = { value: 0 };
    const rival: { recording: RunRecording | null } = { recording: null };

    // The active run's identity, captured at launch: restart replays the
    // exact config; the period key keeps a run that crosses UTC midnight (or
    // an ISO week boundary) attached to the seed it was launched with.
    const active: { config: RunConfig; periodKey: string | null } = {
      config: { mode: "endless", seed: "" },
      periodKey: null,
    };

    const startRun = (mode: GameMode, trialId?: string) => {
      // Called from a tap/click, so the fullscreen + orientation-lock
      // gesture requirement is satisfied here (Android; no-op elsewhere).
      lockLandscape();
      const config: RunConfig =
        mode === "daily"
          ? { mode, seed: dailySeed() }
          : mode === "sprint"
            ? { mode, seed: weeklySeed() }
            : mode === "trial"
              ? { mode, seed: trialSeed(trialId ?? ""), trialId }
              : { mode, seed: randomSeed() };
      // Heat and lab prototypes ride only on endless launches (roadmap 4.3 /
      // Phase 5), from the pre-run selections. The sim canonicalizes both.
      const meta = useMeta.getState();
      const firstFlight = mode === "endless" && !meta.onboardingComplete;
      if (mode === "endless" && !firstFlight) {
        const heat = meta.selectedHeat;
        if (heat.length > 0) config.heat = [...heat];
        const lab = meta.selectedLab;
        if (lab.length > 0) config.lab = [...lab];
      }
      // Dev probe: `?start=25000` spawns deep into an endless run (overdrive
      // speeds/density) for pop-in and pacing checks. Never in production.
      if (
        mode === "endless" &&
        process.env.NODE_ENV === "development" &&
        typeof location !== "undefined"
      ) {
        const skipTo = Math.max(0, Number(new URLSearchParams(location.search).get("start")) || 0);
        if (skipTo > 0) config.skipTo = skipTo;
      }
      active.config = config;
      active.periodKey = mode === "daily" ? dailyKey() : mode === "sprint" ? weeklyKey() : null;
      rival.recording = null;

      useGame.getState().setMode(mode, config.trialId ?? null);
      useGame.getState().setOutcome(null);
      useGame.getState().clearRunFeedback();
      useGame.getState().setLesson(firstFlight ? "steer" : null);
      world.start(config);
      // Race your PB ghost: daily/sprint/trial share the seed (true spatial
      // ghosts), endless re-flies its own recorded track (pace ghost).
      // Skipped runs and lab prototypes race nothing (lab physics differ —
      // pacing a plain-run ghost against them would be a lie).
      ghost.arm(
        useSettings.getState().showGhost && !config.skipTo && !config.lab
          ? useReplays.getState().ghostFor(mode, active.periodKey, config.trialId ?? null)
          : null,
      );
      useGame.getState().setPhase("running");
      audio.startMusic();
    };

    const raceRecording = (recording: RunRecording) => {
      if (!ghostEligible(recording)) {
        throw new Error("Imported flight is not eligible for a rival race");
      }
      lockLandscape();
      const config = recordingConfig(recording);
      active.config = config;
      active.periodKey = null;
      rival.recording = recording;
      useGame.getState().setMode(config.mode, config.trialId ?? null);
      useGame.getState().setOutcome(null);
      useGame.getState().clearRunFeedback();
      world.start(config);
      ghost.arm(recording);
      useGame.getState().setPhase("running");
      audio.startMusic();
    };

    const restart = () => {
      const { config } = active;
      if (rival.recording) raceRecording(rival.recording);
      else if (!config.seed) startRun("endless");
      else startRun(config.mode, config.trialId);
    };

    const togglePause = () => {
      const g = useGame.getState();
      if (g.phase === "running") {
        g.setPhase("paused");
        audio.pauseMusic();
      } else if (g.phase === "paused") {
        g.setPhase("running");
        audio.startMusic();
      }
    };

    const backToTitle = () => {
      world.status = "idle";
      world.clearField();
      ghost.arm(null);
      useGame.getState().setPhase("title");
      useGame.getState().setOutcome(null);
      useGame.getState().setLesson(null);
      audio.pauseMusic();
    };

    return {
      world,
      ghost,
      input,
      env,
      audio,
      haptics,
      ambient,
      rival,
      startRun,
      raceRecording,
      restart,
      togglePause,
      backToTitle,
    };
  }, []);

  // Dev-only console handle (assigned post-commit so Strict Mode's discarded
  // bundle never leaks here). `__carve` / `__ramp` are the physics
  // feel-tuning harnesses: mutate values live, restart the run, re-feel.
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __game: unknown }).__game = bundle;
      (window as unknown as { __stores: unknown }).__stores = {
        useGame,
        useSettings,
        useMeta,
        useReplays,
      };
      (window as unknown as { __carve: unknown }).__carve = CARVE;
      (window as unknown as { __ramp: unknown }).__ramp = RAMP;
    }
  }, [bundle]);

  // Wire world events -> stores + audio (render/FX layers subscribe separately).
  useEffect(() => {
    const { world, audio, env, haptics } = bundle;

    // One-shot skyhook teaching callout: the first lip of the session
    // explains the whole verb set in a breath (fun-frontier 6.1).
    const skyhookSeen = { current: false };

    // Daily quest tracking (roadmap 4.5). Counters cover the event-only
    // signals; everything else reads live run stats. Completion banks the
    // moment it happens — dying two seconds later cannot take it back.
    const quest: {
      day: string | null;
      defs: QuestDef[];
      counters: QuestCounters;
    } = { day: null, defs: [], counters: { riskShards: 0, fastPerfects: 0 } };

    const evaluateQuests = (silent = false) => {
      if (!quest.day || quest.defs.length === 0) return;
      const meta = useMeta.getState();
      const done = meta.questDay === quest.day ? meta.questDone : [];
      const sample = { stats: world.stats, counters: quest.counters };
      quest.defs.forEach((def, i) => {
        if (done[i]) return;
        if (def.progress(sample) >= def.target) {
          meta.completeQuest(quest.day!, i);
          if (!silent) {
            useGame.getState().setCallout("QUEST COMPLETE", def.label.toUpperCase());
            audio.shieldPickup();
          }
        }
      });
    };

    /** Shared run-end path: a crash and a survived sprint finish differ only
     *  in FX and forensics — recording, PBs, and unlocks flow identically. */
    const endRun = (finished: boolean) => {
      evaluateQuests(true); // Final sweep with the closing stats, no fanfare.
      const g = useGame.getState();
      const meta = useMeta.getState();
      const before = metaSnapshot(meta);
      const stats = world.stats;
      const periodKey =
        stats.mode === "daily" ? dailyKey() : stats.mode === "sprint" ? weeklyKey() : null;
      // Lab prototype runs are unranked sandboxes (roadmap Phase 5): no PBs,
      // no rating, no streaks, no lifetime tallies, no ghost — nothing
      // persists. The run still records in-memory so replays stay testable.
      const labRun = stats.lab.length > 0;
      const rivalRun = bundle.rival.recording !== null;
      const unrankedRun = labRun || rivalRun;
      // Mode-aware "how close was I": sprint runs race the week's best score,
      // trials race their own distance table, endless/daily the global PBs.
      const prevSprint = periodKey ? meta.sprintBest[periodKey] : undefined;
      const prevTrial = stats.trialId ? meta.trialBest[stats.trialId] : undefined;
      const res = unrankedRun
        ? {
            newBestScore: false,
            newBestDistance: false,
            newDailyBest: false,
            newSprintBest: false,
            newTrialBest: false,
            medal: null,
            ratingDelta: null,
            deathStreak: 0,
          }
        : meta.recordRun(stats, periodKey);
      const after = metaSnapshot(useMeta.getState());
      // Persist the run's input recording — tomorrow's ghost (roadmap 3.1/3.2).
      const recording = world.getRecording();
      if (recording && !unrankedRun) useReplays.getState().recordRun(recording, periodKey);
      const unlocked: { kind: "craft" | "trail"; id: string; name: string }[] = [];
      for (const c of CRAFTS) {
        if (!c.unlock.check(before) && c.unlock.check(after)) {
          unlocked.push({ kind: "craft", id: c.id, name: c.name });
        }
      }
      for (const t of TRAILS) {
        if (!t.unlock.check(before) && t.unlock.check(after)) {
          unlocked.push({ kind: "trail", id: t.id, name: t.name });
        }
      }
      const scoreDelta = unrankedRun
        ? 0
        : stats.mode === "sprint"
          ? stats.score - (prevSprint?.score ?? 0)
          : stats.mode === "trial"
            ? 0
            : stats.score - before.bestScore;
      const distanceDelta = unrankedRun
        ? 0
        : stats.mode === "sprint"
          ? 0
          : stats.mode === "trial"
            ? (prevTrial?.distance ?? 0) - stats.distance
            : before.bestDistance - stats.distance;
      g.setOutcome({
        stats: { ...stats },
        finished,
        rival: rivalRun,
        ...res,
        scoreDelta,
        distanceDelta,
        forensics: world.buildForensics(),
        unlocked,
      });
      g.setPhase("dead");
    };

    const offs: (() => void)[] = [
      world.events.on("runStart", ({ config }) => {
        quest.counters = { riskShards: 0, fastPerfects: 0 };
        if (config.mode === "daily" && !bundle.rival.recording) {
          quest.day = dailyKey();
          quest.defs = questsForDay(quest.day);
        } else {
          quest.day = null;
          quest.defs = [];
        }
      }),
      world.events.on("death", () => {
        env.triggerImpact(1);
        audio.death();
        haptics.death(world.speedNorm);
        endRun(false);
      }),
      world.events.on("finish", () => {
        env.triggerFlow(1.2);
        audio.finish();
        endRun(true);
      }),
      world.events.on("nearMiss", (e) => {
        const game = useGame.getState();
        if (game.lesson === "graze") game.setLesson("boost");
        env.triggerNearMiss(e.precision, e.x - world.x);
        audio.nearMiss(Math.sign(e.x - world.x), e.grade, e.precision, e.chain);
        haptics.nearMiss(e.grade);
        if (e.resonant) audio.resonant();
        const label = e.resonant
          ? "RESONANT PASS"
          : e.grade === "perfect" ? "PERFECT PASS" : e.grade === "razor" ? "RAZOR PASS" : "CLOSE PASS";
        const energy = e.energyAward >= 0.05 ? ` · +${e.energyAward.toFixed(1)} ENERGY` : "";
        useGame.getState().setSkillMoment(
          label,
          `+${e.scoreAward.toLocaleString()}${energy} · CHAIN ${e.chain}`,
          e.grade,
        );
        if (e.grade === "perfect") {
          for (const def of quest.defs) {
            if (def.speedBar !== undefined && world.speed >= def.speedBar) {
              quest.counters.fastPerfects++;
              break;
            }
          }
        }
        evaluateQuests();
      }),
      world.events.on("thread", (e) => {
        env.triggerNearMiss(1, 0);
        env.triggerFlow(0.9);
        audio.thread(e.tightness);
        haptics.thread(e.tightness);
        useGame.getState().setSkillMoment(
          "THREAD THE NEEDLE",
          `+${e.scoreAward.toLocaleString()} · BOTH SIDES`,
          "thread",
        );
        evaluateQuests();
      }),
      world.events.on("shard", (e) => {
        audio.shard(e.combo);
        if (e.combo >= 2 || e.risk) {
          useGame.getState().setSkillMoment(
            e.risk ? `RISK SHARD ×${e.combo}` : `SHARD COMBO ×${e.combo}`,
            `+${e.scoreAward.toLocaleString()} · +${e.energyAward.toFixed(1)} ENERGY`,
            "shard",
          );
        }
        if (e.risk) quest.counters.riskShards++;
        evaluateQuests();
      }),
      world.events.on("shatter", (e) => {
        env.triggerBoost(0.6);
        env.triggerNearMiss(0.8, 0);
        audio.shatter();
        haptics.shatter();
        useGame.getState().setSkillMoment(
          "GLASS BREACH",
          `+${e.scoreAward.toLocaleString()} · +${e.energyAward.toFixed(1)} ENERGY`,
          "thread",
        );
        evaluateQuests();
      }),
      world.events.on("bounce", (e) => {
        env.triggerImpact(0.28);
        audio.bounce(e.dir);
        haptics.bounce();
        useGame.getState().setSkillMoment(
          "KINETIC BOUNCE",
          `+${e.scoreAward.toLocaleString()} · FLUNG ${e.dir > 0 ? "RIGHT" : "LEFT"}`,
          "shard",
        );
      }),
      world.events.on("beamFire", (e) => {
        audio.zap(Math.sign(e.x - world.x));
      }),
      world.events.on("runEvent", (e) => {
        env.triggerTransition();
        audio.eventAlert(e.kind);
        useGame.getState().setCallout(
          e.name,
          e.kind === "meteor" ? "INCOMING — WATCH THE MARKERS" : "RIDE THE SHARD RIVER",
        );
      }),
      world.events.on("shieldPickup", () => {
        env.triggerShield(1);
        audio.shieldPickup();
      }),
      world.events.on("shieldBreak", () => {
        env.triggerShield(0.7);
        env.triggerImpact(0.55);
        audio.shieldBreak();
        haptics.shieldBreak();
      }),
      world.events.on("boostStart", () => {
        const game = useGame.getState();
        if (game.lesson === "boost") game.setLesson("rhythm");
        env.triggerBoost(1);
        audio.boostStart();
        haptics.boostStart();
      }),
      world.events.on("surge", () => {
        env.triggerBoost(0.8);
        audio.surge();
      }),
      world.events.on("dash", (e) => {
        env.triggerBoost(0.7);
        audio.dash(e.dir);
        haptics.dash();
      }),
      world.events.on("pump", (e) => {
        env.triggerBoost(0.35 + e.strength * 0.3);
        audio.pump(e.dir, e.strength, e.wall);
        haptics.pump(e.strength, e.wall);
      }),
      world.events.on("launch", (e) => {
        env.triggerBoost(0.5);
        audio.launch(Math.min(1, e.vy / 11), e.boosted);
        haptics.launch(Math.min(1, e.vy / 11));
        if (!skyhookSeen.current) {
          skyhookSeen.current = true;
          useGame.getState().setCallout(
            "SKYHOOK",
            "TAP BOOST MID-AIR TO DOUBLE JUMP · HOLD IT TO DIVE · FLICK OPPOSITE TO LAND",
          );
        }
      }),
      world.events.on("airJump", (e) => {
        env.triggerBoost(0.3 + e.quality * 0.3);
        audio.airJump(e.quality);
        haptics.airJump(e.quality);
        if (e.quality >= 0.85) {
          useGame.getState().setSkillMoment(
            "APEX JUMP",
            "FULL IMPULSE · TAPPED AT THE PEAK",
            "perfect",
          );
        }
      }),
      world.events.on("land", (e) => {
        const game = useGame.getState();
        if (game.lesson === "jump") {
          // First touchdown graduates the first flight.
          useMeta.getState().completeOnboarding();
          game.setLesson(null);
          game.setCallout("FLIGHT SYSTEMS ONLINE", "THE OPEN TRACK IS YOURS");
        }
        audio.land(e.grade, Math.min(1, e.impact / 24));
        haptics.land(e.grade, Math.min(1, e.impact / 24));
        if (e.grade === "hard") {
          env.triggerImpact(0.4);
          useGame.getState().setSkillMoment(
            "HARD LANDING",
            `-10% SPEED · FLICK OPPOSITE BEFORE TOUCHDOWN`,
            "close",
          );
        } else if (e.grade === "perfect") {
          env.triggerFlow(0.9);
          if (e.resonant) audio.resonant();
          useGame.getState().setSkillMoment(
            e.resonant ? "RESONANT LANDING" : "PERFECT LANDING",
            `+${e.scoreAward.toLocaleString()} · SPEED KEPT · +${e.energyAward.toFixed(1)} ENERGY`,
            "perfect",
          );
        }
      }),
      world.events.on("routeChoice", (e) => {
        useGame.getState().setSkillMoment(
          e.label.toUpperCase(),
          e.reward === "energy"
            ? "ENERGY ROUTE · REFUEL AHEAD"
            : e.reward === "flow"
              ? "FLOW ROUTE · PRECISION AHEAD"
              : "TEMPO ROUTE · READ THE BEAT",
          e.reward === "energy" ? "shard" : e.reward === "flow" ? "thread" : "perfect",
        );
      }),
      world.events.on("patternAhead", (e) => {
        audio.foreshadow(e.skills[0] ?? "navigation");
        useGame.getState().setAheadCue(e.patternId, e.skills, e.lead);
      }),
      world.events.on("mythic", (e) => {
        env.triggerTransition();
        audio.mythic(e.index);
        useGame.getState().setCallout(
          e.name.toUpperCase(),
          `${(e.depth / 1000).toFixed(0)} KM · MYTHIC DEPTH`,
        );
      }),
      world.events.on("boostEnd", () => {
        env.triggerBoost(0.45);
        audio.boostEnd();
        evaluateQuests();
      }),
      world.events.on("flowTier", (e) => {
        if (e.tier > e.prev) {
          env.triggerFlow(Math.min(1.4, 0.7 + e.tier * 0.12));
          audio.flowTierUp(e.tier);
          if (e.tier >= 2) useGame.getState().setCallout(`FLOW ${e.tier}`, "WORLD SYNC");
          evaluateQuests();
        }
      }),
      world.events.on("sectionGrade", (e) => {
        useGame.getState().setSectionGrade(e.grade, e.patternId);
        evaluateQuests();
      }),
      world.events.on("setpiece", (e) => useGame.getState().setCallout(e.name)),
      world.events.on("biome", (e) => {
        if (e.index > 0) {
          env.triggerTransition();
          audio.biome(e.index);
          useGame.getState().setCallout(e.name, "NEW SECTOR");
        }
      }),
      world.events.on("lightning", (e) => audio.thunderClap(e.intensity)),
    ];
    return () => offs.forEach((off) => off());
  }, [bundle]);

  // Input lifecycle + audio unlock. The engine owns its unlock listeners:
  // iOS only grants user activation on touchend/pointerup/mousedown/keydown,
  // so the input manager's pointerdown path can't resume the context there.
  useEffect(() => {
    const { input, audio } = bundle;
    input.attach(document.body);
    const offUnlock = audio.attachUnlock(document);
    // Auto-pause when the tab is hidden — dying while throttled is unfair.
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && useGame.getState().phase === "running") {
        bundle.togglePause();
      }
    };
    const onUiClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button")) audio.uiClick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("click", onUiClick);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onUiClick);
      offUnlock();
      input.dispose();
    };
  }, [bundle]);

  // Volume + accessibility settings -> engine/env.
  useEffect(() => {
    const apply = () => {
      const s = useSettings.getState();
      bundle.audio.setVolumes(s.musicVolume, s.sfxVolume);
      bundle.env.reduceFlash = s.reduceFlash;
      bundle.env.highContrast = s.highContrast;
      bundle.haptics.enabled = s.haptics;
    };
    apply();
    return useSettings.subscribe(apply);
  }, [bundle]);

  return <GameContext.Provider value={bundle}>{children}</GameContext.Provider>;
}
