/** Bounded run history, section grading and crash analysis. No rendering state. */
import { CRAFT, FLOW } from "../constants";
import type { Emitter } from "../events";
import { clamp01 } from "../mathUtils";
import type { Obstacle, RunStatus } from "../types";
import type { Course } from "../../track/course";
import type { GeneratedChunk } from "../../track/generator";
import type {
  ChunkRecord, DeathForensics, ForensicsObstacle, RunStats,
  SectionGrade, SectionMetrics, TraceSample,
} from "./runStats";

/**
 * Grade a traversed chunk. Precision demand scales with the chunk's authored
 * intensity, pace pays for holding boost through it, flow uptime for keeping
 * the meter alive — an edge-hugging cruise grades C, a threaded boost line S.
 */
export function gradeSection(m: SectionMetrics): {
  grade: SectionGrade;
  composite: number;
  precision: number;
  pace: number;
} {
  const eventRate = (m.events / Math.max(1, m.traversed)) * 100;
  const precision = clamp01(eventRate / (1.1 * Math.max(1, m.intensity)));
  const pace = clamp01((m.avgSpeed / Math.max(1, m.baseSpeed) - 0.92) / 0.5);
  const composite = 0.45 * precision + 0.3 * m.flowUptime + 0.25 * pace;
  const grade: SectionGrade =
    composite >= 0.8 ? "S" : composite >= 0.55 ? "A" : composite >= 0.3 ? "B" : "C";
  return { grade, composite, precision, pace };
}

/** Sections below this intensity are transit, not tests — never graded. */
export const GRADE_MIN_INTENSITY = 2;

export const TRACE_OPEN_CLEARANCE = 99;
const TRACE_EVERY_STEPS = 4; // 120 Hz sim -> 30 Hz trace.
const TRACE_CAP = 1024;

interface AnalysisState {
  readonly distance: number;
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly flowPoints: number;
  readonly boosting: boolean;
  readonly status: RunStatus;
  readonly deathX: number;
  readonly deathSpeed: number;
  readonly course: Course;
  readonly obstacles: readonly Obstacle[];
  readonly stats: RunStats;
  readonly events: Emitter;
}

/** Owns history buffers; SimWorld decides exactly when each tick is sampled. */
export class RunAnalysis {
  readonly chunks: ChunkRecord[] = [];
  private readonly traceRing: TraceSample[] = [];
  private traceIdx = 0;
  /** Envelopes of recently recycled obstacles — the kill-cam window reaches
   *  well past DESPAWN_BEHIND, so the field behind the craft must be kept. */
  private readonly recentObstacles: ForensicsObstacle[] = [];
  private stepCounter = 0;
  /** Tightest hull clearance seen since the last trace sample. */
  private sampleClearance = Infinity;
  private section: {
    s0: number;
    s1: number;
    patternId: string;
    intensity: number;
    enteredAt: number;
    steps: number;
    flowSteps: number;
    boostSteps: number;
    speedSum: number;
    events: number;
  } | null = null;

  constructor(
    private readonly state: AnalysisState,
    private readonly speedAt: (s: number) => number,
  ) {}

  reset(): void {
    this.chunks.length = 0;
    this.traceRing.length = 0;
    this.traceIdx = 0;
    this.recentObstacles.length = 0;
    this.stepCounter = 0;
    this.sampleClearance = Infinity;
    this.section = null;
  }

  recordChunk(chunk: GeneratedChunk): void {
    // Always-on lightweight chunk record: section grading needs the bounds
    // and intensity, the kill-cam needs the validator's solved path — keep
    // enough behind the craft to cover the forensics window. Paths are
    // authored in the straight local frame; store them in world frame.
    this.chunks.push({
      s0: chunk.s0,
      s1: chunk.s1,
      patternId: chunk.patternId,
      intensity: chunk.intensity,
      skills: chunk.skills,
      path: this.state.course.flat
        ? chunk.path
        : chunk.path.map(([s, x]) => [s, x + this.state.course.offsetAt(s)] as [number, number]),
    });
    while (
      this.chunks.length > 64 ||
      (this.chunks.length > 0 && this.chunks[0].s1 < this.state.distance - 380)
    ) {
      this.chunks.shift();
    }
  }

  /** Called before returning an obstacle's slot to the pool. */
  rememberObstacle(o: Obstacle): void {
    // Keep the envelope around for the kill-cam: its window reaches far
    // past the recycling line.
    if (o.collidable && o.kind !== "decor" && o.kind !== "ramp") {
      const vHalf = o.kind === "ring" ? o.hx : o.hy;
      if (o.cy - vHalf < CRAFT.Y_MAX && o.cy + vHalf > CRAFT.Y_MIN) {
        this.recentObstacles.push({
          kind: o.kind, s: o.cs, x: o.cx,
          hx: o.hx, hs: o.hs, yaw: o.cyaw, inner: o.inner,
        });
        while (
          this.recentObstacles.length > 600 ||
          (this.recentObstacles.length > 0 &&
            this.recentObstacles[0].s < this.state.distance - 380)
        ) {
          this.recentObstacles.shift();
        }
      }
    }
  }

  observeClearance(clearance: number): void {
    if (clearance < this.sampleClearance) this.sampleClearance = clearance;
  }

  notePrecision(weight = 1): void {
    if (this.section) this.section.events += weight;
  }

  sampleStep(): void {
    this.stepCounter++;
    if (this.stepCounter % TRACE_EVERY_STEPS === 0) this.pushTrace();
  }

  /** Enter/exit chunk sections as the craft crosses them; accumulate metrics. */
  updateSection(): void {
    const d = this.state.distance;
    if (this.section && d > this.section.s1) this.finalizeSection();
    if (!this.section) {
      for (const c of this.chunks) {
        if (c.s0 > d) break; // chunkLog is in track order
        if (d >= c.s0 && d <= c.s1) {
          this.section = {
            s0: c.s0, s1: c.s1, patternId: c.patternId, intensity: c.intensity,
            enteredAt: d, steps: 0, flowSteps: 0, boostSteps: 0, speedSum: 0, events: 0,
          };
          break;
        }
      }
    }
    const sec = this.section;
    if (sec) {
      sec.steps++;
      sec.speedSum += this.state.speed;
      if (this.state.flowPoints >= FLOW.POINTS_PER_TIER) sec.flowSteps++;
      if (this.state.boosting) sec.boostSteps++;
    }
  }

  finalizeSection(): void {
    const sec = this.section;
    this.section = null;
    if (!sec || sec.steps < 30) return; // Sub-quarter-second slivers are noise.
    const traversed = Math.min(this.state.distance, sec.s1) - sec.enteredAt;
    if (traversed < 20) return;
    const flowUptime = sec.flowSteps / sec.steps;
    const { grade, composite, pace } = gradeSection({
      intensity: sec.intensity,
      events: sec.events,
      traversed,
      flowUptime,
      avgSpeed: sec.speedSum / sec.steps,
      baseSpeed: this.speedAt((sec.s0 + sec.s1) / 2),
    });
    this.state.stats.sections.push({
      patternId: sec.patternId, intensity: sec.intensity,
      s0: sec.s0, s1: sec.s1,
      grade, composite, events: sec.events, flowUptime,
      boostUptime: sec.boostSteps / sec.steps, pace,
    });
    if (sec.intensity >= GRADE_MIN_INTENSITY) {
      this.state.events.emit("sectionGrade", {
        patternId: sec.patternId, intensity: sec.intensity, grade, composite,
      });
    }
  }

  computeLineRating(): SectionGrade | null {
    const graded = this.state.stats.sections.filter((s) => s.intensity >= GRADE_MIN_INTENSITY);
    if (graded.length === 0) return null;
    let weight = 0;
    let sum = 0;
    for (const s of graded) {
      weight += s.intensity;
      sum += s.composite * s.intensity;
    }
    const c = sum / weight;
    return c >= 0.8 ? "S" : c >= 0.55 ? "A" : c >= 0.3 ? "B" : "C";
  }

  pushTrace(): void {
    const sample: TraceSample = {
      s: this.state.distance,
      x: this.state.x,
      y: this.state.y,
      speed: this.state.speed,
      flow: this.state.flowPoints,
      clearance: Math.min(this.sampleClearance, TRACE_OPEN_CLEARANCE),
    };
    if (this.traceRing.length < TRACE_CAP) {
      this.traceRing.push(sample);
    } else {
      this.traceRing[this.traceIdx] = sample;
      this.traceIdx = (this.traceIdx + 1) % TRACE_CAP;
    }
    this.sampleClearance = Infinity;
  }

  /** Trace samples in chronological order. */
  getTrace(): TraceSample[] {
    if (this.traceRing.length < TRACE_CAP) return [...this.traceRing];
    return [
      ...this.traceRing.slice(this.traceIdx),
      ...this.traceRing.slice(0, this.traceIdx),
    ];
  }

  /**
   * Snapshot everything the kill-cam needs (roadmap 3.3): your traced line,
   * the validator's solved path, and obstacle envelopes around the impact.
   * Call right after death — pools still hold the killing geometry.
   *
   * Everything is straightened into course-local coordinates (winding
   * offset subtracted), so the top-down map's ±X_LIMIT frame stays truthful.
   */
  buildForensics(behind = 320, ahead = 50): DeathForensics | null {
    if (this.state.status !== "dead") return null;
    const deathS = this.state.distance;
    const s0 = deathS - behind;
    const s1 = deathS + ahead;
    const local = (s: number, x: number) => x - this.state.course.offsetAt(s);

    const trace = this.getTrace()
      .filter((t) => t.s >= s0)
      .map((t) => ({ ...t, x: local(t.s, t.x) }));

    const path: [number, number][][] = [];
    for (const c of this.chunks) {
      if (c.s1 < s0 || c.s0 > s1) continue;
      const seg = c.path
        .filter(([s]) => s >= s0 && s <= s1)
        .map(([s, x]) => [s, local(s, x)] as [number, number]);
      if (seg.length >= 2) path.push(seg);
    }

    let obstacles: ForensicsObstacle[] = [];
    for (const rec of this.recentObstacles) {
      if (rec.s >= s0 && rec.s <= s1) {
        obstacles.push({ ...rec, x: local(rec.s, rec.x) });
      }
    }
    for (const o of this.state.obstacles) {
      if (!o.active || !o.collidable || o.kind === "decor" || o.kind === "ramp") continue;
      if (o.cs < s0 || o.cs > s1) continue;
      const vHalf = o.kind === "ring" ? o.hx : o.hy;
      if (o.cy - vHalf > CRAFT.Y_MAX || o.cy + vHalf < CRAFT.Y_MIN) continue;
      obstacles.push({
        kind: o.kind, s: o.cs, x: local(o.cs, o.cx),
        hx: o.hx, hs: o.hs, yaw: o.cyaw, inner: o.inner,
      });
    }
    if (obstacles.length > 240) {
      obstacles = obstacles
        .sort((a, b) => Math.abs(a.s - deathS) - Math.abs(b.s - deathS))
        .slice(0, 240);
    }

    return {
      deathS,
      deathX: local(deathS, this.state.deathX),
      deathSpeed: this.state.deathSpeed,
      s0,
      s1,
      trace,
      path,
      obstacles,
    };
  }

}
