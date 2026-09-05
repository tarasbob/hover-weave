import { clamp } from "./mathUtils";

type Action = "boost" | "dash";
const ACTIONS: readonly Action[] = ["boost", "dash"];
interface ActionTransition { at: number; action: Action; held: boolean }

/** A reusable snapshot of DOM transitions during one rendered frame (milliseconds). */
export interface ActionFrame {
  generation: number;
  sequence: number;
  start: number;
  end: number;
  boost: boolean;
  dash: boolean;
  transitions: readonly ActionTransition[];
}

/** Event-driven controls retain taps even when press and release precede a poll. */
export class ActionEventBuffer {
  private boost = false;
  private dash = false;
  private startBoost = false;
  private startDash = false;
  private start = 0;
  private pending: ActionTransition[] = [];
  private published: ActionTransition[] = [];
  readonly frame: ActionFrame = {
    generation: 0, sequence: 0, start: 0, end: 0,
    boost: false, dash: false, transitions: [],
  };

  reset(now: number): void {
    this.boost = this.dash = this.startBoost = this.startDash = false;
    this.start = now;
    this.pending.length = this.published.length = 0;
    Object.assign(this.frame, {
      generation: this.frame.generation + 1, sequence: 0,
      start: now, end: now, boost: false, dash: false, transitions: this.published,
    });
  }

  set(boost: boolean, dash: boolean, now: number): void {
    const at = Math.max(this.start, this.pending.at(-1)?.at ?? this.start, now);
    if (boost !== this.boost) this.pending.push({ at, action: "boost", held: boost });
    if (dash !== this.dash) this.pending.push({ at, action: "dash", held: dash });
    this.boost = boost;
    this.dash = dash;
  }

  drain(now: number): void {
    const spare = this.published;
    this.published = this.pending;
    this.pending = spare;
    this.pending.length = 0;
    this.frame.sequence++;
    this.frame.start = this.start;
    this.frame.end = Math.max(this.start, now);
    this.frame.boost = this.startBoost;
    this.frame.dash = this.startDash;
    this.frame.transitions = this.published;
    this.start = this.frame.end;
    this.startBoost = this.boost;
    this.startDash = this.dash;
  }
}

interface TickTransition { at: number; held: boolean }

/**
 * Maps wall-clock transitions onto simulation time, including partial ticks and
 * time dilation. Each button changes at most once per tick: a sub-tick tap gets
 * a press tick followed by a release tick, so the existing replay booleans can
 * represent both edges without changing simulation rules or the replay format.
 */
export class FixedTickActions {
  private inputTime = 0;
  private tickTime = 0;
  private generation = -1;
  private sequence = -1;
  private boost = false;
  private dash = false;
  private queues: Record<Action, TickTransition[]> = { boost: [], dash: [] };

  reset(): void {
    this.inputTime = this.tickTime = 0;
    this.generation = this.sequence = -1;
    this.boost = this.dash = false;
    this.queues.boost.length = this.queues.dash.length = 0;
  }

  append(frame: ActionFrame | undefined, elapsed: number): boolean {
    // Replays and synthetic pilots supply already sampled tick inputs. Leave
    // that path unchanged, including its historical quantization and edges.
    if (!frame) {
      this.reset();
      return false;
    }
    if (frame.generation !== this.generation || frame.sequence !== this.sequence + 1) {
      // Lost focus, skipped polls while paused, and new runs discard stale taps.
      this.queues.boost.length = this.queues.dash.length = 0;
      this.boost = frame.boost;
      this.dash = frame.dash;
    }
    this.generation = frame.generation;
    this.sequence = frame.sequence;
    const duration = frame.end - frame.start;
    for (const transition of frame.transitions) {
      const fraction = duration > 0 ? clamp((transition.at - frame.start) / duration, 0, 1) : 0;
      this.queues[transition.action].push({
        at: this.inputTime + fraction * elapsed, held: transition.held,
      });
    }
    this.inputTime += elapsed;
    return true;
  }

  sample(dt: number, target: { boost: boolean; dash: boolean }): void {
    this.tickTime += dt;
    for (const action of ACTIONS) {
      const queue = this.queues[action];
      if (queue.length > 0 && queue[0].at <= this.tickTime + 1e-9) {
        this[action] = queue.shift()!.held;
      }
      target[action] = this[action];
    }
  }
}
