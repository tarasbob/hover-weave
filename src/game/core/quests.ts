/**
 * Skill-shaped daily quests (roadmap 4.5): three rotating challenges rolled
 * deterministically from the daily key, layered on the daily seed. Every
 * template is a skill expression completable in a single good run — never a
 * time-shaped chore ("play N times" does not exist here).
 *
 * Progress reads the live run (stats + a few event-only counters the tracker
 * feeds); completion is checked mid-run so a quest banks the moment it is
 * earned, even if the run ends on the next wall.
 */

import { FLOW } from "./constants";
import { createRng, type Rng } from "./rng";
import type { RunStats } from "./world";

/** Event-only signals the quest tracker counts during a run. */
export interface QuestCounters {
  /** Risk-route (non-magnetic) shards collected. */
  riskShards: number;
  /** Perfect passes landed above the template's speed bar. */
  fastPerfects: number;
}

export interface QuestSample {
  stats: RunStats;
  counters: QuestCounters;
}

export interface QuestDef {
  /** Template id + params, e.g. "threads:3" (stable across the day). */
  id: string;
  label: string;
  target: number;
  progress(sample: QuestSample): number;
  /** Speed bar (m/s) for the fast-perfect template (tracker needs it). */
  speedBar?: number;
}

interface QuestTemplate {
  id: string;
  roll(rng: Rng): QuestDef;
}

const count = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`;

const TEMPLATES: QuestTemplate[] = [
  {
    id: "threads",
    roll(rng) {
      const n = rng.pick([2, 3, 4]);
      return {
        id: `threads:${n}`,
        label: `Thread the needle ${count(n, "time")} in one run`,
        target: n,
        progress: (s) => s.stats.threads,
      };
    },
  },
  {
    id: "perfects",
    roll(rng) {
      const n = rng.pick([6, 9, 12]);
      return {
        id: `perfects:${n}`,
        label: `Land ${n} perfect passes in one run`,
        target: n,
        progress: (s) => s.stats.perfectPasses,
      };
    },
  },
  {
    id: "flowMult",
    roll(rng) {
      const n = rng.pick([5, 7, 9]);
      return {
        id: `flowMult:${n}`,
        label: `Reach a ×${n} score multiplier`,
        target: n,
        progress: (s) => 1 + s.stats.maxFlowPoints * FLOW.MULT_PER_POINT,
      };
    },
  },
  {
    id: "chain",
    roll(rng) {
      const n = rng.pick([8, 10, 12]);
      return {
        id: `chain:${n}`,
        label: `Build a ${n}-pass flow chain`,
        target: n,
        progress: (s) => s.stats.bestFlowChain,
      };
    },
  },
  {
    id: "shardCombo",
    roll(rng) {
      const n = rng.pick([5, 6, 8]);
      return {
        id: `shardCombo:${n}`,
        label: `Chain a ×${n} shard combo`,
        target: n,
        progress: (s) => s.stats.bestShardCombo,
      };
    },
  },
  {
    id: "riskShards",
    roll(rng) {
      const n = rng.pick([3, 4, 6]);
      return {
        id: `riskShards:${n}`,
        label: `Collect ${count(n, "risk shard")} in one run`,
        target: n,
        progress: (s) => s.counters.riskShards,
      };
    },
  },
  {
    id: "boostTime",
    roll(rng) {
      const n = rng.pick([20, 30, 45]);
      return {
        id: `boostTime:${n}`,
        label: `Spend ${n}s boosting in one run`,
        target: n,
        progress: (s) => s.stats.boostTime,
      };
    },
  },
  {
    id: "fastPerfect",
    roll(rng) {
      const kmh = rng.pick([220, 250, 280]);
      const n = rng.pick([1, 2]);
      return {
        id: `fastPerfect:${kmh}:${n}`,
        label: `Land ${count(n, "perfect pass", "perfect passes")} above ${kmh} km/h`,
        target: n,
        progress: (s) => s.counters.fastPerfects,
        speedBar: kmh / 3.6,
      };
    },
  },
  {
    id: "gradeSections",
    roll(rng) {
      const n = rng.pick([2, 3, 4]);
      return {
        id: `gradeSections:${n}`,
        label: `Grade A or better on ${count(n, "section")} in one run`,
        target: n,
        progress: (s) =>
          s.stats.sections.filter((sec) => sec.grade === "A" || sec.grade === "S").length,
      };
    },
  },
  {
    id: "boostedS",
    roll(rng) {
      void rng;
      return {
        id: "boostedS",
        label: "S-grade a section while boosting through half of it",
        target: 1,
        progress: (s) =>
          s.stats.sections.filter((sec) => sec.grade === "S" && sec.boostUptime >= 0.5).length,
      };
    },
  },
];

export const QUESTS_PER_DAY = 3;

/** The day's quest set — same for every player, same all day. */
export function questsForDay(dayKey: string): QuestDef[] {
  const rng = createRng(`cubefield-quests-${dayKey}`);
  const pool = [...TEMPLATES];
  const quests: QuestDef[] = [];
  for (let i = 0; i < QUESTS_PER_DAY && pool.length > 0; i++) {
    const idx = rng.int(0, pool.length - 1);
    quests.push(pool[idx].roll(rng));
    pool.splice(idx, 1);
  }
  return quests;
}
