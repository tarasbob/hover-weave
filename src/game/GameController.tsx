"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { SimWorld } from "./core/world";
import { GhostDriver } from "./core/ghost";
import { InputManager } from "./core/input";
import { EnvState } from "./render/env";
import { AudioEngine } from "./audio/engine";
import type { RunConfig } from "./core/modes";
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
  /** Ambient scroll distance used on the title screen. */
  ambient: { value: number };
  startRun(mode: GameMode, trialId?: string): void;
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
    const ambient = { value: 0 };

    // The active run's identity, captured at launch: restart replays the
    // exact config; the period key keeps a run that crosses UTC midnight (or
    // an ISO week boundary) attached to the seed it was launched with.
    const active: { config: RunConfig; periodKey: string | null } = {
      config: { mode: "endless", seed: "" },
      periodKey: null,
    };

    const startRun = (mode: GameMode, trialId?: string) => {
      const config: RunConfig =
        mode === "daily"
          ? { mode, seed: dailySeed() }
          : mode === "sprint"
            ? { mode, seed: weeklySeed() }
            : mode === "trial"
              ? { mode, seed: trialSeed(trialId ?? ""), trialId }
              : { mode, seed: randomSeed() };
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

      useGame.getState().setMode(mode, config.trialId ?? null);
      useGame.getState().setOutcome(null);
      useGame.getState().clearRunFeedback();
      world.start(config);
      // Race your PB ghost: daily/sprint/trial share the seed (true spatial
      // ghosts), endless re-flies its own recorded track (pace ghost).
      // Skipped runs race nothing.
      ghost.arm(
        useSettings.getState().showGhost && !config.skipTo
          ? useReplays.getState().ghostFor(mode, active.periodKey, config.trialId ?? null)
          : null,
      );
      useGame.getState().setPhase("running");
      audio.startMusic();
    };

    const restart = () => {
      const { config } = active;
      if (!config.seed) startRun("endless");
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
      audio.pauseMusic();
    };

    return { world, ghost, input, env, audio, ambient, startRun, restart, togglePause, backToTitle };
  }, []);

  // Dev-only console handle (assigned post-commit so Strict Mode's discarded
  // bundle never leaks here).
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __game: unknown }).__game = bundle;
      (window as unknown as { __stores: unknown }).__stores = { useGame, useSettings, useMeta };
    }
  }, [bundle]);

  // Wire world events -> stores + audio (render/FX layers subscribe separately).
  useEffect(() => {
    const { world, audio, env } = bundle;

    /** Shared run-end path: a crash and a survived sprint finish differ only
     *  in FX and forensics — recording, PBs, and unlocks flow identically. */
    const endRun = (finished: boolean) => {
      const g = useGame.getState();
      const meta = useMeta.getState();
      const before = metaSnapshot(meta);
      const stats = world.stats;
      const periodKey =
        stats.mode === "daily" ? dailyKey() : stats.mode === "sprint" ? weeklyKey() : null;
      // Mode-aware "how close was I": sprint runs race the week's best score,
      // trials race their own distance table, endless/daily the global PBs.
      const prevSprint = periodKey ? meta.sprintBest[periodKey] : undefined;
      const prevTrial = stats.trialId ? meta.trialBest[stats.trialId] : undefined;
      const res = meta.recordRun(stats, periodKey);
      const after = metaSnapshot(useMeta.getState());
      // Persist the run's input recording — tomorrow's ghost (roadmap 3.1/3.2).
      const recording = world.getRecording();
      if (recording) useReplays.getState().recordRun(recording, periodKey);
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
      const scoreDelta =
        stats.mode === "sprint"
          ? stats.score - (prevSprint?.score ?? 0)
          : stats.mode === "trial"
            ? 0
            : stats.score - before.bestScore;
      const distanceDelta =
        stats.mode === "sprint"
          ? 0
          : stats.mode === "trial"
            ? (prevTrial?.distance ?? 0) - stats.distance
            : before.bestDistance - stats.distance;
      g.setOutcome({
        stats: { ...stats },
        finished,
        ...res,
        scoreDelta,
        distanceDelta,
        forensics: world.buildForensics(),
        unlocked,
      });
      g.setPhase("dead");
    };

    const offs: (() => void)[] = [
      world.events.on("death", () => {
        env.triggerImpact(1);
        audio.death();
        endRun(false);
      }),
      world.events.on("finish", () => {
        env.triggerFlow(1.2);
        audio.finish();
        endRun(true);
      }),
      world.events.on("nearMiss", (e) => {
        env.triggerNearMiss(e.precision, e.x - world.x);
        audio.nearMiss(Math.sign(e.x - world.x), e.grade, e.precision);
        const label =
          e.grade === "perfect" ? "PERFECT PASS" : e.grade === "razor" ? "RAZOR PASS" : "CLOSE PASS";
        const energy = e.energyAward >= 0.05 ? ` · +${e.energyAward.toFixed(1)} ENERGY` : "";
        useGame.getState().setSkillMoment(
          label,
          `+${e.scoreAward.toLocaleString()}${energy} · CHAIN ${e.chain}`,
          e.grade,
        );
      }),
      world.events.on("thread", (e) => {
        env.triggerNearMiss(1, 0);
        env.triggerFlow(0.9);
        audio.thread(e.tightness);
        useGame.getState().setSkillMoment(
          "THREAD THE NEEDLE",
          `+${e.scoreAward.toLocaleString()} · BOTH SIDES`,
          "thread",
        );
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
      }),
      world.events.on("shieldPickup", () => {
        env.triggerShield(1);
        audio.shieldPickup();
      }),
      world.events.on("shieldBreak", () => {
        env.triggerShield(0.7);
        env.triggerImpact(0.55);
        audio.shieldBreak();
      }),
      world.events.on("boostStart", () => {
        env.triggerBoost(1);
        audio.boostStart();
      }),
      world.events.on("boostEnd", () => env.triggerBoost(0.45)),
      world.events.on("flowTier", (e) => {
        if (e.tier > e.prev) {
          env.triggerFlow(Math.min(1.4, 0.7 + e.tier * 0.12));
          audio.flowTierUp(e.tier);
          if (e.tier >= 2) useGame.getState().setCallout(`FLOW ${e.tier}`, "WORLD SYNC");
        }
      }),
      world.events.on("sectionGrade", (e) => {
        useGame.getState().setSectionGrade(e.grade, e.patternId);
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

  // Input lifecycle + audio unlock on first gesture.
  useEffect(() => {
    const { input, audio } = bundle;
    input.attach(document.body);
    const offGesture = input.onFirstGesture(() => {
      const s = useSettings.getState();
      void audio.init().then(() => {
        audio.setVolumes(s.musicVolume, s.sfxVolume);
      });
    });
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
      offGesture();
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
    };
    apply();
    return useSettings.subscribe(apply);
  }, [bundle]);

  return <GameContext.Provider value={bundle}>{children}</GameContext.Provider>;
}
