import type { GameMode, RunConfig } from "./modes";
import { dailyKey, dailySeed, randomSeed, weeklyKey, weeklySeed } from "./rng";
import { trialSeed } from "../track/trials";

/** Launch identity shared by results, quests, HUD objectives, and PB ghosts. */
export interface RunSession {
  config: RunConfig;
  /** Captured at launch, so crossing a UTC boundary never moves a result. */
  periodKey: string | null;
}

/**
 * Derive seed and period from one instant. Endless always draws a fresh seed;
 * daily, sprint, and trial launches deliberately repeat their current course.
 */
export function createRunSession(
  mode: GameMode,
  trialId?: string,
  at = new Date(),
): RunSession {
  if (mode === "daily") {
    return { config: { mode, seed: dailySeed(at) }, periodKey: dailyKey(at) };
  }
  if (mode === "sprint") {
    return { config: { mode, seed: weeklySeed(at) }, periodKey: weeklyKey(at) };
  }
  if (mode === "trial") {
    return { config: { mode, seed: trialSeed(trialId ?? ""), trialId }, periodKey: null };
  }
  return { config: { mode, seed: randomSeed() }, periodKey: null };
}

/** Retry the launched course; only free flight draws a new course on restart. */
export function retryRunSession(session: RunSession): RunSession {
  if (!session.config.seed || session.config.mode === "endless") {
    return createRunSession("endless");
  }
  return { config: { ...session.config }, periodKey: session.periodKey };
}
