/** Seeded, telegraphed world events constrained by the validated course. */
import { EVENTS, rampMaxFlight, TRACK } from "../constants";
import type { Emitter } from "../events";
import { createRng, type Rng } from "../rng";
import { Motion, type Obstacle, type RunEventKind } from "../types";
import type { EntityPools, PoolSpawnState } from "./entityPools";
import type { ChunkRecord, RunStats } from "./runStats";

interface DirectorState extends PoolSpawnState {
  readonly distance: number;
  readonly speed: number;
  readonly obstacles: readonly Obstacle[];
  readonly chunkLog: readonly ChunkRecord[];
  readonly stats: RunStats;
  readonly events: Emitter;
  activeEvent: { kind: RunEventKind; endAt: number } | null;
}

export class EventDirector {
  private eventRng: Rng = createRng("idle");
  private nextEventAt = Infinity;
  private meteorNextAt = 0;

  constructor(
    private readonly state: DirectorState,
    private readonly pools: EntityPools,
    private readonly speedAt: (s: number) => number,
  ) {}

  reset(seed: string, skipTo: number, trial: boolean): void {
    this.eventRng = createRng(`${seed}|events`);
    this.state.activeEvent = null;
    this.meteorNextAt = 0;
    this.nextEventAt = trial
      ? Infinity
      : Math.max(skipTo, EVENTS.START) + this.eventRng.range(0, EVENTS.GAP_MAX - EVENTS.GAP_MIN);
  }

  /**
   * Rare seeded global events. Rolls are distance-triggered off a dedicated
   * rng stream, so replays and twin worlds stay bit-exact.
   */
  update(): void {
    if (this.nextEventAt === Infinity) return;
    const d = this.state.distance;
    const ev = this.state.activeEvent;
    if (ev) {
      if (ev.kind === "meteor" && d >= this.meteorNextAt) {
        this.meteorNextAt =
          d + this.eventRng.range(EVENTS.METEOR_SPACING_MIN, EVENTS.METEOR_SPACING_MAX);
        this.spawnEventMeteor();
      }
      if (d > ev.endAt) {
        this.state.activeEvent = null;
        this.nextEventAt = d + this.eventRng.range(EVENTS.GAP_MIN, EVENTS.GAP_MAX);
      }
      return;
    }
    if (d < this.nextEventAt) return;
    const kind: RunEventKind = this.eventRng.chance(0.55) ? "meteor" : "rush";
    if (kind === "rush") {
      // A rush with nothing to lay down (no solved paths ahead) is skipped —
      // re-roll a little later instead of announcing an empty event.
      if (!this.spawnRush()) {
        this.nextEventAt = d + this.eventRng.range(200, 400);
        return;
      }
      this.state.activeEvent = { kind, endAt: d + EVENTS.RUSH_LENGTH };
    } else {
      this.state.activeEvent = { kind, endAt: d + EVENTS.METEOR_LENGTH };
      this.meteorNextAt = d;
    }
    this.state.stats.runEvents++;
    this.state.events.emit("runEvent", {
      kind,
      name: kind === "meteor" ? "METEOR BARRAGE" : "GOLDEN RUSH",
    });
  }

  /** X of the validator's solved safe line at s (world frame), if known. */
  private safePathXAt(s: number): number | null {
    for (const c of this.state.chunkLog) {
      if (s < c.s0 || s > c.s1 || c.path.length === 0) continue;
      let best: number | null = null;
      let bestD = Infinity;
      for (const [ps, px] of c.path) {
        const dd = Math.abs(ps - s);
        if (dd < bestD) {
          bestD = dd;
          best = px;
        }
      }
      return bestD <= 6 ? best : null;
    }
    return null;
  }

  /**
   * Is track position s inside a live skyhook approach/flight/landing
   * window? Drama-director rocks must never salt a landing tube — an
   * airborne craft has no authority to dodge a fresh drop.
   */
  private inRampWindow(s: number): boolean {
    if (this.pools.liveRamps === 0) return false;
    for (const o of this.state.obstacles) {
      if (!o.active || o.kind !== "ramp") continue;
      const lip = o.cs + o.hs;
      const flight = rampMaxFlight(o.hy, o.hs * 2, this.speedAt(lip));
      if (s > o.cs - o.hs - 20 && s < lip + flight + 10) return true;
    }
    return false;
  }

  /**
   * One telegraphed meteor: lands ahead as a permanent rock, never within
   * METEOR_PATH_CLEAR of the solved safe line (nor inside a skyhook flight
   * window). No proven line => no rock.
   */
  private spawnEventMeteor(): void {
    const s = this.state.distance + this.eventRng.range(EVENTS.METEOR_LEAD_MIN, EVENTS.METEOR_LEAD_MAX);
    const safeX = this.safePathXAt(s);
    const off = this.state.course.offsetAt(s);
    // The rng draws below run unconditionally so the stream stays aligned
    // whether or not a legal spot exists.
    const lane = this.eventRng.range(-(TRACK.X_LIMIT - 3), TRACK.X_LIMIT - 3);
    const w = this.eventRng.range(1.3, 2.2);
    const hy = this.eventRng.range(2, 3.2);
    const yaw = this.eventRng.range(0, Math.PI);
    const drop = this.eventRng.range(0, 8);
    const restY = this.eventRng.range(1.4, 2);
    if (safeX === null) return;
    if (this.inRampWindow(s)) return;
    const x = off + lane;
    if (Math.abs(x - safeX) < EVENTS.METEOR_PATH_CLEAR + w) return;
    // spawnObstacle re-applies the course offset: hand it local-frame specs.
    const lx = x - off;
    const trigger = s - (this.state.speed * 1.45 + 34);
    this.pools.spawnObstacle(
      {
        kind: "crystal", x: lx, s, y: 34 + drop,
        hx: w, hy, hs: w, yaw,
        role: "warn", glow: 1.6,
        motion: Motion.FallY, m0: trigger, m1: restY,
      },
      "meteorBarrage",
      this.state,
    );
    this.pools.spawnObstacle(
      {
        kind: "box", x: lx, s, y: 0.06,
        hx: w + 0.5, hy: 0.06, hs: w + 0.5,
        role: "warn", glow: 2.2,
        collidable: false, noValidate: true,
      },
      "meteorBarrage",
      this.state,
    );
  }

  /** Golden rush: a shard river laid along the solved safe line ahead. */
  private spawnRush(): boolean {
    const d0 = this.state.distance + EVENTS.RUSH_LEAD;
    const d1 = d0 + EVENTS.RUSH_LENGTH;
    let laid = 0;
    for (const c of this.state.chunkLog) {
      if (c.s1 < d0 || c.s0 > d1) continue;
      for (let i = 0; i < c.path.length; i += 2) {
        const [s, x] = c.path[i];
        if (s < d0 || s > d1) continue;
        this.pools.spawnPickup("shard", s, x, 1.3, true, this.state);
        laid++;
      }
    }
    return laid >= 8;
  }

}
