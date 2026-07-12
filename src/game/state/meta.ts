"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RunStats } from "../core/world";

export interface UnlockProgress {
  value: number;
  target: number;
}

export interface UnlockRule {
  label: string;
  check: (m: MetaSnapshot) => boolean;
  progress?: (m: MetaSnapshot) => UnlockProgress;
}

export interface CraftDesign {
  id: string;
  name: string;
  desc: string;
  /** Hull tint + trim/engine emissive colors. */
  body: string;
  trim: string;
  engine: string;
  /** Geometry personality. */
  hullScale: [number, number, number];
  finSweep: number;
  unlock: UnlockRule;
}

export interface TrailStyle {
  id: string;
  name: string;
  color: string;
  unlock: UnlockRule;
}

export interface MetaSnapshot {
  bestScore: number;
  bestDistance: number;
  totalRuns: number;
  totalDistance: number;
  totalShards: number;
  totalNearMisses: number;
  totalPerfectPasses: number;
  maxFlowTier: number;
  bestFlowChain: number;
  bestShardCombo: number;
  dailiesPlayed: number;
}

export const CRAFTS: CraftDesign[] = [
  {
    id: "interceptor", name: "Interceptor", desc: "Standard issue. Balanced and honest.",
    body: "#131a2e", trim: "#43f6ff", engine: "#43f6ff",
    hullScale: [1, 1, 1], finSweep: 0.5,
    unlock: { label: "Always unlocked", check: () => true },
  },
  {
    id: "vector", name: "Vector", desc: "A dart of sharpened alloy.",
    body: "#101426", trim: "#ff3df0", engine: "#ff7af5",
    hullScale: [0.82, 0.9, 1.22], finSweep: 0.72,
    unlock: {
      label: "Reach 2,500 m in one run",
      check: (m) => m.bestDistance >= 2500,
      progress: (m) => ({ value: m.bestDistance, target: 2500 }),
    },
  },
  {
    id: "manta", name: "Manta", desc: "A broad silhouette with serene menace.",
    body: "#0c2226", trim: "#64ffd8", engine: "#64ffd8",
    hullScale: [1.35, 0.78, 0.95], finSweep: 0.3,
    unlock: {
      label: "Collect 300 shards (lifetime)",
      check: (m) => m.totalShards >= 300,
      progress: (m) => ({ value: m.totalShards, target: 300 }),
    },
  },
  {
    id: "razor", name: "Razor", desc: "A needle profile for proximity hunters.",
    body: "#231018", trim: "#ffb200", engine: "#ff8c3b",
    hullScale: [0.7, 0.85, 1.3], finSweep: 0.85,
    unlock: {
      label: "Hit Flow tier 4",
      check: (m) => m.maxFlowTier >= 4,
      progress: (m) => ({ value: m.maxFlowTier, target: 4 }),
    },
  },
  {
    id: "phantom", name: "Phantom", desc: "Half ship, half rumor.",
    body: "#1a1030", trim: "#a78bfa", engine: "#c4b0ff",
    hullScale: [0.95, 1.15, 1.1], finSweep: 0.6,
    unlock: {
      label: "Play 3 daily courses",
      check: (m) => m.dailiesPlayed >= 3,
      progress: (m) => ({ value: m.dailiesPlayed, target: 3 }),
    },
  },
  {
    id: "aurora", name: "Aurora", desc: "Veteran of ten thousand meters.",
    body: "#0f1f33", trim: "#ff2d78", engine: "#ff9e3d",
    hullScale: [1.1, 1, 1.15], finSweep: 0.55,
    unlock: {
      label: "Travel 25,000 m (lifetime)",
      check: (m) => m.totalDistance >= 25000,
      progress: (m) => ({ value: m.totalDistance, target: 25000 }),
    },
  },
  {
    id: "vanguard", name: "Vanguard", desc: "A trophy hull cut for Flow masters.",
    body: "#111827", trim: "#fef08a", engine: "#fb7185",
    hullScale: [0.9, 0.82, 1.28], finSweep: 0.92,
    unlock: {
      label: "Build a 10-pass Flow chain",
      check: (m) => m.bestFlowChain >= 10,
      progress: (m) => ({ value: m.bestFlowChain, target: 10 }),
    },
  },
];

export const TRAILS: TrailStyle[] = [
  { id: "cyan", name: "Ion Cyan", color: "#43f6ff", unlock: { label: "Always unlocked", check: () => true } },
  {
    id: "magenta", name: "Hot Magenta", color: "#ff3df0",
    unlock: {
      label: "50 near misses (lifetime)", check: (m) => m.totalNearMisses >= 50,
      progress: (m) => ({ value: m.totalNearMisses, target: 50 }),
    },
  },
  {
    id: "gold", name: "Solar Gold", color: "#ffc63d",
    unlock: {
      label: "Score 25,000 in one run", check: (m) => m.bestScore >= 25000,
      progress: (m) => ({ value: m.bestScore, target: 25000 }),
    },
  },
  {
    id: "emerald", name: "Emerald Wake", color: "#4dffa1",
    unlock: {
      label: "Finish 10 runs", check: (m) => m.totalRuns >= 10,
      progress: (m) => ({ value: m.totalRuns, target: 10 }),
    },
  },
  {
    id: "violet", name: "Void Violet", color: "#8b5bff",
    unlock: {
      label: "Play a daily course", check: (m) => m.dailiesPlayed >= 1,
      progress: (m) => ({ value: m.dailiesPlayed, target: 1 }),
    },
  },
  {
    id: "white", name: "Ghost White", color: "#f2f6ff",
    unlock: {
      label: "Reach 5,000 m in one run", check: (m) => m.bestDistance >= 5000,
      progress: (m) => ({ value: m.bestDistance, target: 5000 }),
    },
  },
  {
    id: "rose", name: "Razor Rose", color: "#fb7185",
    unlock: {
      label: "Land 25 perfect passes",
      check: (m) => m.totalPerfectPasses >= 25,
      progress: (m) => ({ value: m.totalPerfectPasses, target: 25 }),
    },
  },
  {
    id: "prism", name: "Prism Surge", color: "#fef08a",
    unlock: {
      label: "Reach an 8-shard combo",
      check: (m) => m.bestShardCombo >= 8,
      progress: (m) => ({ value: m.bestShardCombo, target: 8 }),
    },
  },
];

interface DailyRecord {
  score: number;
  distance: number;
}

interface MetaState extends MetaSnapshot {
  dailyBest: Record<string, DailyRecord>;
  selectedCraft: string;
  selectedTrail: string;
  /** Ids the player has seen the "unlocked!" toast for. */
  celebrated: string[];
  recordRun(stats: RunStats, dailyKey: string | null): { newBestScore: boolean; newBestDistance: boolean; newDailyBest: boolean };
  selectCraft(id: string): void;
  selectTrail(id: string): void;
  markCelebrated(id: string): void;
}

export const useMeta = create<MetaState>()(
  persist(
    (set, get) => ({
      bestScore: 0,
      bestDistance: 0,
      totalRuns: 0,
      totalDistance: 0,
      totalShards: 0,
      totalNearMisses: 0,
      totalPerfectPasses: 0,
      maxFlowTier: 0,
      bestFlowChain: 0,
      bestShardCombo: 0,
      dailiesPlayed: 0,
      dailyBest: {},
      selectedCraft: "interceptor",
      selectedTrail: "cyan",
      celebrated: ["interceptor", "cyan"],

      recordRun(stats, dailyKey) {
        const s = get();
        const newBestScore = stats.score > s.bestScore;
        const newBestDistance = stats.distance > s.bestDistance;
        let newDailyBest = false;
        const dailyBest = { ...s.dailyBest };
        let dailiesPlayed = s.dailiesPlayed;
        if (dailyKey) {
          const prev = dailyBest[dailyKey];
          if (!prev) dailiesPlayed += 1;
          if (!prev || stats.score > prev.score) {
            dailyBest[dailyKey] = { score: stats.score, distance: Math.round(stats.distance) };
            newDailyBest = true;
          }
        }
        set({
          bestScore: Math.max(s.bestScore, stats.score),
          bestDistance: Math.max(s.bestDistance, stats.distance),
          totalRuns: s.totalRuns + 1,
          totalDistance: s.totalDistance + stats.distance,
          totalShards: s.totalShards + stats.shards,
          totalNearMisses: s.totalNearMisses + stats.nearMisses,
          totalPerfectPasses: s.totalPerfectPasses + stats.perfectPasses,
          maxFlowTier: Math.max(s.maxFlowTier, stats.maxFlowTier),
          bestFlowChain: Math.max(s.bestFlowChain, stats.bestFlowChain),
          bestShardCombo: Math.max(s.bestShardCombo, stats.bestShardCombo),
          dailiesPlayed,
          dailyBest,
        });
        return { newBestScore, newBestDistance, newDailyBest };
      },

      selectCraft: (selectedCraft) => set({ selectedCraft }),
      selectTrail: (selectedTrail) => set({ selectedTrail }),
      markCelebrated: (id) =>
        set((s) => ({ celebrated: s.celebrated.includes(id) ? s.celebrated : [...s.celebrated, id] })),
    }),
    {
      name: "cubefield:meta",
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<MetaState>;
        return {
          ...state,
          totalPerfectPasses: state.totalPerfectPasses ?? 0,
          bestFlowChain: state.bestFlowChain ?? 0,
          bestShardCombo: state.bestShardCombo ?? 0,
        } as MetaState;
      },
    },
  ),
);

export const metaSnapshot = (m: MetaState): MetaSnapshot => ({
  bestScore: m.bestScore,
  bestDistance: m.bestDistance,
  totalRuns: m.totalRuns,
  totalDistance: m.totalDistance,
  totalShards: m.totalShards,
  totalNearMisses: m.totalNearMisses,
  totalPerfectPasses: m.totalPerfectPasses,
  maxFlowTier: m.maxFlowTier,
  bestFlowChain: m.bestFlowChain,
  bestShardCombo: m.bestShardCombo,
  dailiesPlayed: m.dailiesPlayed,
});
