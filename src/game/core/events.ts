/** Minimal typed event emitter used to decouple sim -> audio/fx/ui. */

import type { RunConfig } from "./modes";
import type { MotionType, ObstacleKind, PrecisionGrade, RunEventKind } from "./types";

export type GameEvents = {
  nearMiss: {
    x: number;
    s: number;
    clearance: number;
    precision: number;
    grade: PrecisionGrade;
    chain: number;
    scoreAward: number;
    energyAward: number;
    flowPoints: number;
    /** Perfect confirmed on the beat grid (lab prototype 5.4). */
    resonant: boolean;
  };
  /** Both sides of a gap passed tight within a short window. */
  thread: {
    x: number;
    s: number;
    scoreAward: number;
    /** 0..1 — how tight the worse side of the pair was. */
    tightness: number;
    /** Total threads this run (for escalating feedback). */
    count: number;
  };
  shard: {
    x: number;
    y: number;
    combo: number;
    scoreAward: number;
    energyAward: number;
    risk: boolean;
  };
  shieldPickup: { x: number };
  shieldBreak: { x: number };
  death: {
    x: number;
    speed: number;
    patternId: string;
    obstacleKind: ObstacleKind;
    motion: MotionType;
  };
  /** A time-limited run (sprint) reached its horizon alive (roadmap 4.2). */
  finish: { score: number; distance: number };
  boostStart: undefined;
  boostEnd: undefined;
  /** A free-boost surge window opened (lab prototype, roadmap 5.1). */
  surge: { window: number };
  /** A phase dash fired (lab prototype, roadmap 5.3). */
  dash: { dir: number; x: number };
  flowTier: { tier: number; prev: number };
  /** A graded chunk was fully traversed (roadmap 3.4). */
  sectionGrade: {
    patternId: string;
    intensity: number;
    grade: "S" | "A" | "B" | "C";
    composite: number;
  };
  biome: { index: number; name: string };
  lightning: { intensity: number };
  setpiece: { name: string };
  runStart: { config: RunConfig };
  slabFall: { x: number; s: number };
  /** A glass pane smashed through while boosting. */
  shatter: {
    x: number;
    y: number;
    s: number;
    hx: number;
    hy: number;
    scoreAward: number;
    energyAward: number;
  };
  /** A bumper flung the craft sideways (dir = ±1). */
  bounce: { x: number; s: number; dir: number; scoreAward: number };
  /** A pulse beam near ahead of the craft switched ON. */
  beamFire: { x: number; s: number };
  /** A global run event began (meteor barrage, golden rush, ...). */
  runEvent: { kind: RunEventKind; name: string };
};

type Handler<T> = (payload: T) => void;

export class Emitter {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) (fn as Handler<GameEvents[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
