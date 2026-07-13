/**
 * Run identity (roadmap Phase 4). A run is fully described by its RunConfig:
 * the sim, the generator, recordings, ghosts, and PB storage all key off it.
 * Pure module — safe to import from sim, state, and UI layers alike.
 */

import type { HeatId } from "./heat";

export type GameMode = "endless" | "daily" | "sprint" | "trial";

export interface RunConfig {
  mode: GameMode;
  seed: string;
  /** Trial roster id (mode === "trial" only). */
  trialId?: string;
  /** Opt-in heat modifier stack (endless only; roadmap 4.3). */
  heat?: HeatId[];
  /** Dev/testing: spawn deep into the run (endless only; disables recording). */
  skipTo?: number;
}

/**
 * Storage key a run's PB recording/ghost lives under. Period key is the UTC
 * day for daily and the ISO week for sprint (captured at run start, so a run
 * crossing midnight stays attached to the seed it was launched with).
 */
export function ghostKey(
  mode: GameMode,
  periodKey: string | null,
  trialId?: string | null,
): string {
  switch (mode) {
    case "endless":
      return "endless";
    case "daily":
      return `daily:${periodKey}`;
    case "sprint":
      return `sprint:${periodKey}`;
    case "trial":
      return `trial:${trialId}`;
  }
}

export const MODE_LABELS: Record<GameMode, string> = {
  endless: "ENDLESS",
  daily: "DAILY COURSE",
  sprint: "SPRINT",
  trial: "TRIAL",
};
