"use client";

import { create } from "zustand";
import { ENERGY } from "../core/constants";
import type { RunStats } from "../core/world";

export type GamePhase = "boot" | "title" | "running" | "paused" | "dead";
export type GameMode = "endless" | "daily";

export interface HudSnapshot {
  score: number;
  multiplier: number;
  flowTier: number;
  flowFrac: number;
  flowGrace: number;
  flowChain: number;
  shardCombo: number;
  energy: number;
  boosting: boolean;
  shield: boolean;
  speedKmh: number;
  distance: number;
  biome: string;
  personalBestBeaten: boolean;
}

export interface SkillMoment {
  text: string;
  detail: string;
  tone: "close" | "razor" | "perfect" | "shard" | "thread";
  at: number;
}

export interface RunOutcome {
  stats: RunStats;
  newBestScore: boolean;
  newBestDistance: boolean;
  newDailyBest: boolean;
  scoreDelta: number;
  unlocked: { kind: "craft" | "trail"; id: string; name: string }[];
}

export interface GraphicsStats {
  dpr: number;
  drsScale: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  postCpuMs: number;
}

interface GameState {
  phase: GamePhase;
  mode: GameMode;
  hud: HudSnapshot;
  outcome: RunOutcome | null;
  /** Set-piece / biome callout toast. */
  callout: { text: string; sub?: string; at: number } | null;
  skillMoment: SkillMoment | null;
  overlay: "none" | "hangar" | "settings" | "help";
  webgpu: boolean | null;
  fps: number;
  graphics: GraphicsStats;
  setPhase(p: GamePhase): void;
  setMode(m: GameMode): void;
  setHud(h: HudSnapshot): void;
  setOutcome(o: RunOutcome | null): void;
  setCallout(text: string, sub?: string): void;
  setSkillMoment(text: string, detail: string, tone: SkillMoment["tone"]): void;
  clearRunFeedback(): void;
  setOverlay(o: GameState["overlay"]): void;
  setWebgpu(v: boolean): void;
  setFps(v: number): void;
  setGraphics(v: Partial<GraphicsStats>): void;
}

export const useGame = create<GameState>((set) => ({
  phase: "boot",
  mode: "endless",
  hud: {
    score: 0, multiplier: 1, flowTier: 0, flowFrac: 0,
    flowGrace: 1, flowChain: 0, shardCombo: 0,
    energy: ENERGY.START, boosting: false, shield: false,
    speedKmh: 0, distance: 0, biome: "Crystal Desert", personalBestBeaten: false,
  },
  outcome: null,
  callout: null,
  skillMoment: null,
  overlay: "none",
  webgpu: null,
  fps: 0,
  graphics: {
    dpr: 1,
    drsScale: 1,
    drawCalls: 0,
    triangles: 0,
    textures: 0,
    postCpuMs: 0,
  },
  setPhase: (phase) => set({ phase }),
  setMode: (mode) => set({ mode }),
  setHud: (hud) => set({ hud }),
  setOutcome: (outcome) => set({ outcome }),
  setCallout: (text, sub) => set({ callout: { text, sub, at: Date.now() } }),
  setSkillMoment: (text, detail, tone) =>
    set({ skillMoment: { text, detail, tone, at: Date.now() } }),
  clearRunFeedback: () => set({ callout: null, skillMoment: null }),
  setOverlay: (overlay) => set({ overlay }),
  setWebgpu: (webgpu) => set({ webgpu }),
  setFps: (fps) => set({ fps }),
  setGraphics: (graphics) =>
    set((state) => ({ graphics: { ...state.graphics, ...graphics } })),
}));
