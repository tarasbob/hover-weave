"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { heatScoreMult, type HeatId } from "../core/heat";
import { normalizeLab, type LabId } from "../core/lab";
import { RATING, updateRating } from "../core/rating";
import type { RunStats } from "../core/world";
import { MEDAL_RANK, medalFor, trialById, type Medal } from "../track/trials";

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
  // Phase 4 mastery signals (unlock fuel, roadmap 4.6).
  /** Trials currently at gold or better / at author. */
  goldTrials: number;
  authorTrials: number;
  /** Highest pilot rating ever held. */
  peakRating: number;
  /** Lifetime daily quests completed. */
  questsCompleted: number;
  /** Sprints survived to the horizon. */
  sprintsFinished: number;
  /** Best heat score-multiplier carried past 2 km (1 = never). */
  bestHeatCleared: number;
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
  {
    id: "meridian", name: "Meridian", desc: "Clockwork hull for pilots who finish what they start.",
    body: "#0a1c24", trim: "#5eead4", engine: "#facc15",
    hullScale: [1.05, 0.9, 1.18], finSweep: 0.45,
    unlock: {
      label: "Survive 3 full sprints",
      check: (m) => m.sprintsFinished >= 3,
      progress: (m) => ({ value: m.sprintsFinished, target: 3 }),
    },
  },
  {
    id: "sovereign", name: "Sovereign", desc: "Gilded for the trial grounds' standing champion.",
    body: "#1c1408", trim: "#fbbf24", engine: "#fde68a",
    hullScale: [0.95, 0.95, 1.25], finSweep: 0.7,
    unlock: {
      label: "Hold 5 gold trial medals",
      check: (m) => m.goldTrials >= 5,
      progress: (m) => ({ value: m.goldTrials, target: 5 }),
    },
  },
  {
    id: "oblivion", name: "Oblivion", desc: "Phantom-tier plating. The rating speaks for itself.",
    body: "#120a1e", trim: "#e879f9", engine: "#a78bfa",
    hullScale: [0.78, 0.8, 1.35], finSweep: 0.95,
    unlock: {
      label: "Reach 1,900 pilot rating",
      check: (m) => m.peakRating >= 1900,
      progress: (m) => ({ value: m.peakRating, target: 1900 }),
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
  {
    id: "ember", name: "Ember Wake", color: "#fb923c",
    unlock: {
      label: "Carry ×1.5 heat past 2,000 m",
      check: (m) => m.bestHeatCleared >= 1.5,
      progress: (m) => ({ value: m.bestHeatCleared, target: 1.5 }),
    },
  },
  {
    id: "quicksilver", name: "Quicksilver", color: "#e2e8f0",
    unlock: {
      label: "Earn an Author trial medal",
      check: (m) => m.authorTrials >= 1,
      progress: (m) => ({ value: m.authorTrials, target: 1 }),
    },
  },
  {
    id: "laurel", name: "Laurel Stream", color: "#a3e635",
    unlock: {
      label: "Complete 9 daily quests",
      check: (m) => m.questsCompleted >= 9,
      progress: (m) => ({ value: m.questsCompleted, target: 9 }),
    },
  },
  {
    id: "meteor", name: "Meteor Line", color: "#f472b6",
    unlock: {
      label: "Reach 1,500 pilot rating",
      check: (m) => m.peakRating >= 1500,
      progress: (m) => ({ value: m.peakRating, target: 1500 }),
    },
  },
];

interface DailyRecord {
  score: number;
  distance: number;
}

/** Per-trial personal best (roadmap 4.1). */
export interface TrialRecord {
  distance: number;
  medal: Medal | null;
}

/** Consecutive deaths to the same pattern (forensics streak note). */
export interface DeathStreak {
  patternId: string;
  count: number;
}

export interface RunRecordResult {
  newBestScore: boolean;
  newBestDistance: boolean;
  newDailyBest: boolean;
  newSprintBest: boolean;
  newTrialBest: boolean;
  /** Medal earned this run (trials only; may equal the previous best). */
  medal: Medal | null;
  /** Rating movement from this run (null = the run was not rated). */
  ratingDelta: number | null;
  /** How many runs in a row have now ended on this pattern (1 = first). */
  deathStreak: number;
}

interface MetaState extends Omit<MetaSnapshot, "goldTrials" | "authorTrials"> {
  dailyBest: Record<string, DailyRecord>;
  /** Best sprint per ISO-week key (roadmap 4.2). */
  sprintBest: Record<string, DailyRecord>;
  /** Best run per trial id (roadmap 4.1). */
  trialBest: Record<string, TrialRecord>;
  deathStreak: DeathStreak | null;
  /** Pilot rating (roadmap 4.4): current, runs counted, and peak in snapshot. */
  rating: number;
  ratedRuns: number;
  /** Daily quests (roadmap 4.5): today's key + per-quest completion. */
  questDay: string | null;
  questDone: boolean[];
  selectedCraft: string;
  selectedTrail: string;
  /** Pre-run heat selection (endless launches, roadmap 4.3). */
  selectedHeat: HeatId[];
  /** Pre-run lab prototype selection (endless launches, roadmap Phase 5). */
  selectedLab: LabId[];
  /** Ids the player has seen the "unlocked!" toast for. */
  celebrated: string[];
  /**
   * Record a finished run. `periodKey` is the UTC day key for daily runs and
   * the ISO week key for sprints (captured at run start), null otherwise.
   */
  recordRun(stats: RunStats, periodKey: string | null): RunRecordResult;
  /** Mark one of `day`'s quests complete (idempotent; banks immediately). */
  completeQuest(day: string, index: number): void;
  selectCraft(id: string): void;
  selectTrail(id: string): void;
  selectHeat(ids: HeatId[]): void;
  selectLab(ids: LabId[]): void;
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
      peakRating: 0,
      questsCompleted: 0,
      sprintsFinished: 0,
      bestHeatCleared: 1,
      dailyBest: {},
      sprintBest: {},
      trialBest: {},
      deathStreak: null,
      rating: RATING.START,
      ratedRuns: 0,
      questDay: null,
      questDone: [],
      selectedCraft: "interceptor",
      selectedTrail: "cyan",
      selectedHeat: [],
      selectedLab: [],
      celebrated: ["interceptor", "cyan"],

      recordRun(stats, periodKey) {
        const s = get();
        const mode = stats.mode;
        // Global score/distance PBs are the endless ladder (daily shares it —
        // same track rules). Sprint and trials keep their own tables: a 180 s
        // score attack or a looped drill must not pollute the endless bests.
        const countsGlobal = mode === "endless" || mode === "daily";
        const newBestScore = countsGlobal && stats.score > s.bestScore;
        const newBestDistance = countsGlobal && stats.distance > s.bestDistance;

        let newDailyBest = false;
        const dailyBest = { ...s.dailyBest };
        let dailiesPlayed = s.dailiesPlayed;
        if (mode === "daily" && periodKey) {
          const prev = dailyBest[periodKey];
          if (!prev) dailiesPlayed += 1;
          if (!prev || stats.score > prev.score) {
            dailyBest[periodKey] = { score: stats.score, distance: Math.round(stats.distance) };
            newDailyBest = true;
          }
        }

        let newSprintBest = false;
        const sprintBest = { ...s.sprintBest };
        if (mode === "sprint" && periodKey) {
          const prev = sprintBest[periodKey];
          if (!prev || stats.score > prev.score) {
            sprintBest[periodKey] = { score: stats.score, distance: Math.round(stats.distance) };
            newSprintBest = true;
          }
        }

        let newTrialBest = false;
        let medal: Medal | null = null;
        const trialBest = { ...s.trialBest };
        if (mode === "trial" && stats.trialId) {
          const trial = trialById(stats.trialId);
          if (trial) {
            medal = medalFor(trial, stats.distance);
            const prev = trialBest[stats.trialId];
            if (!prev || stats.distance > prev.distance) {
              const bestMedal =
                prev?.medal && medal && MEDAL_RANK[prev.medal] > MEDAL_RANK[medal]
                  ? prev.medal
                  : (medal ?? prev?.medal ?? null);
              trialBest[stats.trialId] = {
                distance: Math.round(stats.distance),
                medal: bestMedal,
              };
              newTrialBest = true;
            }
          }
        }

        // Pattern death streaks track learning on the open track; a trial
        // looping one pattern would trivially inflate them, so it neither
        // feeds nor resets the streak (nor does a survived sprint finish).
        const killer = stats.deathCause?.patternId ?? null;
        const deathStreak: DeathStreak | null =
          mode === "trial"
            ? s.deathStreak
            : killer
              ? {
                  patternId: killer,
                  count: s.deathStreak?.patternId === killer ? s.deathStreak.count + 1 : 1,
                }
              : null;

        // Pilot rating (roadmap 4.4): plain endless/daily runs only — heat
        // changes the track, trials/sprints are different ladders entirely.
        const rated = countsGlobal && stats.heat.length === 0;
        const rating = rated ? updateRating(s.rating, s.ratedRuns, stats.distance) : s.rating;
        const ratingDelta = rated ? rating - s.rating : null;

        // Heat mastery: the strongest stack carried past 2 km (roadmap 4.6).
        const heatCleared =
          mode === "endless" && stats.heat.length > 0 && stats.distance >= 2000
            ? heatScoreMult(stats.heat)
            : 1;

        set({
          deathStreak,
          bestScore: countsGlobal ? Math.max(s.bestScore, stats.score) : s.bestScore,
          bestDistance: countsGlobal
            ? Math.max(s.bestDistance, stats.distance)
            : s.bestDistance,
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
          sprintBest,
          trialBest,
          rating,
          ratedRuns: rated ? s.ratedRuns + 1 : s.ratedRuns,
          peakRating: Math.max(s.peakRating, rating),
          sprintsFinished:
            mode === "sprint" && stats.deathCause === null
              ? s.sprintsFinished + 1
              : s.sprintsFinished,
          bestHeatCleared: Math.max(s.bestHeatCleared, heatCleared),
        });
        return {
          newBestScore,
          newBestDistance,
          newDailyBest,
          newSprintBest,
          newTrialBest,
          medal,
          ratingDelta,
          deathStreak: mode === "trial" ? 0 : (deathStreak?.count ?? 0),
        };
      },

      completeQuest(day, index) {
        const s = get();
        // A new day resets the board; completion banks the moment it happens.
        const questDone =
          s.questDay === day ? [...s.questDone] : [false, false, false];
        if (questDone[index]) return;
        questDone[index] = true;
        set({
          questDay: day,
          questDone,
          questsCompleted: s.questsCompleted + 1,
        });
      },

      selectCraft: (selectedCraft) => set({ selectedCraft }),
      selectTrail: (selectedTrail) => set({ selectedTrail }),
      selectHeat: (selectedHeat) => set({ selectedHeat }),
      selectLab: (selectedLab) => set({ selectedLab }),
      markCelebrated: (id) =>
        set((s) => ({ celebrated: s.celebrated.includes(id) ? s.celebrated : [...s.celebrated, id] })),
    }),
    {
      name: "cubefield:meta",
      version: 7,
      migrate: (persisted) => {
        const state = persisted as Partial<MetaState>;
        return {
          ...state,
          totalPerfectPasses: state.totalPerfectPasses ?? 0,
          bestFlowChain: state.bestFlowChain ?? 0,
          bestShardCombo: state.bestShardCombo ?? 0,
          deathStreak: state.deathStreak ?? null,
          // v4: per-mode ladders (roadmap 4.1 / 4.2).
          sprintBest: state.sprintBest ?? {},
          trialBest: state.trialBest ?? {},
          // v5: rating, quests, heat, mastery counters (roadmap 4.3–4.6).
          rating: state.rating ?? RATING.START,
          ratedRuns: state.ratedRuns ?? 0,
          peakRating: state.peakRating ?? 0,
          questDay: state.questDay ?? null,
          questDone: state.questDone ?? [],
          questsCompleted: state.questsCompleted ?? 0,
          sprintsFinished: state.sprintsFinished ?? 0,
          bestHeatCleared: state.bestHeatCleared ?? 1,
          selectedHeat: state.selectedHeat ?? [],
          // v6: lab prototype selection (roadmap Phase 5).
          // v7: "resonance" went mainline (fun-frontier 2.1) — drop retired
          // lab ids from persisted selections.
          selectedLab: normalizeLab(state.selectedLab ?? []),
        } as MetaState;
      },
    },
  ),
);

export const metaSnapshot = (m: MetaState): MetaSnapshot => {
  const medals = Object.values(m.trialBest);
  return {
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
    goldTrials: medals.filter((t) => t.medal === "gold" || t.medal === "author").length,
    authorTrials: medals.filter((t) => t.medal === "author").length,
    peakRating: m.peakRating,
    questsCompleted: m.questsCompleted,
    sprintsFinished: m.sprintsFinished,
    bestHeatCleared: m.bestHeatCleared,
  };
};
