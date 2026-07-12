import {
  CRAFT,
  ENERGY,
  FIXED_DT,
  FLOW,
  MAX_STEPS_PER_FRAME,
  RUN,
  SPEED,
  STEER,
  TRACK,
} from "./constants";
import { Emitter } from "./events";
import type { InputState } from "./input";
import { circleObbDistSq, clamp, clamp01, lerp, pistonPulse } from "./mathUtils";
import { createRng } from "./rng";
import {
  Motion,
  type Obstacle,
  type ObstacleSpec,
  type Pickup,
  type RunStatus,
} from "./types";
import { biomeIndexAt, BIOMES } from "../track/biomes";
import { speedAt, TrackGenerator, type GeneratedChunk } from "../track/generator";

const OBSTACLE_CAP = 1400;
const PICKUP_CAP = 240;

export interface RunStats {
  score: number;
  distance: number;
  nearMisses: number;
  shards: number;
  maxFlowPoints: number;
  maxFlowTier: number;
  boosts: number;
  duration: number;
  seed: string;
  daily: boolean;
}

/**
 * The whole game simulation. Deterministic given a seed + input stream.
 * No three.js, no React — stepped at a fixed 120 Hz.
 */
export class SimWorld {
  readonly events = new Emitter();

  // Run identity.
  seed = "";
  daily = false;
  status: RunStatus = "idle";

  // Craft state.
  x = 0;
  latVel = 0;
  bank = 0;
  distance = 0;
  speed = 0;
  /** Current speed as a 0..1 fraction of the possible span (for fx/audio). */
  speedNorm = 0;

  // Meters.
  time = 0;
  score = 0;
  flowPoints = 0;
  flowTier = 0;
  flowTimer = 0;
  energy = 30;
  boosting = false;
  boostCharge = 0;
  hasShield = false;
  iframes = 0;
  shardCombo = 0;
  shardComboTimer = 0;

  stats: RunStats = this.emptyStats();

  // Death.
  deathTimer = 0;
  deathX = 0;

  // Pools.
  readonly obstacles: Obstacle[] = [];
  readonly pickups: Pickup[] = [];
  private obstacleFree: number[] = [];
  private pickupFree: number[] = [];

  private generator: TrackGenerator | null = null;
  private accumulator = 0;
  /** Interpolation snapshot for buttery rendering. */
  prevX = 0;
  prevDistance = 0;
  prevBank = 0;

  debugChunks: GeneratedChunk[] = [];
  collectDebug = false;

  constructor() {
    for (let i = 0; i < OBSTACLE_CAP; i++) {
      this.obstacles.push({
        id: i, active: false, kind: "box",
        s: 0, x: 0, y: 0, hx: 1, hy: 1, hs: 1, yaw: 0,
        motion: Motion.None, m0: 0, m1: 0, m2: 0,
        role: "primary", glow: 1, collidable: true, inner: 0,
        cx: 0, cy: 0, cs: 0, cyaw: 0,
        state: 0, landed: false, nearMissed: false, spawnTime: 0,
      });
      this.obstacleFree.push(OBSTACLE_CAP - 1 - i);
    }
    for (let i = 0; i < PICKUP_CAP; i++) {
      this.pickups.push({
        id: i, active: false, type: "shard", s: 0, x: 0, y: 0,
        seeking: false, spawnTime: 0,
      });
      this.pickupFree.push(PICKUP_CAP - 1 - i);
    }
  }

  private emptyStats(): RunStats {
    return {
      score: 0, distance: 0, nearMisses: 0, shards: 0,
      maxFlowPoints: 0, maxFlowTier: 0, boosts: 0, duration: 0,
      seed: "", daily: false,
    };
  }

  /** Deactivate all live entities (used when returning to the title). */
  clearField(): void {
    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
  }

  /** Reset everything and start a new run. Instant — all pools are reused. */
  start(seed: string, daily: boolean): void {
    this.seed = seed;
    this.daily = daily;
    this.status = "running";
    this.x = 0;
    this.latVel = 0;
    this.bank = 0;
    this.distance = 0;
    this.speed = 0;
    this.speedNorm = 0;
    this.time = 0;
    this.score = 0;
    this.flowPoints = 0;
    this.flowTier = 0;
    this.flowTimer = 0;
    this.energy = 30;
    this.boosting = false;
    this.boostCharge = 0;
    this.hasShield = false;
    this.iframes = 0;
    this.shardCombo = 0;
    this.shardComboTimer = 0;
    this.deathTimer = 0;
    this.accumulator = 0;
    this.prevX = 0;
    this.prevDistance = 0;
    this.prevBank = 0;
    this.stats = this.emptyStats();
    this.stats.seed = seed;
    this.stats.daily = daily;

    for (const o of this.obstacles) o.active = false;
    for (const p of this.pickups) p.active = false;
    this.obstacleFree.length = 0;
    this.pickupFree.length = 0;
    for (let i = OBSTACLE_CAP - 1; i >= 0; i--) this.obstacleFree.push(i);
    for (let i = PICKUP_CAP - 1; i >= 0; i--) this.pickupFree.push(i);
    this.debugChunks.length = 0;

    this.generator = new TrackGenerator(createRng(seed), this.collectDebug);
    this.streamAhead();
    this.events.emit("runStart", { seed, daily });
    this.events.emit("biome", { index: 0, name: BIOMES[0].label });
  }

  /** Advance sim by wall-clock dt (handles fixed-step accumulation + slow-mo). */
  update(dt: number, input: InputState): void {
    if (this.status === "idle") return;

    let scale = 1;
    if (this.status === "dead") {
      this.deathTimer += dt;
      scale = RUN.DEATH_SLOWMO;
      if (this.deathTimer > RUN.DEATH_SLOWMO_DURATION) return; // Freeze world.
    }

    this.accumulator += Math.min(dt, 0.25) * scale;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.prevX = this.x;
      this.prevDistance = this.distance;
      this.prevBank = this.bank;
      this.step(FIXED_DT, input);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
  }

  /** Interpolation alpha for rendering. */
  get alpha(): number {
    return clamp01(this.accumulator / FIXED_DT);
  }

  get renderX(): number {
    return lerp(this.prevX, this.x, this.alpha);
  }

  get renderDistance(): number {
    return lerp(this.prevDistance, this.distance, this.alpha);
  }

  get renderBank(): number {
    return lerp(this.prevBank, this.bank, this.alpha);
  }

  get biomeIndex(): number {
    return biomeIndexAt(this.distance);
  }

  private step(dt: number, input: InputState): void {
    this.time += dt;
    const alive = this.status === "running";

    // --- Speed ---------------------------------------------------------
    const launch = clamp01(this.time / SPEED.LAUNCH_RAMP);
    const flowBonus = 1 + this.flowTier * 0.035;
    let targetSpeed = speedAt(this.distance) * launch * flowBonus;

    // Boost.
    if (alive) {
      const wantBoost = input.boost && this.energy > (this.boosting ? 0 : ENERGY.BOOST_MIN);
      if (wantBoost && !this.boosting) {
        this.boosting = true;
        this.stats.boosts++;
        this.events.emit("boostStart", undefined);
      } else if (!wantBoost && this.boosting) {
        this.boosting = false;
        this.events.emit("boostEnd", undefined);
      }
      if (this.boosting) {
        this.energy = Math.max(0, this.energy - ENERGY.BOOST_DRAIN * dt);
        if (this.energy <= 0) {
          this.boosting = false;
          this.events.emit("boostEnd", undefined);
        }
      }
    } else if (this.boosting) {
      this.boosting = false;
      this.events.emit("boostEnd", undefined);
    }
    this.boostCharge = clamp01(this.boostCharge + (this.boosting ? dt * 3.2 : -dt * 2.4));
    targetSpeed *= 1 + (SPEED.BOOST_MULT - 1) * this.boostCharge;

    this.speed = alive
      ? lerp(this.speed, targetSpeed, 1 - Math.exp(-2.8 * dt))
      : Math.max(0, this.speed - 90 * dt); // Crash deceleration.
    this.speedNorm = clamp01((this.speed - SPEED.BASE) / (SPEED.MAX * SPEED.BOOST_MULT - SPEED.BASE));

    if (alive) this.distance += this.speed * dt;

    // --- Steering (speed-proportional, momentum-based) -------------------
    const maxLat = Math.max(10, this.speed) * STEER.RATIO;
    if (alive) {
      const authority = this.boosting ? STEER.BOOST_AUTHORITY : 1;
      const axis = input.axis;
      this.latVel += axis * Math.max(10, this.speed) * STEER.ACCEL_K * authority * dt;
      const drag = Math.abs(axis) > 0.05 ? STEER.DRAG : STEER.RELEASE_DRAG;
      this.latVel *= Math.exp(-drag * dt * (this.boosting ? 0.85 : 1));
      this.latVel = clamp(this.latVel, -maxLat, maxLat);
      this.x += this.latVel * dt;
      if (this.x < -TRACK.X_LIMIT) {
        this.x = -TRACK.X_LIMIT;
        this.latVel = Math.max(0, this.latVel) * 0.4;
      } else if (this.x > TRACK.X_LIMIT) {
        this.x = TRACK.X_LIMIT;
        this.latVel = Math.min(0, this.latVel) * 0.4;
      }
    } else {
      this.latVel *= Math.exp(-4 * dt);
    }
    const targetBank = clamp(
      -(this.latVel / Math.max(1, maxLat)) * STEER.MAX_BANK,
      -STEER.MAX_BANK,
      STEER.MAX_BANK,
    );
    this.bank = lerp(this.bank, targetBank, 1 - Math.exp(-10 * dt));

    // --- Streaming -----------------------------------------------------
    this.streamAhead();

    // --- Obstacles: motion + collision + near miss ----------------------
    this.updateObstacles(dt, alive);

    // --- Pickups ---------------------------------------------------------
    if (alive) this.updatePickups(dt);

    // --- Flow / combo timers ---------------------------------------------
    if (alive) {
      this.flowTimer += dt;
      if (this.flowTimer > FLOW.DECAY_GRACE && this.flowPoints > 0) {
        this.flowPoints = Math.max(0, this.flowPoints - FLOW.DECAY_RATE * dt);
      }
      this.setFlowTier(Math.floor(this.flowPoints / FLOW.POINTS_PER_TIER));

      this.shardComboTimer += dt;
      if (this.shardComboTimer > 2.4) this.shardCombo = 0;

      if (this.iframes > 0) this.iframes -= dt;

      // Score: distance rate scaled by flow multiplier.
      const mult = 1 + this.flowPoints * FLOW.MULT_PER_POINT;
      this.score += this.speed * dt * mult;

      this.stats.score = Math.floor(this.score);
      this.stats.distance = this.distance;
      this.stats.duration = this.time;
      this.stats.maxFlowPoints = Math.max(this.stats.maxFlowPoints, this.flowPoints);
    }
  }

  get flowMultiplier(): number {
    return 1 + this.flowPoints * FLOW.MULT_PER_POINT;
  }

  private setFlowTier(tier: number): void {
    if (tier !== this.flowTier) {
      const prev = this.flowTier;
      this.flowTier = tier;
      this.stats.maxFlowTier = Math.max(this.stats.maxFlowTier, tier);
      this.events.emit("flowTier", { tier, prev });
    }
  }

  private streamAhead(): void {
    const gen = this.generator;
    if (!gen) return;
    gen.fill(this.distance + TRACK.GEN_HORIZON, {
      chunk: (chunk) => this.spawnChunk(chunk),
    });
  }

  private spawnChunk(chunk: GeneratedChunk): void {
    for (const spec of chunk.obstacles) this.spawnObstacle(spec);
    for (const p of chunk.pickups) {
      const idx = this.pickupFree.pop();
      if (idx === undefined) break;
      const pk = this.pickups[idx];
      pk.active = true;
      pk.type = p.type;
      pk.s = p.s;
      pk.x = p.x;
      pk.y = p.y;
      pk.seeking = false;
      pk.spawnTime = this.time;
    }
    if (chunk.announce) {
      this.events.emit("setpiece", { name: chunk.announce });
    }
    if (this.collectDebug && chunk.debug) {
      this.debugChunks.push(chunk);
      while (this.debugChunks.length > 8) this.debugChunks.shift();
    }
  }

  private spawnObstacle(spec: ObstacleSpec): void {
    const idx = this.obstacleFree.pop();
    if (idx === undefined) return;
    const o = this.obstacles[idx];
    o.active = true;
    o.kind = spec.kind;
    o.s = spec.s;
    o.x = spec.x;
    o.y = spec.y;
    o.hx = spec.hx;
    o.hy = spec.hy;
    o.hs = spec.hs;
    o.yaw = spec.yaw ?? 0;
    o.motion = spec.motion ?? Motion.None;
    o.m0 = spec.m0 ?? 0;
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
    o.spawnTime = this.time;
  }

  private updateObstacles(dt: number, alive: boolean): void {
    const t = this.time;
    const craftS = this.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;

    for (const o of this.obstacles) {
      if (!o.active) continue;

      if (o.cs < behind && o.s < behind) {
        o.active = false;
        this.obstacleFree.push(o.id);
        continue;
      }

      // Motion evaluation.
      switch (o.motion) {
        case Motion.None:
          break;
        case Motion.SweepX:
          o.cx = o.x + Math.sin(t * o.m0 + o.m1) * o.m2;
          break;
        case Motion.Pendulum: {
          const ang = Math.sin(t * o.m2) * o.m1;
          o.cx = o.x + Math.sin(ang) * o.m0;
          o.cy = o.y - Math.cos(ang) * o.m0;
          break;
        }
        case Motion.FallY: {
          if (!o.landed) {
            if (craftS > o.m0) {
              o.state += 88 * dt; // Fall velocity accumulates.
              o.cy = Math.max(o.m1, o.cy - o.state * dt * 14);
              if (o.cy <= o.m1) {
                o.cy = o.m1;
                o.landed = true;
                this.events.emit("slabFall", { x: o.cx, s: o.cs });
              }
            }
          }
          break;
        }
        case Motion.RotateYaw:
          o.cyaw = o.m1 + t * o.m0;
          break;
        case Motion.OrbitXZ: {
          const a = o.m2 + t * o.m1;
          o.cx = o.x + Math.cos(a) * o.m0;
          o.cs = o.s + Math.sin(a) * o.m0;
          break;
        }
        case Motion.CloseIn: {
          const p = clamp01((craftS - o.m1) / Math.max(1, o.m2 - o.m1));
          const e = p * p * (3 - 2 * p);
          o.cx = lerp(o.x, o.m0, e);
          break;
        }
        case Motion.Piston: {
          const pulse = pistonPulse((t * o.m0 + o.m1));
          o.cx = o.x + o.m2 * pulse;
          break;
        }
      }

      if (!alive || !o.collidable) continue;

      // Broad phase along track.
      const stepLen = this.speed * dt;
      const sExtent = o.motion === Motion.RotateYaw
        ? Math.hypot(o.hx, o.hs)
        : Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
      const dS = craftS - o.cs;
      const withinS = Math.abs(dS) < sExtent + stepLen + CRAFT.RADIUS + 1.5;

      if (withinS) {
        // Vertical overlap (movers use current cy).
        const yOverlap = o.cy - o.hy < CRAFT.Y_MAX && o.cy + o.hy > CRAFT.Y_MIN;
        if (yOverlap) {
          let hit = false;
          let clearance = Infinity;

          if (o.kind === "ring") {
            const inS = Math.abs(dS) < o.hs + stepLen * 0.5 + CRAFT.RADIUS * 0.5;
            if (inS) {
              const dx = this.x - o.cx;
              const dy = CRAFT.HOVER_HEIGHT - o.cy;
              const r = Math.hypot(dx, dy);
              if (r > o.inner - CRAFT.RADIUS * 0.4 && r < o.hx + CRAFT.RADIUS * 0.6) hit = true;
              clearance = o.inner - Math.abs(dx);
            }
          } else {
            const distSq = circleObbDistSq(
              this.x, craftS,
              o.cx, o.cs,
              o.hx, o.hs + stepLen * 0.5,
              o.cyaw,
            );
            const rr = CRAFT.RADIUS;
            if (distSq < rr * rr) hit = true;
            clearance = Math.sqrt(distSq);
          }

          if (hit && this.iframes <= 0) {
            // FallY slabs still in the air far above can't hit the craft
            // (yOverlap already filtered), so any hit here is real.
            this.onHit();
            if (this.status !== "running") return;
          } else if (
            !o.nearMissed &&
            o.motion !== Motion.FallY && // state doubles as fall velocity there
            clearance < FLOW.NEAR_MISS_CLEARANCE + CRAFT.RADIUS
          ) {
            // Track candidate near miss; confirmed once fully passed.
            o.state = Math.max(o.state, 1);
          }
        }
      }

      // Near-miss confirmation: obstacle fully behind the craft.
      if (
        !o.nearMissed &&
        o.state >= 1 &&
        o.motion !== Motion.FallY && // Falling slabs feel arbitrary for near-miss credit.
        o.cs + o.hs < craftS - CRAFT.RADIUS
      ) {
        o.nearMissed = true;
        if (alive) this.onNearMiss(o);
      }
    }
  }

  private onNearMiss(o: Obstacle): void {
    this.flowPoints = Math.min(FLOW.MAX_POINTS, this.flowPoints + FLOW.POINTS_PER_NEAR_MISS);
    this.flowTimer = 0;
    this.stats.nearMisses++;
    this.score += 25 * this.flowMultiplier;
    this.events.emit("nearMiss", {
      x: o.cx, s: o.cs,
      clearance: Math.abs(this.x - o.cx) - o.hx,
      flowPoints: this.flowPoints,
    });
  }

  private onHit(): void {
    if (this.hasShield) {
      this.hasShield = false;
      this.iframes = RUN.SHIELD_IFRAMES;
      this.flowPoints = Math.max(0, this.flowPoints - 6);
      this.events.emit("shieldBreak", { x: this.x });
      return;
    }
    this.status = "dead";
    this.deathTimer = 0;
    this.deathX = this.x;
    this.events.emit("death", { x: this.x, speed: this.speed });
  }

  private updatePickups(dt: number): void {
    const craftS = this.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;

    for (const p of this.pickups) {
      if (!p.active) continue;
      if (p.s < behind) {
        p.active = false;
        this.pickupFree.push(p.id);
        continue;
      }

      const dS = p.s - craftS;
      const dx = p.x - this.x;
      const distSq = dS * dS + dx * dx;

      if (p.type === "shard") {
        if (!p.seeking && distSq < ENERGY.MAGNET_RADIUS * ENERGY.MAGNET_RADIUS) {
          p.seeking = true;
        }
        if (p.seeking) {
          const d = Math.sqrt(distSq) || 1;
          const pull = 34 * dt;
          p.x -= (dx / d) * pull * 0.6;
          p.s -= (dS / d) * pull;
          p.y = lerp(p.y, CRAFT.HOVER_HEIGHT, 8 * dt);
        }
      }

      const cr = ENERGY.COLLECT_RADIUS;
      if (distSq < cr * cr) {
        p.active = false;
        this.pickupFree.push(p.id);
        if (p.type === "shard") {
          this.shardCombo++;
          this.shardComboTimer = 0;
          this.energy = Math.min(ENERGY.MAX, this.energy + ENERGY.PER_SHARD);
          this.flowPoints = Math.min(FLOW.MAX_POINTS, this.flowPoints + 0.5);
          this.flowTimer = 0;
          this.score += ENERGY.SHARD_SCORE * this.flowMultiplier;
          this.stats.shards++;
          this.events.emit("shard", { x: p.x, y: p.y, combo: this.shardCombo });
        } else {
          this.hasShield = true;
          this.events.emit("shieldPickup", { x: p.x });
        }
      }
    }
  }
}
