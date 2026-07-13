"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ghostKey, type GameMode } from "../core/modes";
import { ghostEligible, type RunRecording } from "../core/replay";

/** Keep at most this many recordings per rolling-period prefix (most recent). */
const PERIOD_KEEP = 3;

// Version match, complete stream, no lab stack (lab runs never persist).
const valid = ghostEligible;

/** Trials race for distance; every other mode races for score. */
const beats = (rec: RunRecording, prev: RunRecording | undefined): boolean => {
  if (!valid(prev)) return true;
  return rec.mode === "trial" ? rec.distance > prev.distance : rec.score > prev.score;
};

interface ReplaysState {
  /**
   * Best recording per run identity — the PB ghosts. Keys from `ghostKey`:
   * "endless", "daily:<day>", "sprint:<week>", "trial:<id>".
   */
  best: Record<string, RunRecording>;
  /** Most recent finished run (dev/debug: re-sim from the console). */
  lastRun: RunRecording | null;
  recordRun(rec: RunRecording, periodKey: string | null): void;
  ghostFor(mode: GameMode, periodKey: string | null, trialId?: string | null): RunRecording | null;
}

/** Drop all but the newest PERIOD_KEEP entries under a rolling-key prefix. */
function prunePeriod(best: Record<string, RunRecording>, prefix: string): void {
  const keys = Object.keys(best)
    .filter((k) => k.startsWith(prefix))
    .sort()
    .reverse();
  for (const stale of keys.slice(PERIOD_KEEP)) delete best[stale];
}

export const useReplays = create<ReplaysState>()(
  persist(
    (set, get) => ({
      best: {},
      lastRun: null,

      recordRun(rec, periodKey) {
        if (!valid(rec)) {
          set({ lastRun: rec ?? null });
          return;
        }
        const s = get();
        const key = ghostKey(rec.mode, periodKey, rec.trialId ?? null);
        if (!beats(rec, s.best[key])) {
          set({ lastRun: rec });
          return;
        }
        const best = { ...s.best, [key]: rec };
        prunePeriod(best, "daily:");
        prunePeriod(best, "sprint:");
        set({ best, lastRun: rec });
      },

      ghostFor(mode, periodKey, trialId = null) {
        const rec = get().best[ghostKey(mode, periodKey, trialId)];
        return valid(rec) ? rec : null;
      },
    }),
    {
      name: "cubefield:replays",
      version: 2,
      migrate: (persisted, version) => {
        // v1 shape: { bestEndless, bestDaily: Record<day, rec> }, recordings
        // carried a `daily` flag instead of a mode. Endless/daily sim paths
        // are bit-identical since the mode split, so old ghosts stay valid —
        // they just move to the unified key space.
        type V1Recording = Omit<RunRecording, "mode"> & { daily?: boolean; mode?: GameMode };
        const revive = (rec: V1Recording | null | undefined): RunRecording | null => {
          if (!rec) return null;
          const mode: GameMode = rec.mode ?? (rec.daily ? "daily" : "endless");
          const upgraded: RunRecording & { daily?: boolean } = { ...rec, mode };
          delete upgraded.daily;
          return valid(upgraded) ? upgraded : null;
        };

        const best: Record<string, RunRecording> = {};
        if (version < 2) {
          const old = persisted as {
            bestEndless?: V1Recording | null;
            bestDaily?: Record<string, V1Recording>;
          };
          const endless = revive(old.bestEndless);
          if (endless) best[ghostKey("endless", null)] = endless;
          for (const [day, rec] of Object.entries(old.bestDaily ?? {})) {
            const upgraded = revive(rec);
            if (upgraded) best[ghostKey("daily", day)] = upgraded;
          }
        } else {
          const cur = persisted as Partial<ReplaysState>;
          for (const [key, rec] of Object.entries(cur.best ?? {})) {
            if (valid(rec)) best[key] = rec;
          }
        }
        return { best, lastRun: null } as ReplaysState;
      },
    },
  ),
);
