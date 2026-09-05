/** Trusted, append-only course policy. Never construct this from an upload. */
import { createHash } from "node:crypto";
import type { HeatId } from "../core/heat";
import type { GameMode, RunConfig } from "../core/modes";
import { REPLAY_VERSION } from "../core/replay";
import { trialById } from "../track/trials";

export const VERIFIER_VERSION = 1;
export const SIMULATION_VERSION = "hover-weave-v8-r1";
export const VERIFICATION_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  rleNumbers: 240_000,
  steps: 120 * 60 * 20,
  wallTimeMs: 20_000,
  heapMb: 256,
});

export interface CompetitionCourse {
  readonly id: string;
  readonly revision: number;
  readonly mode: GameMode;
  readonly seed: string;
  readonly trialId?: string;
  readonly heat: readonly HeatId[];
  readonly maxSteps: number;
}

export interface CompetitionSeason {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly replayVersion: number;
  readonly simulationVersion: string;
  /** Server receipt time, inclusive opening and exclusive closing. */
  readonly opensAt: number;
  readonly closesAt: number;
  readonly courses: readonly CompetitionCourse[];
}

// Explicit roster: adding a trial later must not silently change this season.
const trialIds = [
  "slalomGates", "sCurveCanyon", "narrowGates", "combTeeth", "pendulumAlley",
  "pistonCorridor", "bladeRotors", "precisionLadder", "chaosField",
  "splitDecision", "weaverCircuit",
] as const;

function course(value: Omit<CompetitionCourse, "revision" | "heat" | "maxSteps"> &
  Partial<Pick<CompetitionCourse, "heat" | "maxSteps">>): CompetitionCourse {
  return Object.freeze({
    ...value,
    revision: 1,
    heat: Object.freeze([...(value.heat ?? [])]),
    maxSteps: value.maxSteps ?? VERIFICATION_LIMITS.steps,
  });
}

/** Preview policy exercises the verifier; it does not create a live league. */
export const COMPETITION_SEASONS: readonly CompetitionSeason[] = Object.freeze([
  Object.freeze({
    id: "2026-preview",
    revision: 1,
    label: "2026 verification preview",
    replayVersion: 7,
    simulationVersion: "hover-weave-v7-r1",
    opensAt: Date.UTC(2026, 0, 1),
    closesAt: Date.UTC(2027, 0, 1),
    courses: Object.freeze([
      ...trialIds.map((trialId) => course({
        id: `trial-${trialId}`,
        mode: "trial",
        seed: `cubefield-trial-${trialId}`,
        trialId,
      })),
      course({ id: "daily-2026-09-05", mode: "daily", seed: "cubefield-daily-2026-09-05" }),
      course({ id: "sprint-2026-w36", mode: "sprint", seed: "cubefield-sprint-2026-W36", maxSteps: 120 * 180 }),
      course({ id: "endless-reference", mode: "endless", seed: "test-3" }),
      course({ id: "heat-reference", mode: "endless", seed: "world-contract", heat: ["denseField", "fastMovers"] }),
    ]),
  }),
  Object.freeze({
    id: "2026-preview-v8",
    revision: 1,
    label: "2026 curved-course verification preview",
    replayVersion: 8,
    simulationVersion: "hover-weave-v8-r1",
    opensAt: Date.UTC(2026, 8, 5),
    closesAt: Date.UTC(2027, 0, 1),
    courses: Object.freeze([
      ...trialIds.map((trialId) => course({
        id: `trial-${trialId}`,
        mode: "trial",
        seed: `cubefield-trial-${trialId}`,
        trialId,
      })),
      course({ id: "daily-2026-09-05", mode: "daily", seed: "cubefield-daily-2026-09-05" }),
      course({ id: "sprint-2026-w36", mode: "sprint", seed: "cubefield-sprint-2026-W36", maxSteps: 120 * 180 }),
      course({ id: "endless-reference", mode: "endless", seed: "test-3" }),
      course({ id: "heat-reference", mode: "endless", seed: "world-contract", heat: ["denseField", "fastMovers"] }),
    ]),
  }),
]);

export interface CompetitionSelection {
  seasonId: string;
  courseId: string;
}

/** This digest is the future leaderboard partition, never a local PB key. */
export function competitionCourseKey(season: CompetitionSeason, selected: CompetitionCourse): string {
  const canonical = JSON.stringify([
    "hover-weave-course", season.id, season.revision, season.simulationVersion,
    season.replayVersion, selected.id, selected.revision, selected.mode,
    selected.seed, selected.trialId ?? null, [...selected.heat].sort(), [], selected.maxSteps,
  ]);
  return `hwc1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function selectCompetitionCourse(selection: CompetitionSelection): {
  season: CompetitionSeason;
  course: CompetitionCourse;
  courseKey: string;
} {
  const season = COMPETITION_SEASONS.find((item) => item.id === selection.seasonId);
  if (!season) throw new Error("Unknown season");
  if (season.replayVersion !== REPLAY_VERSION || season.simulationVersion !== SIMULATION_VERSION) {
    throw new Error("Season requires a different archived simulation build");
  }
  const selected = season.courses.find((item) => item.id === selection.courseId);
  if (!selected) throw new Error("Unknown course in this season");
  if (selected.trialId && !trialById(selected.trialId)) throw new Error("Season trial is unavailable");
  return { season, course: selected, courseKey: competitionCourseKey(season, selected) };
}

export function competitionRunConfig(selected: CompetitionCourse): RunConfig {
  return {
    mode: selected.mode,
    seed: selected.seed,
    ...(selected.trialId ? { trialId: selected.trialId } : {}),
    ...(selected.heat.length ? { heat: [...selected.heat] } : {}),
  };
}
