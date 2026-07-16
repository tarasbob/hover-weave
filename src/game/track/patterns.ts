import { TRACK } from "../core/constants";
import { clamp, lerp } from "../core/mathUtils";
import {
  Motion,
  type BuildCtx,
  type ObstacleSpec,
  type PatternDef,
  type PatternResult,
  type PickupSpec,
  type RouteChoiceSpec,
} from "../core/types";
import { PATH_SLOPE, pathSlopeAt } from "./validator";

const XP = TRACK.X_PATTERN;
/** Working slope for pattern authoring (margin under the validator slope). */
const SLOPE = PATH_SLOPE * 0.8;

/** Ground-standing box. */
export function box(
  x: number, s: number, hx: number, hy: number, hs: number,
  extra: Partial<ObstacleSpec> = {},
): ObstacleSpec {
  return { kind: "box", x, s, y: hy, hx, hy, hs, ...extra };
}

/** Two wall segments leaving a gap [gapX - gapHalf, gapX + gapHalf]. */
export function gateRow(
  s: number, gapX: number, gapHalf: number, hy: number, hs = 0.9,
  extra: Partial<ObstacleSpec> = {},
): ObstacleSpec[] {
  const out: ObstacleSpec[] = [];
  const leftEnd = gapX - gapHalf;
  const rightStart = gapX + gapHalf;
  if (leftEnd > -XP) {
    const hx = (leftEnd + XP) / 2;
    out.push(box(-XP + hx, s, hx, hy, hs, extra));
  }
  if (rightStart < XP) {
    const hx = (XP - rightStart) / 2;
    out.push(box(rightStart + hx, s, hx, hy, hs, extra));
  }
  return out;
}

/** Wall segments leaving multiple authored gaps, ordered left to right. */
export function multiGapRow(
  s: number,
  gaps: { x: number; half: number }[],
  hy: number,
  hs = 1,
  extra: Partial<ObstacleSpec> = {},
): ObstacleSpec[] {
  const out: ObstacleSpec[] = [];
  let cursor = -XP;
  for (const gap of [...gaps].sort((a, b) => a.x - b.x)) {
    const start = clamp(gap.x - gap.half, -XP, XP);
    const end = clamp(gap.x + gap.half, -XP, XP);
    if (start > cursor) {
      const half = (start - cursor) / 2;
      out.push(box(cursor + half, s, half, hy, hs, extra));
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < XP) {
    const half = (XP - cursor) / 2;
    out.push(box(cursor + half, s, half, hy, hs, extra));
  }
  return out;
}

export function shardLine(
  s0: number,
  x: number,
  count: number,
  spacing = 3.2,
  magnet = true,
): PickupSpec[] {
  const out: PickupSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ type: "shard", s: s0 + i * spacing, x, y: 1.3, magnet });
  }
  return out;
}

/**
 * Forward distance needed so that a craft anywhere in the entry corridor can
 * legally reach the gap [gapX ± gapHalf].
 */
export function leadInDist(ctx: BuildCtx, gapX: number, gapHalf: number): number {
  const worst = Math.abs(gapX - ctx.entryX) + ctx.entryHalf - gapHalf;
  return Math.max(14, worst / SLOPE + 8);
}

/** Distance to move a gap center by `shift` while halves change ha -> hb. */
const rowRun = (shift: number, ha: number, hb: number) =>
  (Math.abs(shift) + Math.max(0, ha - hb)) / SLOPE;

/**
 * Segmented converging walls from the entry corridor down to a target gap.
 * Returns the s at which the corridor reaches the target.
 */
export function funnelTo(
  ctx: BuildCtx,
  out: ObstacleSpec[],
  targetX: number,
  targetHalf: number,
  hy = 3,
  role: ObstacleSpec["role"] = "dim",
): number {
  const startHalf = ctx.entryHalf + 2.5;
  const startX = ctx.entryX;
  const run = Math.max(
    18,
    (Math.abs(targetX - startX) + Math.max(0, startHalf - targetHalf)) / SLOPE + 6,
  );
  const segLen = 9;
  const segs = Math.ceil(run / segLen);
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const half = lerp(startHalf, targetHalf, t);
    const cx = lerp(startX, targetX, t);
    const s = ctx.s0 + (i + 0.5) * segLen;
    const lw = cx - half;
    const rw = cx + half;
    if (lw > -XP) out.push(box((-XP + lw) / 2, s, (lw + XP) / 2, hy, segLen / 2 + 0.5, { role }));
    if (rw < XP) out.push(box((rw + XP) / 2, s, (XP - rw) / 2, hy, segLen / 2 + 0.5, { role }));
  }
  return ctx.s0 + segs * segLen;
}

// ---------------------------------------------------------------------------
// Breather
// ---------------------------------------------------------------------------

const openField: PatternDef = {
  id: "openField",
  category: "breather",
  intensity: 1,
  skills: ["navigation"],
  weight: 1,
  minDifficulty: 0,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0 } = ctx;
    const length = rng.range(70, 110);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const side = rng.sign();
      const x = side * rng.range(16, 28);
      obstacles.push(
        box(x, s0 + rng.range(16, length - 12), rng.range(1, 1.8), rng.range(3, 7), rng.range(1, 1.8), {
          kind: rng.chance(0.5) ? "pillar" : "crystal",
          role: "dim",
        }),
      );
    }
    const sx = clamp(ctx.entryX + rng.range(-4, 4), -20, 20);
    pickups.push(...shardLine(s0 + 18, sx, 5, 4));
    return { length, exitX: ctx.entryX, exitHalf: XP - 4, obstacles, pickups };
  },
};

// ---------------------------------------------------------------------------
// Normal patterns
// ---------------------------------------------------------------------------

const pillarForest: PatternDef = {
  id: "pillarForest",
  category: "field",
  intensity: 2,
  skills: ["navigation", "reaction"],
  weight: 1.6,
  minDifficulty: 0,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const length = rng.range(120, 220);
    const obstacles: ObstacleSpec[] = [];
    const spacing = lerp(19, 11, d);
    for (let s = 16; s < length - 6; s += spacing * rng.range(0.75, 1.35)) {
      const count = rng.int(1, d > 0.5 ? 3 : 2);
      for (let i = 0; i < count; i++) {
        const x = rng.range(-XP + 3, XP - 3);
        const w = rng.range(0.9, 2);
        const kind = rng.chance(0.35) ? "crystal" : rng.chance(0.5) ? "pillar" : "box";
        obstacles.push(
          box(x, s0 + s + rng.range(-2, 2), w, rng.range(3.5, 9), w, {
            kind,
            role: rng.chance(0.15) ? "accent" : "primary",
            yaw: kind === "crystal" ? rng.range(0, Math.PI) : 0,
          }),
        );
      }
    }
    return { length, exitX: 0, exitHalf: XP - 4, obstacles, pickups: [] };
  },
};

/**
 * The signature "everything field": a long stretch of randomly scattered
 * objects of every kind. Density ramps with difficulty; movers sneak in at
 * higher levels. Long enough that the player has to read and improvise.
 */
const chaosField: PatternDef = {
  id: "chaosField",
  category: "field",
  intensity: 3,
  skills: ["navigation", "reaction"],
  weight: 2.4,
  minDifficulty: 0.04,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const length = rng.range(220, 420);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const rowStep = lerp(17, 9.5, d);

    for (let s = 18; s < length - 10; s += rowStep * rng.range(0.7, 1.45)) {
      const count = rng.weighted([lerp(3, 1, d), 2.2, lerp(0.4, 1.6, d)]) + 1; // 1..3
      for (let i = 0; i < count; i++) {
        const x = rng.range(-XP + 2.5, XP - 2.5);
        const as = s0 + s + rng.range(-3, 3);
        const roll = rng.next();

        if (roll < 0.3) {
          // Cube / slab.
          const w = rng.range(0.8, 2.4);
          obstacles.push(box(x, as, w, rng.range(1.2, 4.5) * rng.range(0.7, 1.6), w * rng.range(0.8, 1.5), {
            yaw: rng.chance(0.4) ? rng.range(-0.6, 0.6) : 0,
            role: rng.chance(0.12) ? "accent" : "primary",
          }));
        } else if (roll < 0.52) {
          // Pillar.
          obstacles.push(box(x, as, rng.range(0.8, 1.7), rng.range(3, 10), rng.range(0.8, 1.7), {
            kind: "pillar",
            role: rng.chance(0.2) ? "dim" : "primary",
          }));
        } else if (roll < 0.76) {
          // Crystal, tilted.
          const w = rng.range(0.9, 2.2);
          obstacles.push(box(x, as, w, rng.range(2, 6.5), w, {
            kind: "crystal",
            yaw: rng.range(0, Math.PI),
            role: rng.chance(0.25) ? "accent" : "primary",
          }));
        } else if (roll < 0.9) {
          // Sphere — drifting at higher difficulty.
          const drift = d > 0.35 && rng.chance(lerp(0, 0.55, d));
          obstacles.push({
            kind: "sphere", x, s: as, y: rng.range(1.2, 1.9),
            hx: rng.range(1, 1.9), hy: rng.range(1, 1.9), hs: rng.range(1, 1.9),
            role: drift ? "warn" : rng.chance(0.5) ? "accent" : "primary",
            glow: drift ? 1.4 : 1.1,
            motion: drift ? Motion.SweepX : Motion.None,
            m0: rng.range(0.5, 1),
            m1: rng.range(0, Math.PI * 2),
            m2: drift ? rng.range(1.5, 3.2) : 0,
          });
        } else if (roll < 0.965 || d < 0.5) {
          // Ring gate dropped into the chaos.
          const inner = rng.range(3, 4.4);
          obstacles.push({
            kind: "ring", x: clamp(x, -XP + 8, XP - 8), s: as, y: 1.2,
            hx: inner + rng.range(1.3, 1.9), hy: 0.5, hs: 0.5, inner,
            role: rng.chance(0.5) ? "accent" : "primary", glow: 1.3,
          });
        } else {
          // Rare short rotor blade (high difficulty only).
          obstacles.push(box(x, as, 1, 5, 1, { kind: "pillar", role: "dim" }));
          obstacles.push({
            kind: "box", x, s: as, y: 1.3,
            hx: rng.range(3.6, 5), hy: 0.6, hs: 0.5,
            role: "warn", glow: 1.6,
            motion: Motion.RotateYaw,
            m0: rng.sign() * rng.range(1, 1.7),
            m1: rng.range(0, Math.PI * 2),
            m2: 0,
          });
        }
      }
      if (rng.chance(0.16)) {
        pickups.push({ type: "shard", s: s0 + s + rowStep * 0.5, x: rng.range(-18, 18), y: 1.3 });
      }
    }
    return { length, exitX: 0, exitHalf: XP - 4, obstacles, pickups };
  },
};

/** Sparser all-moving field: everything drifts, bobs, or orbits. */
const asteroidDrift: PatternDef = {
  id: "asteroidDrift",
  category: "field",
  intensity: 4,
  skills: ["reaction", "rhythm"],
  weight: 1.1,
  minDifficulty: 0.18,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const length = rng.range(200, 320);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const rowStep = lerp(24, 14, d);

    for (let s = 20; s < length - 12; s += rowStep * rng.range(0.75, 1.4)) {
      const x = rng.range(-XP + 5, XP - 5);
      const as = s0 + s + rng.range(-3, 3);
      if (rng.chance(0.6)) {
        // Drifting asteroid (sphere or crystal).
        const isCrystal = rng.chance(0.45);
        obstacles.push({
          kind: isCrystal ? "crystal" : "sphere",
          x, s: as, y: rng.range(1.2, 1.9),
          hx: rng.range(1.1, 2.1), hy: rng.range(1.1, 2.4), hs: rng.range(1.1, 2.1),
          yaw: isCrystal ? rng.range(0, Math.PI) : 0,
          role: rng.chance(0.35) ? "accent" : "primary",
          glow: 1.15,
          motion: Motion.SweepX,
          m0: rng.range(0.35, 0.85),
          m1: rng.range(0, Math.PI * 2),
          m2: rng.range(1.8, 4),
        });
      } else if (rng.chance(0.55)) {
        // Orbiting pair around an empty center.
        const r = rng.range(4, 6.5);
        const angSpeed = rng.sign() * rng.range(0.5, 0.9);
        const phase = rng.range(0, Math.PI);
        for (let k = 0; k < 2; k++) {
          obstacles.push({
            kind: "sphere", x, s: as, y: 1.5,
            hx: 1.1, hy: 1.1, hs: 1.1,
            role: "warn", glow: 1.4,
            motion: Motion.OrbitXZ,
            m0: r,
            m1: angSpeed,
            m2: k * Math.PI + phase,
          });
        }
      } else {
        // Slow pendulum boulder.
        obstacles.push({
          kind: "sphere",
          x: clamp(x, -XP + 10, XP - 10), s: as, y: 11,
          hx: 1.5, hy: 1.5, hs: 1.5,
          role: "warn", glow: 1.3,
          motion: Motion.Pendulum,
          m0: 9.6,
          m1: rng.range(0.4, 0.65),
          m2: rng.range(0.9, 1.5),
        });
      }
      if (rng.chance(0.2)) {
        pickups.push({ type: "shard", s: as + rowStep * 0.5, x: rng.range(-16, 16), y: 1.3 });
      }
    }
    return { length, exitX: 0, exitHalf: XP - 5, obstacles, pickups };
  },
};

const slalomGates: PatternDef = {
  id: "slalomGates",
  category: "normal",
  intensity: 1,
  skills: ["precision"],
  weight: 1.2,
  minDifficulty: 0.05,
  maxDifficulty: 1,
  maxEntryHalf: 22,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(4, 6);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    let gh = lerp(6.6, 4, d) + rng.range(-0.3, 0.5);
    let gx = clamp(ctx.entryX + rng.range(-4, 4), -12, 12);
    let s = s0 + leadInDist(ctx, gx, gh);
    for (let r = 0; r < rows; r++) {
      obstacles.push(...gateRow(s, gx, gh, rng.range(2.6, 4.2)));
      if (rng.chance(0.4)) pickups.push({ type: "shard", s, x: gx, y: 1.3 });
      if (r === rows - 1) break;
      const shift = rng.range(6, 12) * rng.sign();
      const nx = clamp(gx + shift, -13, 13);
      const nh = lerp(6.6, 4, d) + rng.range(-0.3, 0.5);
      s += Math.max(lerp(30, 22, d) * rng.range(0.85, 1.4), rowRun(nx - gx, gh, nh) + 6);
      gx = nx;
      gh = nh;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups };
  },
};

const narrowGates: PatternDef = {
  id: "narrowGates",
  category: "normal",
  intensity: 3,
  skills: ["precision", "commitment"],
  weight: 1,
  minDifficulty: 0.22,
  maxDifficulty: 1,
  maxEntryHalf: 16,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(3, 5);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const gh = lerp(4.6, 3.2, d) + rng.range(0, 0.5);
    let gx = clamp(ctx.entryX + rng.range(-3, 3), -10, 10);
    let s = s0 + leadInDist(ctx, gx, gh);
    for (let r = 0; r < rows; r++) {
      obstacles.push(...gateRow(s, gx, gh, rng.range(3.2, 5.5), 1.1, { role: "primary" }));
      pickups.push({ type: "shard", s: s + 10, x: gx, y: 1.3 });
      if (r === rows - 1) break;
      const shift = rng.range(4, 8) * rng.sign();
      const nx = clamp(gx + shift, -11, 11);
      s += Math.max(lerp(30, 24, d) * rng.range(0.85, 1.4), rowRun(nx - gx, gh, gh) + 6);
      gx = nx;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups };
  },
};

/** Funnel mouth + swaying canyon corridor. */
const sCurveCanyon: PatternDef = {
  id: "sCurveCanyon",
  category: "normal",
  intensity: 2,
  skills: ["commitment", "navigation"],
  weight: 1.1,
  minDifficulty: 0.15,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const half = lerp(9.5, 6, d);
    const startX = clamp(ctx.entryX * 0.5, -8, 8);
    const canyonStart = funnelTo(ctx, obstacles, startX, half + 1.5, rng.range(3.5, 5));
    const innerLen = rng.range(100, 140);
    const waves = rng.range(0.7, 1.1);
    const ampMax = (SLOPE * 0.9 * innerLen) / (2 * Math.PI * waves);
    const amp = Math.min(lerp(8, 14, d), ampMax);
    const segLen = 7;
    const phase = rng.chance(0.5) ? 0 : Math.PI;
    let cx = startX;
    for (let s = 0; s < innerLen; s += segLen) {
      const t = s / innerLen;
      cx = startX + Math.sin(phase + t * Math.PI * 2 * waves) * amp - Math.sin(phase) * amp * (1 - t * 0.2);
      const hy = rng.range(3, 5.5);
      const lw = cx - half;
      const rw = cx + half;
      if (lw > -XP) obstacles.push(box((-XP + lw) / 2, canyonStart + s, (lw + XP) / 2, hy, segLen / 2 + 0.4, { role: "dim" }));
      if (rw < XP) obstacles.push(box((rw + XP) / 2, canyonStart + s, (XP - rw) / 2, hy, segLen / 2 + 0.4, { role: "dim" }));
      if (s % 21 < segLen) pickups.push({ type: "shard", s: canyonStart + s, x: cx, y: 1.3 });
    }
    const length = canyonStart + innerLen - s0 + 14;
    return { length, exitX: cx, exitHalf: half - 1, obstacles, pickups };
  },
};

/** Alternating half-walls; slope-legal weave. */
const zipper: PatternDef = {
  id: "zipper",
  category: "normal",
  intensity: 3,
  skills: ["commitment"],
  weight: 1,
  minDifficulty: 0.1,
  maxDifficulty: 0.9,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(4, 6);
    const obstacles: ObstacleSpec[] = [];
    // Wall tip reaches `reach` past center (negative = stops short).
    const reach = lerp(-6, 3, d);
    let side = rng.sign();
    // First wall: craft must be able to clear the tip from anywhere in entry.
    const firstOpenHalf = (XP - Math.abs(reach)) / 2;
    let s = s0 + leadInDist(ctx, side > 0 ? -(XP + reach) / 2 : (XP + reach) / 2, firstOpenHalf * 0.8);
    // Row spacing: crossing from one open side to the other must be legal.
    const crossDist = (2 * Math.abs(reach) + 14) / SLOPE;
    const rowGap = Math.max(lerp(34, 27, d), crossDist * 0.55);
    for (let r = 0; r < rows; r++) {
      const end = side * -(reach + rng.range(-1, 1));
      const hy = rng.range(2.8, 4.6);
      if (side > 0) {
        const hx = (XP - end) / 2;
        obstacles.push(box(end + hx, s, hx, hy, 1, { role: r % 2 ? "primary" : "accent" }));
      } else {
        const hx = (end + XP) / 2;
        obstacles.push(box(end - hx, s, hx, hy, 1, { role: r % 2 ? "primary" : "accent" }));
      }
      side = -side;
      s += rowGap * rng.range(1, 1.35);
    }
    return { length: s - s0 + 12, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

const combTeeth: PatternDef = {
  id: "combTeeth",
  category: "normal",
  intensity: 3,
  skills: ["precision", "reaction"],
  weight: 0.9,
  minDifficulty: 0.18,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(3, 4);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    let s = s0 + 18;
    for (let r = 0; r < rows; r++) {
      // Per-row pitch/gap so no two combs read the same.
      const pitch = lerp(14.5, 11, d) * rng.range(0.9, 1.15);
      const offset = rng.range(-pitch / 2, pitch / 2);
      const toothHalf = pitch / 2 - lerp(4.1, 3.2, d);
      for (let x = -XP + offset; x < XP; x += pitch) {
        const cx = x + pitch / 2;
        if (Math.abs(cx) > XP) continue;
        obstacles.push(
          box(cx, s, toothHalf, rng.range(3, 6), 0.8, {
            role: "primary",
            kind: rng.chance(0.3) ? "pillar" : "box",
          }),
        );
      }
      if (rng.chance(0.5)) {
        pickups.push({ type: "shard", s, x: rng.range(-16, 16), y: 1.3 });
      }
      s += lerp(40, 30, d) * rng.range(0.85, 1.3);
    }
    return { length: s - s0 + 14, exitX: 0, exitHalf: XP - 5, obstacles, pickups };
  },
};

/** Sweeping walls alternating sides; static outer gaps always survive. */
const oscillatingWalls: PatternDef = {
  id: "oscillatingWalls",
  category: "normal",
  intensity: 4,
  skills: ["rhythm", "reaction"],
  weight: 0.9,
  minDifficulty: 0.3,
  maxDifficulty: 1,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(3, 4);
    const obstacles: ObstacleSpec[] = [];
    const hw = lerp(4.5, 6, d);
    const amp = rng.range(3, 4.5);
    // Worst-case envelope half-width of each sweeping wall.
    const env = hw + amp;
    let side = rng.sign();
    const baseOff = 9;
    // Passing side switches every row: need legal cross distance.
    const crossDist = (2 * (baseOff + env) - 20) / SLOPE;
    const rowGap = Math.max(lerp(44, 34, d), crossDist * 0.5, 30);
    let s = s0 + leadInDist(ctx, -side * 18, 9);
    for (let r = 0; r < rows; r++) {
      obstacles.push(
        box(side * baseOff, s, hw, rng.range(3, 4.5), 1, {
          role: "warn",
          motion: Motion.SweepX,
          m0: rng.range(0.9, 1.5) * lerp(1, 1.5, d),
          m1: rng.range(0, Math.PI * 2),
          m2: amp,
          glow: 1.4,
        }),
      );
      side = -side;
      s += rowGap;
    }
    return { length: s - s0 + 12, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

/** Funnelled corridor with side pistons slamming in, alternating. */
const pistonCorridor: PatternDef = {
  id: "pistonCorridor",
  category: "normal",
  intensity: 4,
  skills: ["rhythm", "commitment"],
  weight: 0.9,
  minDifficulty: 0.35,
  maxDifficulty: 1,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(3, 5);
    const gap = lerp(44, 34, d);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const wallX = 20;
    const corridorStart = funnelTo(ctx, obstacles, 0, wallX, 5);
    let side = rng.sign();
    let ps = corridorStart + 16;
    for (let i = 0; i < count; i++) {
      const stroke = lerp(12, 15, d); // Rest gap on the far side stays >= ~9m wide.
      const headHalf = 3.4;
      const baseX = side * (wallX + headHalf - 0.5);
      obstacles.push({
        kind: "box",
        x: baseX,
        s: ps,
        y: 2.2,
        hx: headHalf,
        hy: 2.2,
        hs: 2.2,
        role: "warn",
        glow: 1.6,
        motion: Motion.Piston,
        m0: rng.range(0.42, 0.6) * lerp(1, 1.3, d),
        m1: rng.range(0, 1),
        m2: -side * stroke,
      });
      pickups.push({ type: "shard", s: ps, x: -side * (wallX - 7), y: 1.3 });
      // Occasionally repeat the same side to punish autopilot rhythm.
      if (rng.chance(0.75)) side = -side;
      ps += gap * rng.range(0.8, 1.3);
    }
    // Corridor walls covering the actual (jittered) piston extent.
    const innerLen = ps - corridorStart - gap * 0.4;
    for (let s = 0; s < innerLen; s += 12) {
      obstacles.push(box(-(wallX + 5.5), corridorStart + s, 5, 5, 6.2, { role: "dim" }));
      obstacles.push(box(wallX + 5.5, corridorStart + s, 5, 5, 6.2, { role: "dim" }));
    }
    const length = corridorStart + innerLen - s0 + 12;
    return { length, exitX: 0, exitHalf: wallX - 5, obstacles, pickups };
  },
};

/** Swinging pendulum bobs; center channel always survives. */
const pendulumAlley: PatternDef = {
  id: "pendulumAlley",
  category: "normal",
  intensity: 3,
  skills: ["rhythm"],
  weight: 0.8,
  minDifficulty: 0.3,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(3, 5);
    const gap = lerp(40, 30, d);
    const obstacles: ObstacleSpec[] = [];
    let side = rng.sign();
    let s = s0 + 20;
    for (let i = 0; i < count; i++) {
      const pivotX = side * rng.range(9, 15);
      obstacles.push({
        kind: "sphere",
        x: pivotX,
        s,
        y: 12,
        hx: 1.4,
        hy: 1.4,
        hs: 1.4,
        role: "warn",
        glow: 1.5,
        motion: Motion.Pendulum,
        m0: 10.4,
        m1: rng.range(0.55, 0.72),
        m2: rng.range(1.3, 1.9),
      });
      if (rng.chance(0.8)) side = -side;
      s += gap * rng.range(0.8, 1.35);
    }
    return { length: s - s0 + 14, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

/** Spinning blade rotors on alternating sides. */
const bladeRotors: PatternDef = {
  id: "bladeRotors",
  category: "normal",
  intensity: 4,
  skills: ["rhythm", "precision"],
  weight: 0.8,
  minDifficulty: 0.4,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(2, 4);
    const gap = lerp(52, 40, d);
    const obstacles: ObstacleSpec[] = [];
    let side = rng.sign();
    let s = s0 + 24;
    for (let i = 0; i < count; i++) {
      const cx = side * rng.range(7, 12);
      obstacles.push(box(cx, s, 1.1, 6, 1.1, { kind: "pillar", role: "dim" }));
      obstacles.push({
        kind: "box",
        x: cx,
        s,
        y: 1.3,
        hx: rng.range(6.5, 8),
        hy: 0.7,
        hs: 0.55,
        role: "warn",
        glow: 1.6,
        motion: Motion.RotateYaw,
        m0: rng.sign() * rng.range(1.1, 1.9) * lerp(1, 1.4, d),
        m1: rng.range(0, Math.PI * 2),
        m2: 0,
      });
      if (rng.chance(0.8)) side = -side;
      s += gap * rng.range(0.8, 1.35);
    }
    return { length: s - s0 + 14, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

/** Slabs slam down into gate rows ahead of the craft. */
const collapsingBridge: PatternDef = {
  id: "collapsingBridge",
  category: "normal",
  intensity: 3,
  skills: ["reaction", "commitment"],
  weight: 0.85,
  minDifficulty: 0.25,
  maxDifficulty: 1,
  maxEntryHalf: 18,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d, speed } = ctx;
    const rows = rng.int(3, 5);
    const obstacles: ObstacleSpec[] = [];
    const lead = speed * 1.45 + 30;
    const gh = lerp(5.8, 4, d);
    let gx = clamp(ctx.entryX, -9, 9);
    let s = s0 + leadInDist(ctx, gx, gh);
    for (let r = 0; r < rows; r++) {
      for (const w of gateRow(s, gx, gh, 2.2, 1.4, { role: "warn", glow: 1.35 })) {
        obstacles.push({
          ...w,
          y: 30 + rng.range(0, 8),
          motion: Motion.FallY,
          m0: s - lead - rng.range(0, 18),
          m1: w.y,
        });
      }
      obstacles.push(
        box(gx, s, gh - 0.6, 0.06, 1.2, { role: "accent", glow: 2, collidable: false, noValidate: true }),
      );
      if (r === rows - 1) break;
      const shift = rng.range(5, 9) * rng.sign();
      const nx = clamp(gx + shift, -10, 10);
      s += Math.max(lerp(36, 27, d) * rng.range(0.85, 1.35), rowRun(nx - gx, gh, gh) + 6);
      gx = nx;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups: [] };
  },
};

/** Telegraphed crystal meteors crash into the field ahead. */
const meteorShower: PatternDef = {
  id: "meteorShower",
  category: "normal",
  intensity: 4,
  skills: ["reaction"],
  weight: 0.85,
  minDifficulty: 0.3,
  maxDifficulty: 1,
  biomes: [0, 2],
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d, speed } = ctx;
    const length = rng.range(110, 150);
    const obstacles: ObstacleSpec[] = [];
    const count = Math.round(lerp(6, 12, d));
    const lead = speed * 1.45 + 34;
    for (let i = 0; i < count; i++) {
      const s = s0 + 18 + (length - 34) * (i / count) + rng.range(0, 8);
      const x = rng.range(-XP + 4, XP - 4);
      const w = rng.range(1.2, 2.2);
      obstacles.push({
        kind: "crystal",
        x,
        s,
        y: 34 + rng.range(0, 14),
        hx: w,
        hy: rng.range(2.2, 3.4),
        hs: w,
        yaw: rng.range(0, Math.PI),
        role: "warn",
        glow: 1.5,
        motion: Motion.FallY,
        m0: s - lead - rng.range(0, 30),
        m1: rng.range(1.6, 2.2),
      });
      obstacles.push(
        box(x, s, w + 0.4, 0.06, w + 0.4, { role: "warn", glow: 2, collidable: false, noValidate: true }),
      );
    }
    return { length, exitX: 0, exitHalf: XP - 5, obstacles, pickups: [] };
  },
};

/** Big tilted crystals alternating sides. */
const crystalChicane: PatternDef = {
  id: "crystalChicane",
  category: "normal",
  intensity: 3,
  skills: ["precision"],
  weight: 1,
  minDifficulty: 0.12,
  maxDifficulty: 1,
  biomes: [0],
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(4, 6);
    const gap = lerp(34, 26, d) * rng.range(0.9, 1.2);
    const length = count * gap + 20;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    let side = rng.sign();
    for (let i = 0; i < count; i++) {
      const cx = side * lerp(14, 10, d) + side * rng.range(0, 3);
      const s = s0 + 18 + i * gap;
      obstacles.push(
        box(cx, s, rng.range(4, 6), rng.range(4, 8), rng.range(1.6, 2.4), {
          kind: "crystal",
          yaw: side * rng.range(0.25, 0.55),
          role: i % 2 ? "primary" : "accent",
        }),
      );
      if (rng.chance(0.45)) {
        pickups.push({ type: "shard", s: s + gap * 0.45, x: -side * 8, y: 1.3 });
      }
      side = -side;
    }
    return { length, exitX: 0, exitHalf: 13, obstacles, pickups };
  },
};

/** Bobbing spheres drifting on the swell. */
const buoySlalom: PatternDef = {
  id: "buoySlalom",
  category: "normal",
  intensity: 2,
  skills: ["navigation"],
  weight: 1,
  minDifficulty: 0.1,
  maxDifficulty: 0.95,
  biomes: [1],
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(5, 8);
    const gap = lerp(28, 20, d);
    const length = count * gap + 18;
    const obstacles: ObstacleSpec[] = [];
    let x = clamp(ctx.entryX, -8, 8);
    for (let i = 0; i < count; i++) {
      x = clamp(x + rng.range(4, Math.min(9, gap * SLOPE * 2)) * rng.sign(), -XP + 7, XP - 7);
      obstacles.push({
        kind: "sphere",
        x,
        s: s0 + 16 + i * gap,
        y: 1.4,
        hx: 1.7,
        hy: 1.7,
        hs: 1.7,
        role: i % 2 ? "accent" : "primary",
        glow: 1.2,
        motion: Motion.SweepX,
        m0: rng.range(0.5, 0.9),
        m1: rng.range(0, Math.PI * 2),
        m2: rng.range(1.2, 2.2),
      });
    }
    return { length, exitX: 0, exitHalf: XP - 6, obstacles, pickups: [] };
  },
};

/** Neon gate rings to thread. */
const ringTunnel: PatternDef = {
  id: "ringTunnel",
  category: "normal",
  intensity: 3,
  skills: ["precision"],
  weight: 1,
  minDifficulty: 0.15,
  maxDifficulty: 1,
  biomes: [1, 3],
  maxEntryHalf: 18,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(5, 8);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const inner = lerp(4.2, 3.1, d);
    let cx = clamp(ctx.entryX + rng.range(-3, 3), -8, 8);
    let s = s0 + leadInDist(ctx, cx, inner - 1);
    for (let i = 0; i < count; i++) {
      obstacles.push({
        kind: "ring",
        x: cx,
        s,
        y: 1.2,
        hx: inner + rng.range(1.4, 2),
        hy: 0.55,
        hs: 0.55,
        inner,
        role: i % 2 ? "primary" : "accent",
        glow: 1.4,
      });
      if (i % 2 === 0) pickups.push({ type: "shard", s, x: cx, y: 1.3 });
      if (i === count - 1) break;
      const shift = rng.range(3, 6) * rng.sign();
      const nx = clamp(cx + shift, -10, 10);
      s += Math.max(lerp(24, 18, d), rowRun(nx - cx, inner - 1, inner - 1) + 5);
      cx = nx;
    }
    return { length: s - s0 + 14, exitX: cx, exitHalf: inner, obstacles, pickups };
  },
};

/** Fast weave of rings along a sine — slope-capped. */
const hyperRings: PatternDef = {
  id: "hyperRings",
  category: "normal",
  intensity: 4,
  skills: ["precision", "commitment"],
  weight: 1.1,
  minDifficulty: 0.35,
  maxDifficulty: 1,
  biomes: [3],
  maxEntryHalf: 16,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(7, 10);
    const gap = lerp(18, 14, d);
    const innerLen = count * gap;
    const obstacles: ObstacleSpec[] = [];
    const waves = rng.range(0.8, 1.2);
    const ampMax = (SLOPE * 0.9 * innerLen) / (2 * Math.PI * waves);
    const amp = Math.min(lerp(6, 12, d), ampMax);
    const inner = lerp(3.8, 3, d);
    const start = s0 + leadInDist(ctx, clamp(ctx.entryX, -6, 6), inner - 1);
    const cx0 = clamp(ctx.entryX, -6, 6);
    let lastX = cx0;
    for (let i = 0; i < count; i++) {
      const t = i / count;
      lastX = cx0 * (1 - t) + Math.sin(t * Math.PI * 2 * waves) * amp;
      obstacles.push({
        kind: "ring",
        x: lastX,
        s: start + i * gap,
        y: 1.2,
        hx: inner + 1.6,
        hy: 0.5,
        hs: 0.5,
        inner,
        role: i % 3 === 0 ? "warn" : "primary",
        glow: 1.5,
      });
    }
    const length = start + innerLen - s0 + 14;
    return { length, exitX: lastX, exitHalf: inner, obstacles, pickups: [] };
  },
};

/** Alternating narrow gates with near-edge shard lines for deliberate grazes. */
const precisionLadder: PatternDef = {
  id: "precisionLadder",
  category: "normal",
  intensity: 4,
  skills: ["precision", "commitment"],
  weight: 1,
  minDifficulty: 0.4,
  maxDifficulty: 1,
  maxEntryHalf: 28,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(6, 8);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const gapHalf = lerp(4.1, 3.05, d);
    const slope = pathSlopeAt(d) * 0.82;
    let gx = clamp(ctx.entryX + rng.range(-2, 2), -8, 8);
    let side = rng.sign();
    let s = s0 + leadInDist(ctx, gx, gapHalf);
    for (let i = 0; i < rows; i++) {
      obstacles.push(...gateRow(s, gx, gapHalf, rng.range(3.2, 5.2), 1.25, {
        role: i % 3 === 2 ? "warn" : "primary",
        glow: i % 3 === 2 ? 1.55 : 1.15,
      }));
      // This line sits just inside the collision edge: valuable, but optional.
      pickups.push({
        type: "shard",
        s,
        x: gx + side * (gapHalf - 0.3),
        y: 1.3,
        magnet: false,
      });
      if (i === rows - 1) break;
      side = -side;
      const nx = clamp(gx + side * rng.range(4.5, 7.5), -11, 11);
      s += Math.max(21, Math.abs(nx - gx) / slope + 8);
      gx = nx;
    }
    return { length: s - s0 + 18, exitX: gx, exitHalf: gapHalf + 0.8, obstacles, pickups };
  },
};

/** Rapid side pistons; center survives while edge shards invite phase reads. */
const pulseWeave: PatternDef = {
  id: "pulseWeave",
  category: "normal",
  intensity: 4,
  skills: ["rhythm", "reaction"],
  weight: 0.9,
  minDifficulty: 0.48,
  maxDifficulty: 1,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    // Leave a generous open read before the first timed threat so every
    // surviving entry lane can converge, even after a split-exit pattern.
    const corridorStart = s0 + Math.max(58, leadInDist(ctx, 0, 8) + 24);
    const count = rng.int(5, 7);
    const gap = lerp(36, 27, d);
    let side = rng.sign();
    let s = corridorStart + 18;
    for (let i = 0; i < count; i++) {
      const baseX = side * 24;
      obstacles.push({
        kind: "box",
        x: baseX,
        s,
        y: 2.4,
        hx: 3.2,
        hy: 2.4,
        hs: 2.2,
        role: "warn",
        glow: 1.8,
        motion: Motion.Piston,
        m0: lerp(0.5, 0.78, d),
        m1: i * 0.41 + rng.range(-0.08, 0.08),
        m2: -side * lerp(11.5, 13.5, d),
      });
      pickups.push({ type: "shard", s, x: side * 7, y: 1.3, magnet: false });
      if (rng.chance(0.82)) side = -side;
      s += gap * rng.range(0.9, 1.12);
    }
    return { length: s - s0 + 16, exitX: 0, exitHalf: 8, obstacles, pickups };
  },
};

/** Paired rotors create a readable center rhythm and razor-thin reward edges. */
const rotorRhythm: PatternDef = {
  id: "rotorRhythm",
  category: "normal",
  intensity: 4,
  skills: ["rhythm", "precision"],
  weight: 0.85,
  minDifficulty: 0.52,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const rows = rng.int(4, 6);
    const gap = lerp(40, 29, d);
    const first = s0 + leadInDist(ctx, 0, 6);
    for (let row = 0; row < rows; row++) {
      const s = first + row * gap;
      for (const side of [-1, 1] as const) {
        const x = side * 14;
        obstacles.push(box(x, s, 1, 6.5, 1, { kind: "pillar", role: "dim" }));
        obstacles.push({
          kind: "box",
          x,
          s,
          y: 1.35,
          hx: 7,
          hy: 0.62,
          hs: 0.55,
          role: "warn",
          glow: 1.7,
          motion: Motion.RotateYaw,
          m0: side * (row % 2 ? -1 : 1) * lerp(1.35, 2.1, d),
          m1: row * 0.72 + (side > 0 ? Math.PI * 0.5 : 0),
        });
      }
      const rewardSide = row % 2 === 0 ? -1 : 1;
      pickups.push({ type: "shard", s: s + 2, x: rewardSide * 5.2, y: 1.3, magnet: false });
    }
    return {
      length: first + rows * gap - s0 + 14,
      exitX: 0,
      exitHalf: 6,
      obstacles,
      pickups,
    };
  },
};

/** Alternating wide and narrow forks force early route commitments. */
const splitDecision: PatternDef = {
  id: "splitDecision",
  category: "normal",
  intensity: 5,
  skills: ["commitment", "navigation", "precision"],
  weight: 1,
  minDifficulty: 0.66,
  maxDifficulty: 1,
  maxEntryHalf: 22,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const safeHalf = lerp(5, 4.2, d);
    const riskHalf = lerp(3.1, 2.45, d);
    const laneX = 7.5;
    const slope = pathSlopeAt(d) * 0.82;
    let safeSide = rng.sign();
    let s = s0 + leadInDist(ctx, safeSide * laneX, safeHalf);
    for (let row = 0; row < 4; row++) {
      const safeX = safeSide * laneX;
      const riskX = -safeSide * laneX;
      obstacles.push(...multiGapRow(
        s,
        [{ x: -laneX, half: safeSide < 0 ? safeHalf : riskHalf },
          { x: laneX, half: safeSide > 0 ? safeHalf : riskHalf }],
        5,
        1.4,
        { role: row === 3 ? "warn" : "primary", glow: row === 3 ? 1.6 : 1.2 },
      ));
      pickups.push(...shardLine(s - 5, riskX, 4, 3.2, false));
      if (row === 3) break;
      safeSide = -safeSide;
      const nextSafeX = safeSide * laneX;
      s += Math.max(42, Math.abs(nextSafeX - safeX) / slope + 9);
    }
    return {
      length: s - s0 + 20,
      exitX: safeSide * laneX,
      exitHalf: safeHalf,
      obstacles,
      pickups,
    };
  },
};

/**
 * A three-decision route lattice. Each row offers a wide refuel lane, a
 * narrow flow lane, and a beat-gated tempo lane; their positions rotate so
 * the useful choice depends on current resources and desired next position.
 */
const routeLattice: PatternDef = {
  id: "routeLattice",
  category: "normal",
  intensity: 5,
  skills: ["navigation", "commitment", "precision", "rhythm"],
  weight: 0.78,
  minDifficulty: 0.58,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const routes: RouteChoiceSpec[] = [];
    const laneXs = [-11, 0, 11];
    const energyHalf = lerp(5.4, 4.7, d);
    const flowHalf = lerp(3.05, 2.5, d);
    const tempoHalf = lerp(4.5, 3.8, d);
    // Enough lead-in for every lane of a fully open chained entry to reach
    // at least one branch under the conservative early validator slope.
    let s = s0 + 90;

    for (let row = 0; row < 3; row++) {
      const energyX = laneXs[row % 3];
      const flowX = laneXs[(row + 1) % 3];
      const tempoX = laneXs[(row + 2) % 3];
      obstacles.push(
        ...multiGapRow(
          s,
          [
            { x: energyX, half: energyHalf },
            { x: flowX, half: flowHalf },
            { x: tempoX, half: tempoHalf },
          ],
          5,
          1.25,
          { role: "primary", glow: 1.25 },
        ),
      );
      // The tempo branch is never required by the worst-case validator: its
      // blinking beam is an expert shortcut that opens on the shared beat.
      obstacles.push({
        kind: "beam",
        x: tempoX,
        s,
        y: 1.2,
        hx: tempoHalf - 0.18,
        hy: 1,
        hs: 0.28,
        role: "warn",
        glow: 1.75,
        motion: Motion.Blink,
        m0: lerp(0.48, 0.62, d),
        m1: row * 0.25,
        m2: lerp(0.48, 0.58, d),
      });
      pickups.push(...shardLine(s - 9, energyX, 6, 3.2, true));
      pickups.push(...shardLine(s + 3, tempoX, 3, 3.1, false));
      const decisionId = `lattice-${row}`;
      routes.push(
        {
          decisionId,
          routeId: "energy",
          label: "Refuel line",
          reward: "energy",
          s,
          x: energyX,
          half: energyHalf,
        },
        {
          decisionId,
          routeId: "flow",
          label: "Needle line",
          reward: "flow",
          s,
          x: flowX,
          half: flowHalf,
        },
        {
          decisionId,
          routeId: "tempo",
          label: "Tempo line",
          reward: "tempo",
          s,
          x: tempoX,
          half: tempoHalf,
        },
      );
      s += 96;
    }
    return {
      length: s - s0 - 58,
      exitX: 0,
      exitHalf: 15,
      obstacles,
      pickups,
      routes,
    };
  },
};

/**
 * The winding canyon: graze-able wall ribbons meander and breathe — wide
 * mouth, a mid-run squeeze, then a bloom back open. Sparse interior spires
 * keep the line honest through the pinch.
 */
const canyonRun: PatternDef = {
  id: "canyonRun",
  category: "normal",
  intensity: 3,
  skills: ["navigation", "commitment"],
  weight: 1.15,
  minDifficulty: 0.12,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const startX = clamp(ctx.entryX * 0.6, -8, 8);
    const wideHalf = lerp(15, 12.5, d);
    const pinch = lerp(12, 9, d) + rng.range(-0.5, 0.5);
    const canyonStart = funnelTo(ctx, obstacles, startX, wideHalf, rng.range(3.5, 5));
    const innerLen = rng.range(170, 240);
    const segLen = 8;
    const waves = rng.range(0.8, 1.3);
    // Center meander budgeted to ~60% of the authoring slope: the breathing
    // walls consume the rest.
    const ampMax = (SLOPE * 0.6 * innerLen) / (2 * Math.PI * waves);
    const amp = Math.min(lerp(9, 14, d), ampMax);
    const phase = rng.range(0, Math.PI * 2);
    let cx = startX;
    let sinceSpire = 0;
    for (let s = 0; s < innerLen; s += segLen) {
      const t = s / innerLen;
      cx = startX + Math.sin(phase + t * Math.PI * 2 * waves) * amp - Math.sin(phase) * amp * (1 - t * 0.2);
      const breath = Math.pow(Math.sin(t * Math.PI), 1.3);
      const half = lerp(wideHalf, pinch, breath);
      const hy = rng.range(3.5, 6);
      const accent = s % (segLen * 4) < segLen;
      const lw = cx - half;
      const rw = cx + half;
      const wallExtra = { role: accent ? ("accent" as const) : ("dim" as const), glow: accent ? 1.4 : 1 };
      if (lw > -XP) obstacles.push(box((-XP + lw) / 2, canyonStart + s, (lw + XP) / 2, hy, segLen / 2 + 0.4, wallExtra));
      if (rw < XP) obstacles.push(box((rw + XP) / 2, canyonStart + s, (XP - rw) / 2, hy, segLen / 2 + 0.4, wallExtra));
      sinceSpire += segLen;
      if (sinceSpire > 26 && t > 0.1 && t < 0.9 && rng.chance(0.55)) {
        sinceSpire = 0;
        const w = rng.range(0.8, 1.3);
        obstacles.push(
          box(cx + rng.sign() * rng.range(2.5, half - 2.8), canyonStart + s + segLen * 0.5, w, rng.range(3, 6), w, {
            kind: rng.chance(0.5) ? "crystal" : "pillar",
            yaw: rng.range(0, Math.PI),
            role: "primary",
          }),
        );
      }
      if (s % 22 < segLen) pickups.push({ type: "shard", s: canyonStart + s, x: cx, y: 1.3 });
      // Squeeze-peak wall hugs pay: a risk shard pressed against the ribbon.
      if (breath > 0.9 && s % 16 < segLen) {
        pickups.push({ type: "shard", s: canyonStart + s, x: cx + rng.sign() * (half - 1.6), y: 1.3, magnet: false });
      }
    }
    const length = canyonStart + innerLen - s0 + 14;
    return { length, exitX: cx, exitHalf: wideHalf - 1, obstacles, pickups };
  },
};

/**
 * Boost-as-a-key: a divider splits the corridor into a safe weave lane and a
 * glass lane sealed by panes. Smashing through (boost held) pays shards and
 * smash bonuses; divider gaps let a dry tank bail back to the safe side.
 */
const glassRush: PatternDef = {
  id: "glassRush",
  category: "normal",
  intensity: 3,
  skills: ["commitment", "navigation"],
  weight: 1.5,
  minDifficulty: 0.18,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const side = rng.sign(); // Glass lane side.
    const divX = side * 4.5;
    const wallInner = 13.5;
    const laneX = side * ((4.5 + 0.6 + wallInner) / 2); // Glass lane center.
    // The funnel feeds the SAFE side only — the glass lane is a deliberate
    // turn-in, never something the guaranteed line gets pushed into.
    const corridorStart = funnelTo(ctx, obstacles, -side * 6.5, 8.5, 4);
    const innerLen = rng.range(120, 170);

    // Outer wall sealing the glass lane's far side.
    for (let s = 0; s < innerLen; s += 12) {
      obstacles.push(
        box(side * (wallInner + 6), corridorStart + s, 6, rng.range(3.5, 5), 6.5, { role: "dim" }),
      );
    }
    // Divider with bail-out gaps for a dry tank.
    const divStart = corridorStart + 14;
    for (let s = 0; s < innerLen - 26; s += 13) {
      obstacles.push(
        box(divX, divStart + s, 0.6, 3.4, 4.5, {
          role: s === 0 ? "warn" : "dim",
          glow: s === 0 ? 1.7 : 1,
        }),
      );
    }
    // Glass panes seal the loot lane; the validator treats them as solid, so
    // the guaranteed line always lives on the open side.
    const panes = rng.int(3, 4 + Math.round(d));
    const paneGap = (innerLen - 40) / panes;
    for (let i = 0; i < panes; i++) {
      const ps = divStart + 16 + i * paneGap + rng.range(-3, 3);
      obstacles.push({
        kind: "glass",
        x: laneX, s: ps, y: 1.6,
        hx: (wallInner - 4.5 - 0.6) / 2 + 0.3,
        hy: 1.6, hs: 0.32,
        role: "accent", glow: 1.5,
      });
      pickups.push(...shardLine(ps + 4, laneX, 3, 3.4, false));
    }
    // The open side stays honest: a sparse weave across its width.
    const weaveLo = side > 0 ? -XP + 4 : divX + 3.4;
    const weaveHi = side > 0 ? divX - 3.4 : XP - 4;
    for (let s = 24; s < innerLen - 12; s += rng.range(22, 32)) {
      const w = rng.range(0.9, 1.4);
      obstacles.push(
        box(rng.range(weaveLo, weaveHi), corridorStart + s, w, rng.range(3, 5.5), w, {
          kind: rng.chance(0.5) ? "pillar" : "box",
          role: "primary",
        }),
      );
    }
    const length = corridorStart + innerLen - s0 + 16;
    return { length, exitX: -side * 5, exitHalf: 13, obstacles, pickups };
  },
};

/** A pinball alley: elastic pucks that fling instead of kill, laced with real hazards. */
const pinballAlley: PatternDef = {
  id: "pinballAlley",
  category: "normal",
  intensity: 2,
  skills: ["reaction", "navigation"],
  weight: 1,
  minDifficulty: 0.08,
  maxDifficulty: 0.92,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const length = rng.range(150, 230);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const rowStep = lerp(26, 18, d);
    for (let s = 18; s < length - 10; s += rowStep * rng.range(0.85, 1.3)) {
      const count = rng.int(1, 2);
      for (let i = 0; i < count; i++) {
        const x = rng.range(-XP + 6, XP - 6);
        const r = rng.range(1.1, 1.6);
        obstacles.push({
          kind: "bumper",
          x, s: s0 + s + rng.range(-2, 2), y: 1.1,
          hx: r, hy: 1.15, hs: r,
          role: "accent", glow: 1.8,
        });
        // Loot rides just past the puck: bank a deliberate bounce (or thread
        // beside it) to collect.
        if (rng.chance(0.5)) {
          pickups.push({ type: "shard", s: s0 + s + 7, x: x + rng.sign() * 2.4, y: 1.3, magnet: false });
        }
      }
      // Real hazards keep the alley lethal between the toys.
      if (rng.chance(lerp(0.35, 0.7, d))) {
        const w = rng.range(0.9, 1.6);
        obstacles.push(
          box(rng.range(-XP + 4, XP - 4), s0 + s + rowStep * 0.5, w, rng.range(2.5, 6), w, {
            kind: rng.chance(0.4) ? "crystal" : "box",
            yaw: rng.range(-0.5, 0.5),
            role: "primary",
          }),
        );
      }
    }
    return { length, exitX: 0, exitHalf: XP - 5, obstacles, pickups };
  },
};

/**
 * Pulse-beam gates: every row pairs a plain gap with a beamed gap full of
 * loot. The safe gap wanders gently (validator-proven); the beamed gap is a
 * rhythm read — dive through while the beam breathes out.
 */
const photonGate: PatternDef = {
  id: "photonGate",
  category: "normal",
  intensity: 3,
  skills: ["rhythm", "commitment"],
  weight: 1.2,
  minDifficulty: 0.22,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(4, 6);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const gapHalf = lerp(4.4, 3.4, d);
    const laneOff = 6.5;
    let gx = clamp(ctx.entryX * 0.5 + rng.range(-2, 2), -4, 4);
    let side = rng.sign();
    let openX = gx - side * laneOff;
    let s = s0 + leadInDist(ctx, openX, gapHalf);
    for (let r = 0; r < rows; r++) {
      const beamX = gx + side * laneOff;
      obstacles.push(
        ...multiGapRow(
          s,
          [{ x: openX, half: gapHalf }, { x: beamX, half: gapHalf }],
          rng.range(3.2, 4.6),
          1.1,
          { role: "primary" },
        ),
      );
      obstacles.push({
        kind: "beam",
        x: beamX, s, y: 1.2,
        hx: gapHalf - 0.1, hy: 1.0, hs: 0.3,
        role: "warn", glow: 1.6,
        motion: Motion.Blink,
        m0: rng.range(0.4, 0.62) * lerp(1, 1.3, d),
        m1: rng.range(0, 1),
        m2: lerp(0.52, 0.62, d),
      });
      pickups.push(...shardLine(s - 3, beamX, 3, 3, false));
      if (r === rows - 1) break;
      // The pair drifts gently; the beam occasionally swaps sides. Row gaps
      // are sized against the OPEN lane's true shift (a side swap moves it by
      // two lane offsets), so the guaranteed line always has room to cross.
      const ng = clamp(gx + rng.range(-3.5, 3.5), -4, 4);
      const nextSide = rng.chance(0.7) ? -side : side;
      const nextOpenX = ng - nextSide * laneOff;
      s += Math.max(
        lerp(38, 30, d) * rng.range(0.95, 1.25),
        rowRun(nextOpenX - openX, gapHalf, gapHalf) + 10,
      );
      gx = ng;
      side = nextSide;
      openX = nextOpenX;
    }
    return { length: s - s0 + 16, exitX: openX, exitHalf: gapHalf + 1, obstacles, pickups };
  },
};

/**
 * Fixed-seed compound course used by the practice ladder. It composes four
 * existing grammars into one validated phrase, so exits and resources carry
 * forward instead of resetting after each isolated drill.
 */
const weaverCircuit: PatternDef = {
  id: "weaverCircuit",
  category: "normal",
  intensity: 5,
  skills: ["precision", "rhythm", "reaction", "commitment", "navigation"],
  weight: 0,
  minDifficulty: 0.25,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const sequence = [slalomGates, photonGate, routeLattice, narrowGates];
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const routes: RouteChoiceSpec[] = [];
    let cursor = ctx.s0;
    let entryX = ctx.entryX;
    let entryHalf = ctx.entryHalf;
    for (const pattern of sequence) {
      const part = pattern.build({
        ...ctx,
        s0: cursor,
        entryX,
        entryHalf,
      });
      obstacles.push(...part.obstacles);
      pickups.push(...part.pickups);
      routes.push(...(part.routes ?? []));
      cursor += part.length + 20;
      entryX = part.exitX;
      entryHalf = part.exitHalf;
    }
    return {
      length: cursor - ctx.s0,
      exitX: entryX,
      exitHalf: entryHalf,
      obstacles,
      pickups,
      routes,
    };
  },
};

export const NORMAL_PATTERNS: PatternDef[] = [
  slalomGates,
  narrowGates,
  sCurveCanyon,
  zipper,
  combTeeth,
  oscillatingWalls,
  pistonCorridor,
  pendulumAlley,
  bladeRotors,
  collapsingBridge,
  meteorShower,
  crystalChicane,
  buoySlalom,
  ringTunnel,
  hyperRings,
  precisionLadder,
  pulseWeave,
  rotorRhythm,
  splitDecision,
  routeLattice,
  canyonRun,
  glassRush,
  pinballAlley,
  photonGate,
];

/** Long free-navigation scatter sections. */
export const FIELD_PATTERNS: PatternDef[] = [
  pillarForest,
  chaosField,
  asteroidDrift,
];

export const CIRCUIT_PATTERNS: PatternDef[] = [weaverCircuit];

export const BREATHER = openField;
