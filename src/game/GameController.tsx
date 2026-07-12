"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { SimWorld } from "./core/world";
import { InputManager } from "./core/input";
import { EnvState } from "./render/env";
import { AudioEngine } from "./audio/engine";
import { dailyKey, dailySeed, randomSeed } from "./core/rng";
import { useGame, type GameMode } from "./state/game";
import { CRAFTS, TRAILS, metaSnapshot, useMeta } from "./state/meta";
import { useSettings } from "./state/settings";

export interface GameBundle {
  world: SimWorld;
  input: InputManager;
  env: EnvState;
  audio: AudioEngine;
  /** Ambient scroll distance used on the title screen. */
  ambient: { value: number };
  startRun(mode: GameMode): void;
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
    const input = new InputManager();
    const env = new EnvState();
    const audio = new AudioEngine();
    const ambient = { value: 0 };

    const startRun = (mode: GameMode) => {
      const daily = mode === "daily";
      const seed = daily ? dailySeed() : randomSeed();
      useGame.getState().setMode(mode);
      useGame.getState().setOutcome(null);
      useGame.getState().clearRunFeedback();
      world.start(seed, daily);
      useGame.getState().setPhase("running");
      audio.startMusic();
    };

    const restart = () => {
      startRun(useGame.getState().mode);
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
      useGame.getState().setPhase("title");
      useGame.getState().setOutcome(null);
      audio.pauseMusic();
    };

    return { world, input, env, audio, ambient, startRun, restart, togglePause, backToTitle };
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
    const offs: (() => void)[] = [
      world.events.on("death", () => {
        env.triggerImpact(1);
        audio.death();
        const g = useGame.getState();
        const meta = useMeta.getState();
        const before = metaSnapshot(meta);
        const stats = world.stats;
        const daily = world.daily ? dailyKey() : null;
        const res = meta.recordRun(stats, daily);
        const after = metaSnapshot(useMeta.getState());
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
        g.setOutcome({
          stats: { ...stats },
          ...res,
          scoreDelta: stats.score - before.bestScore,
          unlocked,
        });
        g.setPhase("dead");
      }),
      world.events.on("nearMiss", (e) => {
        env.triggerNearMiss(e.precision, e.x - world.x);
        audio.nearMiss(Math.sign(e.x - world.x), e.grade, e.precision);
        const label =
          e.grade === "perfect" ? "PERFECT PASS" : e.grade === "razor" ? "RAZOR PASS" : "CLOSE PASS";
        useGame.getState().setSkillMoment(
          label,
          `+${e.scoreAward.toLocaleString()} · CHAIN ${e.chain}`,
          e.grade,
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
