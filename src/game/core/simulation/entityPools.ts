/** Stable, reusable simulation entities; slot ownership never leaves this pool. */
import { Motion, type Obstacle, type ObstacleSpec, type Pickup } from "../types";
import type { Course } from "../../track/course";
import type { RunStats } from "./runStats";

// Sized for LOOKAHEAD.MAX (~2.2× the 720 m baseline peaks).
const OBSTACLE_CAP = 2600;
const PICKUP_CAP = 420;

export interface PoolSpawnState {
  readonly time: number;
  readonly course: Pick<Course, "offsetAt">;
  readonly stats: Pick<RunStats, "obstacleDrops" | "pickupDrops">;
}

export class EntityPools {
  readonly obstacles: Obstacle[] = [];
  readonly pickups: Pickup[] = [];
  private readonly obstacleFree: number[] = [];
  private readonly pickupFree: number[] = [];
  private rampCount = 0;

  get liveRamps(): number {
    return this.rampCount;
  }

  constructor() {
    for (let i = 0; i < OBSTACLE_CAP; i++) {
      this.obstacles.push({
        id: i, active: false, kind: "box",
        s: 0, x: 0, y: 0, hx: 1, hy: 1, hs: 1, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0,
        role: "primary", glow: 1, collidable: true, inner: 0,
        cx: 0, cy: 0, cs: 0, cyaw: 0,
        state: 0, landed: false, nearMissed: false, nearMissClearance: Infinity,
        nearMissSide: 0,
        patternId: "", spawnTime: 0,
      });
      this.obstacleFree.push(OBSTACLE_CAP - 1 - i);
    }
    for (let i = 0; i < PICKUP_CAP; i++) {
      this.pickups.push({
        id: i, active: false, type: "shard", s: 0, x: 0, y: 0,
        seeking: false, magnetic: true, spawnTime: 0,
      });
      this.pickupFree.push(PICKUP_CAP - 1 - i);
    }
  }

  clear(): void {
    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.rampCount = 0;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
  }

  releaseObstacle(o: Obstacle): void {
    if (o.kind === "ramp") this.rampCount = Math.max(0, this.rampCount - 1);
    o.active = false;
    this.obstacleFree.push(o.id);
  }

  releasePickup(p: Pickup): void {
    p.active = false;
    this.pickupFree.push(p.id);
  }

  spawnPickup(
    type: Pickup["type"],
    s: number,
    x: number,
    y: number,
    magnetic: boolean,
    state: PoolSpawnState,
  ): void {
    const idx = this.pickupFree.pop();
    if (idx === undefined) {
      state.stats.pickupDrops++;
      return;
    }
    const pk = this.pickups[idx];
    pk.active = true;
    pk.type = type;
    pk.s = s;
    pk.x = x;
    pk.y = y;
    pk.seeking = false;
    pk.magnetic = magnetic;
    pk.spawnTime = state.time;
  }

  spawnObstacle(spec: ObstacleSpec, patternId: string, state: PoolSpawnState): void {
    const idx = this.obstacleFree.pop();
    if (idx === undefined) {
      state.stats.obstacleDrops++;
      return;
    }
    // Patterns author in the straight local frame; the winding course lands
    // here, at spawn time (validation already happened in the local frame).
    const courseX = state.course.offsetAt(spec.s);
    const o = this.obstacles[idx];
    o.active = true;
    o.kind = spec.kind;
    o.s = spec.s;
    o.x = spec.x + courseX;
    o.y = spec.y;
    o.hx = spec.hx;
    o.hy = spec.hy;
    o.hs = spec.hs;
    o.yaw = spec.yaw ?? 0;
    o.motion = spec.motion ?? Motion.None;
    // CloseIn's m0 is an absolute lateral target — shift it with the course.
    o.m0 = (spec.m0 ?? 0) + (o.motion === Motion.CloseIn ? courseX : 0);
    o.m1 = spec.m1 ?? 0;
    o.m2 = spec.m2 ?? 0;
    o.role = spec.role ?? "primary";
    o.glow = spec.glow ?? 1;
    o.collidable = spec.collidable ?? true;
    o.inner = spec.inner ?? 0;
    o.cx = o.x;
    o.cy = o.y;
    o.cs = o.s;
    o.cyaw = o.yaw;
    o.state = 0;
    o.landed = false;
    o.nearMissed = false;
    o.nearMissClearance = Infinity;
    o.nearMissSide = 0;
    o.patternId = patternId;
    o.spawnTime = state.time;
    if (o.kind === "ramp") this.rampCount++;
  }

}
