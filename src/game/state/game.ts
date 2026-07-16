"use client";

import { create } from "zustand";
import { ENERGY } from "../core/constants";
import type { LabId } from "../core/lab";
import type { GameMode } from "../core/modes";
import type { PatternSkill } from "../core/types";
import type { DeathForensics, RunStats, SectionGrade } from "../core/world";
import type { Medal } from "../track/trials";

export type GamePhase = "boot" | "title" | "running" | "paused" | "dead";
export type { GameMode };
export type FlightLessonStep = "steer" | "graze" | "boost" | "rhythm";

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
  /** Quiet mode-aware target line, e.g. "PB IN 4,120" / "GOLD IN 214 m". */
  objective: string | null;
  /** Replaces the objective once cleared, e.g. "NEW PERSONAL BEST". */
  objectiveHit: string | null;
  /** Sim seconds left on a time-limited run (sprint). Null = untimed. */
  timeLeft: number | null;
  /** Active heat score multiplier (1 = no heat). */
  heatMult: number;
  /** Active lab prototype stack (empty = plain run). */
  lab: LabId[];
  /** True while a free-boost surge window is open (lab 5.1). */
  surge: boolean;
  /** Dash cooldown remaining in seconds; 0 = ready, null = dash flag off. */
  dash: number | null;
  /** Live meters ahead (+) / behind (−) the PB ghost. Null = no ghost armed. */
  ghostDelta: number | null;
}

export interface SkillMoment {
  text: string;
  detail: string;
  tone: "close" | "razor" | "perfect" | "shard" | "thread";
  at: number;
}

export interface RunOutcome {
  stats: RunStats;
  /** True when the run survived a time-limited horizon (sprint finish). */
  finished: boolean;
  /** Imported rival flight: unranked practice, nothing persisted. */
  rival: boolean;
  newBestScore: boolean;
  newBestDistance: boolean;
  newDailyBest: boolean;
  newSprintBest: boolean;
  newTrialBest: boolean;
  /** Medal earned this run (trials only). */
  medal: Medal | null;
  /** Fixed-seed trial rating movement (null for open-track modes). */
  ratingDelta: number | null;
  /** Mode-aware: vs. global PB (endless/daily) or the weekly best (sprint). */
  scoreDelta: number;
  /** Meters short of the relevant best distance (negative = new farthest). */
  distanceDelta: number;
  /** Consecutive runs ended by this same pattern (1 = first time). */
  deathStreak: number;
  forensics: DeathForensics | null;
  unlocked: { kind: "craft" | "trail"; id: string; name: string }[];
}

export interface SectionGradeToast {
  grade: SectionGrade;
  patternId: string;
  at: number;
}

export interface AheadCue {
  patternId: string;
  skills: PatternSkill[];
  lead: number;
  at: number;
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
  /** Active trial roster id (mode === "trial" only). */
  trialId: string | null;
  hud: HudSnapshot;
  outcome: RunOutcome | null;
  /** Set-piece / biome callout toast. */
  callout: { text: string; sub?: string; at: number } | null;
  skillMoment: SkillMoment | null;
  sectionGrade: SectionGradeToast | null;
  aheadCue: AheadCue | null;
  /** First-flight lesson currently being taught; null after graduation. */
  lesson: FlightLessonStep | null;
  overlay: "none" | "hangar" | "settings" | "help" | "trials" | "heat" | "lab";
  webgpu: boolean | null;
  fps: number;
  graphics: GraphicsStats;
  setPhase(p: GamePhase): void;
  setMode(m: GameMode, trialId?: string | null): void;
  setHud(h: HudSnapshot): void;
  setOutcome(o: RunOutcome | null): void;
  setCallout(text: string, sub?: string): void;
  setSkillMoment(text: string, detail: string, tone: SkillMoment["tone"]): void;
  setSectionGrade(grade: SectionGrade, patternId: string): void;
  setAheadCue(patternId: string, skills: PatternSkill[], lead: number): void;
  setLesson(step: FlightLessonStep | null): void;
  clearRunFeedback(): void;
  setOverlay(o: GameState["overlay"]): void;
  setWebgpu(v: boolean): void;
  setFps(v: number): void;
  setGraphics(v: Partial<GraphicsStats>): void;
}

export const useGame = create<GameState>((set) => ({
  phase: "boot",
  mode: "endless",
  trialId: null,
  hud: {
    score: 0, multiplier: 1, flowTier: 0, flowFrac: 0,
    flowGrace: 1, flowChain: 0, shardCombo: 0,
    energy: ENERGY.START, boosting: false, shield: false,
    speedKmh: 0, distance: 0, biome: "Crystal Desert",
    objective: null, objectiveHit: null, timeLeft: null, heatMult: 1,
    lab: [], surge: false, dash: null,
    ghostDelta: null,
  },
  outcome: null,
  callout: null,
  skillMoment: null,
  sectionGrade: null,
  aheadCue: null,
  lesson: null,
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
  setMode: (mode, trialId = null) => set({ mode, trialId }),
  setHud: (hud) => set({ hud }),
  setOutcome: (outcome) => set({ outcome }),
  setCallout: (text, sub) => set({ callout: { text, sub, at: Date.now() } }),
  setSkillMoment: (text, detail, tone) =>
    set({ skillMoment: { text, detail, tone, at: Date.now() } }),
  setSectionGrade: (grade, patternId) =>
    set({ sectionGrade: { grade, patternId, at: Date.now() } }),
  setAheadCue: (patternId, skills, lead) =>
    set({ aheadCue: { patternId, skills, lead, at: Date.now() } }),
  setLesson: (lesson) => set({ lesson }),
  clearRunFeedback: () =>
    set({
      callout: null,
      skillMoment: null,
      sectionGrade: null,
      aheadCue: null,
      lesson: null,
    }),
  setOverlay: (overlay) => set({ overlay }),
  setWebgpu: (webgpu) => set({ webgpu }),
  setFps: (fps) => set({ fps }),
  setGraphics: (graphics) =>
    set((state) => ({ graphics: { ...state.graphics, ...graphics } })),
}));
