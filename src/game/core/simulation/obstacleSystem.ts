/** Obstacle motion, collision, closest approaches and local danger sampling. */
import { CRAFT, DANGER, GLASS, SERPENT, THREAD, TRACK } from "../constants";
import type { Emitter } from "../events";
import { circleObbDistSq, clamp01, lerp, pistonPulse } from "../mathUtils";
import { Motion, type Obstacle, type RunStatus } from "../types";
import type { EntityPools } from "./entityPools";
import type { RunAnalysis } from "./runAnalysis";

export function obstacleTrailingEdge(o: Obstacle): number {
  if (o.motion === Motion.RotateYaw) return o.cs + Math.hypot(o.hx, o.hs);
  if (o.motion === Motion.OrbitXZ) {
    return o.s + Math.abs(o.m0) + Math.max(o.hx, o.hs);
  }
  const extent = Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
  return o.cs + extent;
}

interface ObstacleState {
  readonly time: number;
  readonly distance: number;
  readonly speed: number;
  readonly x: number;
  readonly y: number;
  readonly airborne: boolean;
  readonly boostCharge: number;
  readonly iframes: number;
  readonly status: RunStatus;
  readonly obstacles: readonly Obstacle[];
  readonly events: Emitter;
  dangerFactor: number;
}

interface ContactActions {
  onHit(o: Obstacle): void;
  onShatter(o: Obstacle): void;
  onBounce(o: Obstacle): void;
  onPassConfirmed(o: Obstacle): void;
}

/** The world owns contact rewards and death; this system owns contact detection. */
export class ObstacleSystem {
  constructor(
    private readonly state: ObstacleState,
    private readonly pools: EntityPools,
    private readonly analysis: RunAnalysis,
    private readonly contacts: ContactActions,
  ) {}

  update(dt: number, alive: boolean): void {
    const t = this.state.time;
    const craftS = this.state.distance;
    const behind = craftS - TRACK.DESPAWN_BEHIND;
    const stepLen = this.state.speed * dt;
    let engageDensity = 0;
    let availDensity = 0;
    // Craft vertical band follows the (usually grounded) craft. `y` is set
    // to HOVER_HEIGHT *exactly* whenever no ramp is in play, so these are
    // bit-identical to the classic Y_MIN/Y_MAX constants on the ground.
    const yLo =
      this.state.y === CRAFT.HOVER_HEIGHT
        ? CRAFT.Y_MIN
        : this.state.y + (CRAFT.Y_MIN - CRAFT.HOVER_HEIGHT);
    const yHi =
      this.state.y === CRAFT.HOVER_HEIGHT
        ? CRAFT.Y_MAX
        : this.state.y + (CRAFT.Y_MAX - CRAFT.HOVER_HEIGHT);

    for (const o of this.state.obstacles) {
      if (!o.active) continue;

      // Every motion envelope reaches at least as far forward as its center.
      // Most live slots are still ahead: avoid their yaw trigonometry here.
      if (o.cs < behind && obstacleTrailingEdge(o) < behind) {
        this.analysis.rememberObstacle(o);
        this.pools.releaseObstacle(o);
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
                this.state.events.emit("slabFall", { x: o.cx, s: o.cs });
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
        case Motion.Blink: {
          const raw = t * o.m0 + o.m1;
          const phase = raw - Math.floor(raw);
          // Fire moment: the phase wrapped into the ON window this step.
          if (phase < o.state && alive) {
            const ahead = o.cs - craftS;
            if (ahead > -6 && ahead < 70) this.state.events.emit("beamFire", { x: o.cx, s: o.cs });
          }
          o.state = phase;
          break;
        }
        case Motion.Serpent: {
          const dip = 0.5 + 0.5 * Math.sin(t * o.m0 + o.m1);
          o.cy = o.y - o.m2 * dip;
          o.cx = o.x + Math.sin(t * o.m0 * 0.63 + o.m1 * 1.7) * SERPENT.WOBBLE;
          break;
        }
      }

      // Ramps are rideable surfaces, never colliders or danger: the vertical
      // step reads them directly. They stay `collidable` so the validator
      // and gap-scanning bots route ground traffic around the deck.
      if (!alive || !o.collidable || o.kind === "ramp") continue;
      // Pulse beams only exist while their duty window is ON: no collision
      // and no clearance credit while phased out (passes still confirm).
      const beamOff = o.kind === "beam" && o.motion === Motion.Blink && o.state >= o.m2;

      // Broad phase along track.
      const dS = craftS - o.cs;
      const absDS = Math.abs(dS);

      // Danger sample. Availability: is there anything to dodge in this
      // stretch at all? Engagement: is the craft's line actually near it?
      // Only geometry in the craft's vertical band counts — an arch crossbar
      // overhead is scenery, not danger. Overflight credit (fun-frontier
      // 6.2): an AIRBORNE craft samples the ground band instead, so vaulting
      // dense geometry keeps the engaged score stream alive — choosing to
      // fly over the thickest line pays like threading it.
      if (absDS < DANGER.S_WINDOW) {
        // Rings gauge danger by their tube band (hy): a grounded ring rim
        // fills the craft band exactly as before, while a skyhook air ring
        // far overhead never inflates ground availability.
        const vHalf = o.hy;
        const dLo = this.state.airborne ? CRAFT.Y_MIN : yLo;
        const dHi = this.state.airborne ? CRAFT.Y_MAX : yHi;
        if (o.cy - vHalf < dHi && o.cy + vHalf > dLo) {
          const ws = 1 - absDS / DANGER.S_WINDOW;
          availDensity += ws;
          const effHx = o.kind === "ring"
            ? o.hx
            : Math.abs(Math.cos(o.cyaw)) * o.hx + Math.abs(Math.sin(o.cyaw)) * o.hs;
          const dxEdge = Math.max(0, Math.abs(o.cx - this.state.x) - effHx - CRAFT.RADIUS);
          if (dxEdge < DANGER.X_REACH) {
            engageDensity += ws * (1 - dxEdge / DANGER.X_REACH);
          }
        }
      }

      // hx + hs bounds every yaw, including rotating boxes. Only the few
      // nearby colliders need their exact projected footprint this tick.
      let withinS = false;
      if (absDS < o.hx + o.hs + stepLen + CRAFT.RADIUS + 1.5) {
        const sExtent = o.motion === Motion.RotateYaw
          ? Math.hypot(o.hx, o.hs)
          : Math.abs(Math.cos(o.cyaw)) * o.hs + Math.abs(Math.sin(o.cyaw)) * o.hx;
        withinS = absDS < sExtent + stepLen + CRAFT.RADIUS + 1.5;
      }

      if (withinS && !beamOff) {
        // Vertical overlap (movers use current cy, band follows the craft).
        const yOverlap = o.cy - o.hy < yHi && o.cy + o.hy > yLo;
        if (yOverlap) {
          let hit = false;
          let clearance = Infinity;

          if (o.kind === "ring") {
            const inS = Math.abs(dS) < o.hs + stepLen * 0.5 + CRAFT.RADIUS * 0.5;
            if (inS) {
              const dx = this.state.x - o.cx;
              const dy = this.state.y - o.cy;
              const r = Math.hypot(dx, dy);
              const innerEdge = o.inner - CRAFT.RADIUS * 0.4;
              const outerEdge = o.hx + CRAFT.RADIUS * 0.6;
              if (r > innerEdge && r < outerEdge) hit = true;
              else clearance = r <= innerEdge ? innerEdge - r : r - outerEdge;
            }
          } else {
            const distSq = circleObbDistSq(
              this.state.x, craftS,
              o.cx, o.cs,
              o.hx, o.hs + stepLen * 0.5,
              o.cyaw,
            );
            const rr = CRAFT.RADIUS;
            if (distSq < rr * rr) hit = true;
            clearance = Math.max(0, Math.sqrt(distSq) - rr);
          }

          if (hit && o.kind === "bumper") {
            // Elastic contact can eject the craft off the track. Cooldown rides
            // in `state` so an overlapping frame can't machine-gun flings.
            if (this.state.time >= o.state) this.contacts.onBounce(o);
            if (this.state.status !== "running") return;
            continue;
          }
          if (hit && o.kind === "glass" && this.state.boostCharge >= GLASS.SMASH_CHARGE) {
            // Boost is the key: plow through, shower of shards, keep flying.
            this.contacts.onShatter(o);
            continue;
          }

          // Kill-cam trace: tightest hull clearance this sample window.
          this.analysis.observeClearance(hit ? 0 : clearance);

          if (hit) {
            // A collision cannot also pay out as a precision pass, including
            // contacts absorbed during shield iframes.
            o.nearMissed = true;
            if (this.state.iframes <= 0) {
              // FallY slabs still in the air far above can't hit the craft
              // (yOverlap already filtered), so any hit here is real.
              this.contacts.onHit(o);
              if (this.state.status !== "running") return;
            }
          } else if (
            !o.nearMissed &&
            o.motion !== Motion.FallY && // state doubles as fall velocity there
            clearance < THREAD.CLEARANCE
          ) {
            // Keep the true closest approach (and its side); payout happens
            // once fully passed. The wider THREAD band also tracks "pressed"
            // passes that only matter as thread partners.
            if (clearance < o.nearMissClearance) {
              o.nearMissClearance = clearance;
              o.nearMissSide = o.cx >= this.state.x ? 1 : -1;
            }
          }
        }
      }

      // Pass confirmation: obstacle fully behind the craft.
      if (
        !o.nearMissed &&
        o.nearMissClearance < THREAD.CLEARANCE &&
        o.motion !== Motion.FallY && // Falling slabs feel arbitrary for near-miss credit.
        obstacleTrailingEdge(o) < craftS - CRAFT.RADIUS
      ) {
        o.nearMissed = true;
        if (alive) this.contacts.onPassConfirmed(o);
      }
    }

    if (alive) {
      const engagement = 1 - Math.exp(-engageDensity / DANGER.REF_ENGAGE);
      const availability = 1 - Math.exp(-availDensity / DANGER.REF_AVAIL);
      this.state.dangerFactor =
        1 + DANGER.BONUS * engagement - DANGER.PENALTY * availability * (1 - engagement);
    }
  }

}
