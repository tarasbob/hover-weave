/** Minimal typed event emitter used to decouple sim -> audio/fx/ui. */

import type { RunConfig } from "./modes";
import type {
  LandingGrade,
  MotionType,
  ObstacleKind,
  PatternSkill,
  PrecisionGrade,
  RouteReward,
  RunEventKind,
} from "./types";

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
    y: number;
    s: number;
    speed: number;
    latVel: number;
    vy: number;
    bank: number;
    cause: "obstacle" | "edge";
    edge?: -1 | 1;
    patternId: string;
    obstacleKind: ObstacleKind | null;
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
  /** A carve pump landed (lab prototype, fun-frontier 1.2). */
  pump: {
    dir: number;
    x: number;
    /** 0..1 — how much of the glide envelope the pump reached. */
    strength: number;
    /** Reserved for historical wall-kiss telemetry; current pumps are false. */
    wall: boolean;
  };
  /** The craft crossed one authored branch in a strategic fork. */
  routeChoice: {
    decisionId: string;
    routeId: string;
    label: string;
    reward: RouteReward;
    s: number;
  };
  /** A challenge phrase entered the speed-scaled preview horizon. */
  patternAhead: {
    patternId: string;
    skills: PatternSkill[];
    lead: number;
  };
  /** One of the rare 20/40/80 km presentation layers was reached. */
  mythic: { depth: number; name: string; index: number };
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
  /** The craft left a skyhook ramp lip (fun-frontier 6.1). */
  launch: { x: number; s: number; vy: number; boosted: boolean };
  /** A mid-air double jump fired (fun-frontier 6.2). */
  airJump: {
    x: number;
    s: number;
    y: number;
    /** Post-impulse upward velocity (m/s). */
    vy: number;
    /** 0..1 timing quality — 1 exactly at the apex. */
    quality: number;
  };
  /** Airborne touchdown, graded by impact velocity and flare quality. */
  land: {
    x: number;
    s: number;
    grade: LandingGrade;
    /** |vy| at touchdown (m/s). */
    impact: number;
    /** 0..1 flare timing quality (0 = no flare). */
    flare: number;
    airTime: number;
    /** Perfect landing confirmed on the beat grid. */
    resonant: boolean;
    scoreAward: number;
    energyAward: number;
  };
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
