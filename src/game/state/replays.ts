"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { REPLAY_VERSION, type RunRecording } from "../core/replay";
import type { GameMode } from "./game";

/** Keep at most this many daily-ghost recordings (most recent days). */
const DAILY_KEEP = 3;

const valid = (rec: RunRecording | null | undefined): rec is RunRecording =>
  Boolean(rec && rec.v === REPLAY_VERSION && rec.complete && rec.steps > 0);

interface ReplaysState {
  /** Best endless run ever (by score) — the cross-seed pace ghost. */
  bestEndless: RunRecording | null;
  /** Best run per daily key — the true spatial ghost. */
  bestDaily: Record<string, RunRecording>;
  /** Most recent finished run (dev/debug: re-sim from the console). */
  lastRun: RunRecording | null;
  recordRun(rec: RunRecording, dailyKey: string | null): void;
  ghostFor(mode: GameMode, dailyKey: string): RunRecording | null;
}

export const useReplays = create<ReplaysState>()(
  persist(
    (set, get) => ({
      bestEndless: null,
      bestDaily: {},
      lastRun: null,

      recordRun(rec, dailyKey) {
        if (!valid(rec)) {
          set({ lastRun: rec ?? null });
          return;
        }
        const s = get();
        const next: Partial<ReplaysState> = { lastRun: rec };
        if (dailyKey) {
          const prev = s.bestDaily[dailyKey];
          if (!valid(prev) || rec.score > prev.score) {
            const bestDaily = { ...s.bestDaily, [dailyKey]: rec };
            const keys = Object.keys(bestDaily).sort().reverse();
            for (const stale of keys.slice(DAILY_KEEP)) delete bestDaily[stale];
            next.bestDaily = bestDaily;
          }
        } else if (!valid(s.bestEndless) || rec.score > s.bestEndless.score) {
          next.bestEndless = rec;
        }
        set(next);
      },

      ghostFor(mode, dailyKey) {
        const s = get();
        const rec = mode === "daily" ? s.bestDaily[dailyKey] : s.bestEndless;
        return valid(rec) ? rec : null;
      },
    }),
    {
      name: "cubefield:replays",
      version: 1,
      migrate: (persisted) => {
        // Recordings from an incompatible sim version are useless — drop them.
        const state = persisted as Partial<ReplaysState>;
        const bestDaily: Record<string, RunRecording> = {};
        for (const [key, rec] of Object.entries(state.bestDaily ?? {})) {
          if (valid(rec)) bestDaily[key] = rec;
        }
        return {
          ...state,
          bestEndless: valid(state.bestEndless) ? state.bestEndless : null,
          bestDaily,
          lastRun: null,
        } as ReplaysState;
      },
    },
  ),
);
