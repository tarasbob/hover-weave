import { overdriveAt, TRACK } from "../core/constants";
import type { Rng } from "../core/rng";
import { Motion, type PatternCategory, type PatternResult } from "../core/types";

const XP = TRACK.X_PATTERN;

/**
 * Post-build randomizers that keep runs unpredictable. Every mutated result
 * still goes through the reachability validator, so fairness is preserved —
 * a mutation that blocks the track simply gets rejected and rebuilt.
 */
export interface MutationLog {
  mirrored: boolean;
  scatterAdded: number;
  jittered: boolean;
  moverBoost: number;
}

export function mutatePattern(
  rng: Rng,
  result: PatternResult,
  s0: number,
  category: PatternCategory,
  entryX = 0,
  difficulty = 0,
): MutationLog {
  const log: MutationLog = { mirrored: false, scatterAdded: 0, jittered: false, moverBoost: 1 };
  // Late-game aggression channel: probabilities cap, magnitudes grow slowly
  // (log) — determinism is safe because od is a pure function of s0 and no
  // rng draw becomes conditional on it.
  const od = overdriveAt(s0);

  // Mirror the whole pattern left<->right. Only safe when the entry corridor
  // is roughly centered — patterns author their lead-in relative to entryX,
  // and mirroring around x=0 would strand an off-center entry.
  if (Math.abs(entryX) < 3 && rng.chance(0.5)) {
    log.mirrored = true;
    for (const o of result.obstacles) {
      o.x = -o.x;
      if (o.yaw !== undefined) o.yaw = -o.yaw;
      if (o.motion === Motion.SweepX || o.motion === Motion.Piston) o.m2 = -(o.m2 ?? 0);
      if (o.motion === Motion.CloseIn) o.m0 = -(o.m0 ?? 0);
      // Pendulum swings are symmetric — pivot flip is enough.
      if (o.vx0 !== undefined && o.vx1 !== undefined) {
        const v0 = o.vx0;
        o.vx0 = -o.vx1;
        o.vx1 = -v0;
      }
    }
    for (const p of result.pickups) p.x = -p.x;
    result.exitX = -result.exitX;
  }

  // Positional jitter on free-standing obstacles (walls and wide slabs are
  // left alone so corridors keep their authored shape).
  if (category !== "setpiece" && rng.chance(Math.min(0.92, 0.26 + difficulty * 0.24 + od * 0.08))) {
    log.jittered = true;
    const odScale = 1 + Math.min(1, od * 0.22);
    for (const o of result.obstacles) {
      if (o.hx > 6 || o.motion) continue;
      const jitter = (0.8 + difficulty * 0.8) * odScale;
      o.x += rng.range(-jitter, jitter);
      o.s += rng.range(-1.8 - difficulty, 1.8 + difficulty) * odScale;
    }
  }

  // Speed up movers a touch (more often, and harder, deep in overdrive).
  if (rng.chance(Math.min(0.9, 0.14 + difficulty * 0.34 + od * 0.1))) {
    log.moverBoost = rng.range(1.04, 1.2 + difficulty * 0.34 + Math.min(0.6, od * 0.15));
    for (const o of result.obstacles) {
      switch (o.motion) {
        case Motion.SweepX:
        case Motion.RotateYaw:
        case Motion.Piston:
          o.m0 = (o.m0 ?? 0) * log.moverBoost;
          break;
        case Motion.OrbitXZ:
          o.m1 = (o.m1 ?? 0) * log.moverBoost;
          break;
        case Motion.Pendulum:
          o.m2 = (o.m2 ?? 0) * log.moverBoost;
          break;
      }
    }
  }

  // Sprinkle a few extra loose objects over normal patterns so even a
  // memorized layout stays alive. (Fields are already chaos; set-pieces stay
  // authored.)
  if (category === "normal" && rng.chance(Math.min(0.9, 0.2 + difficulty * 0.24 + od * 0.1))) {
    const n = rng.int(2, 4 + Math.round(difficulty * 3) + Math.round(Math.min(4, od * 1.2)));
    for (let i = 0; i < n; i++) {
      const s = s0 + rng.range(14, result.length - 10);
      const x = rng.range(-XP + 3, XP - 3);
      // Keep clear of authored pickups (don't bury reward lines).
      if (result.pickups.some((p) => Math.abs(p.s - s) < 8 && Math.abs(p.x - x) < 5)) continue;
      const w = rng.range(0.7, 1.6);
      const hy = rng.range(1.4, 4);
      const kind = rng.chance(0.45) ? "crystal" : rng.chance(0.5) ? "pillar" : "box";
      result.obstacles.push({
        kind,
        x,
        s,
        y: hy, // Grounded.
        hx: w,
        hy,
        hs: w,
        yaw: kind === "crystal" ? rng.range(0, Math.PI) : 0,
        role: rng.chance(0.2) ? "dim" : "primary",
      });
      log.scatterAdded++;
    }
  }

  return log;
}
