import { TRACK } from "../core/constants";
import { clamp, lerp } from "../core/mathUtils";
import {
  Motion,
  type ObstacleSpec,
  type PatternDef,
  type PatternResult,
  type PickupSpec,
} from "../core/types";
import { box, funnelTo, gateRow, leadInDist } from "./patterns";
import { pathSlopeAt } from "./validator";

const XP = TRACK.X_PATTERN;

/** A monolithic wall with a single carved keyhole — funnel guides you in. */
const monolithKeyhole: PatternDef = {
  id: "monolithKeyhole",
  category: "setpiece",
  intensity: 3,
  skills: ["precision", "commitment"],
  weight: 1,
  minDifficulty: 0.15,
  maxDifficulty: 1,
  maxEntryHalf: 18,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const gapX = clamp(ctx.entryX + rng.range(-6, 6), -9, 9);
    const gapHalf = lerp(4.8, 3.4, d);
    const funnelEnd = funnelTo(ctx, obstacles, gapX, gapHalf + 2.5, 3.2);
    const wallS = funnelEnd + 18;
    const H = 26;
    const le = gapX - gapHalf;
    const rs = gapX + gapHalf;
    obstacles.push(box((-XP - 14 + le) / 2, wallS, (le + XP + 14) / 2, H, 3.5, { role: "dim", glow: 0.8 }));
    obstacles.push(box((rs + XP + 14) / 2, wallS, (XP + 14 - rs) / 2, H, 3.5, { role: "dim", glow: 0.8 }));
    // Glowing keyhole frame.
    obstacles.push(box(gapX, wallS, gapHalf + 2.2, 1.2, 3.8, { y: 7.4, role: "warn", glow: 2.2, noValidate: true }));
    obstacles.push(box(gapX - gapHalf - 0.7, wallS, 0.7, 6.8, 3.8, { kind: "pillar", role: "warn", glow: 2.4 }));
    obstacles.push(box(gapX + gapHalf + 0.7, wallS, 0.7, 6.8, 3.8, { kind: "pillar", role: "warn", glow: 2.4 }));
    for (let i = 0; i < 5; i++) {
      pickups.push({ type: "shard", s: wallS - 14 - i * 7, x: gapX, y: 1.3 });
    }
    const length = wallS - s0 + 30;
    return { length, exitX: gapX, exitHalf: gapHalf + 1, obstacles, pickups, announce: "MONOLITH" };
  },
};

/** Colossal arch flythrough over scattered debris. */
const colossalArch: PatternDef = {
  id: "colossalArch",
  category: "setpiece",
  intensity: 2,
  skills: ["navigation"],
  weight: 1,
  minDifficulty: 0.1,
  maxDifficulty: 0.9,
  build(ctx): PatternResult {
    const { rng, s0 } = ctx;
    const length = 170;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const cx = rng.range(-5, 5);
    const aS = s0 + 104;
    obstacles.push(box(cx - 26, aS, 5, 34, 5, { kind: "pillar", role: "accent", glow: 1.2 }));
    obstacles.push(box(cx + 26, aS, 5, 34, 5, { kind: "pillar", role: "accent", glow: 1.2 }));
    obstacles.push(box(cx, aS, 28, 3, 3.4, { y: 32, role: "accent", glow: 1.8, noValidate: true, collidable: false }));
    for (let i = 0; i < 9; i++) {
      const s = s0 + 34 + rng.range(0, 116);
      const x = cx + rng.range(-18, 18);
      const w = rng.range(0.8, 1.6);
      obstacles.push(box(x, s, w, rng.range(1.4, 3.2), w, { kind: "crystal", yaw: rng.range(0, 3), role: "primary" }));
    }
    pickups.push({ type: "shard", s: aS - 8, x: cx, y: 1.3 });
    pickups.push({ type: "shard", s: aS, x: cx, y: 1.3 });
    pickups.push({ type: "shard", s: aS + 8, x: cx, y: 1.3 });
    return { length, exitX: cx, exitHalf: 18, obstacles, pickups, announce: "COLOSSUS GATE" };
  },
};

/** Orbiting spheres around a bright core; wide safe channel opposite. */
const gravityWell: PatternDef = {
  id: "gravityWell",
  category: "setpiece",
  intensity: 4,
  skills: ["rhythm", "reaction"],
  weight: 0.9,
  minDifficulty: 0.35,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const side = rng.sign();
    const cx = side * 19;
    const lead = leadInDist(ctx, -side * 12, 10);
    const cs = s0 + lead + 60;
    const length = lead + 120;
    obstacles.push({
      kind: "sphere", x: cx, s: cs, y: 3.4, hx: 2.8, hy: 2.8, hs: 2.8,
      role: "warn", glow: 2.6,
    });
    const n = rng.int(3, 4);
    for (let i = 0; i < n; i++) {
      const r = 6 + i * 2.6;
      obstacles.push({
        kind: "sphere", x: cx, s: cs, y: 1.5, hx: 1.2, hy: 1.2, hs: 1.2,
        role: "primary", glow: 1.6,
        motion: Motion.OrbitXZ,
        m0: r,
        m1: (i % 2 ? -1 : 1) * rng.range(0.7, 1.2) * lerp(1, 1.5, d),
        m2: rng.range(0, Math.PI * 2),
      });
    }
    for (let i = 0; i < 5; i++) {
      pickups.push({ type: "shard", s: cs - 32 + i * 16, x: -side * 14, y: 1.3 });
    }
    return { length, exitX: -side * 12, exitHalf: 12, obstacles, pickups, announce: "GRAVITY WELL" };
  },
};

/** Canyon walls that slide shut as you approach — squeeze the center pinch. */
const closingCanyon: PatternDef = {
  id: "closingCanyon",
  category: "setpiece",
  intensity: 4,
  skills: ["commitment"],
  weight: 0.9,
  minDifficulty: 0.3,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { s0, difficulty: d } = ctx;
    const segs = 9;
    const segLen = 16;
    const lead = leadInDist(ctx, 0, 24);
    const length = lead + segs * segLen + 24;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const pinchHalf = lerp(5, 3.6, d);
    for (let i = 0; i < segs; i++) {
      const s = s0 + lead + i * segLen;
      const t = i / (segs - 1);
      const shape = t < 0.7 ? t / 0.7 : 1 - (t - 0.7) * 0.9;
      const finalHalf = lerp(28, pinchHalf, Math.pow(shape, 1.25));
      const startHalf = Math.min(finalHalf + 10, 34);
      const hy = 5 + shape * 5;
      const wallHalf = 8;
      obstacles.push(
        box(-startHalf - wallHalf, s, wallHalf, hy, segLen / 2 + 0.6, {
          role: "warn", glow: 1.15,
          motion: Motion.CloseIn,
          m0: -finalHalf - wallHalf,
          m1: s - 170,
          m2: s - 40,
        }),
      );
      obstacles.push(
        box(startHalf + wallHalf, s, wallHalf, hy, segLen / 2 + 0.6, {
          role: "warn", glow: 1.15,
          motion: Motion.CloseIn,
          m0: finalHalf + wallHalf,
          m1: s - 170,
          m2: s - 40,
        }),
      );
      if (i % 2 === 1) pickups.push({ type: "shard", s, x: 0, y: 1.3 });
    }
    return { length, exitX: 0, exitHalf: 10, obstacles, pickups, announce: "THE CRUSH" };
  },
};

/** A colonnade of rings that ripple in sequence. */
const breathingRings: PatternDef = {
  id: "breathingRings",
  category: "setpiece",
  intensity: 4,
  skills: ["precision", "rhythm"],
  weight: 0.85,
  minDifficulty: 0.4,
  maxDifficulty: 1,
  biomes: [1, 3],
  maxEntryHalf: 18,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = 9;
    const gap = 14;
    const obstacles: ObstacleSpec[] = [];
    const cx = clamp(ctx.entryX + rng.range(-4, 4), -6, 6);
    const inner = lerp(4.4, 3.8, d);
    const funnelEnd = funnelTo(ctx, obstacles, cx, inner + 3, 2.6);
    for (let i = 0; i < count; i++) {
      obstacles.push({
        kind: "ring",
        x: cx,
        s: funnelEnd + 10 + i * gap,
        y: 1.2,
        hx: inner + 1.7,
        hy: 0.55,
        hs: 0.55,
        inner,
        role: i % 2 ? "accent" : "primary",
        glow: 1.8,
        motion: Motion.SweepX,
        m0: 1.7,
        m1: i * 0.7,
        m2: 0.85,
      });
    }
    const length = funnelEnd + 10 + count * gap + 20 - s0;
    return {
      length, exitX: cx, exitHalf: 5,
      obstacles,
      pickups: [
        { type: "shard", s: funnelEnd + 10 + 2 * gap, x: cx, y: 1.3 },
        { type: "shard", s: funnelEnd + 10 + 6 * gap, x: cx, y: 1.3 },
      ],
      announce: "RESONANCE",
    };
  },
};

/** Rows of pylons with spinning energy blades; the center column is clear. */
const turbineField: PatternDef = {
  id: "turbineField",
  category: "setpiece",
  intensity: 5,
  skills: ["rhythm", "precision"],
  weight: 0.8,
  minDifficulty: 0.5,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = 3;
    const rowGap = 46;
    const first = Math.max(90, leadInDist(ctx, 0, 8));
    const length = first + rows * rowGap + 26;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const lanes = [-20, 0, 20];
    for (let i = 0; i < rows; i++) {
      const s = s0 + first + i * rowGap;
      for (const lx of lanes) {
        obstacles.push(box(lx, s, 1.2, 12, 1.2, { kind: "pillar", role: "dim", glow: 0.9 }));
        if (lx !== 0) {
          obstacles.push({
            kind: "box", x: lx, s, y: 1.3,
            hx: 6.8, hy: 0.55, hs: 0.5,
            role: "warn", glow: 1.7,
            motion: Motion.RotateYaw,
            m0: (i % 2 ? -1 : 1) * rng.range(1.2, 1.8) * lerp(1, 1.3, d),
            m1: rng.range(0, Math.PI * 2),
            m2: 0,
          });
        } else {
          pickups.push({ type: "shard", s: s + rowGap * 0.5, x: 0, y: 1.3 });
        }
      }
    }
    return { length, exitX: 0, exitHalf: XP - 6, obstacles, pickups, announce: "TURBINE FIELD" };
  },
};

/** Late-run multi-stage precision peak with readable off-line rotors. */
const apexGauntlet: PatternDef = {
  id: "apexGauntlet",
  category: "setpiece",
  intensity: 5,
  skills: ["precision", "commitment", "rhythm"],
  weight: 0.75,
  minDifficulty: 0.72,
  maxDifficulty: 1,
  maxEntryHalf: 15,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const gapHalf = lerp(3.8, 3.05, d);
    const slope = pathSlopeAt(d) * 0.8;
    let gx = clamp(ctx.entryX + rng.range(-2, 2), -7, 7);
    let s = funnelTo(ctx, obstacles, gx, gapHalf + 2, 4.5, "warn") + 16;
    let side = gx === 0 ? rng.sign() : Math.sign(gx);
    for (let stage = 0; stage < 6; stage++) {
      obstacles.push(...gateRow(s, gx, gapHalf, 7, 1.7, {
        role: "warn",
        glow: 1.9,
      }));
      pickups.push({
        type: "shard",
        s,
        x: gx + side * (gapHalf - 0.3),
        y: 1.3,
        magnet: false,
      });
      if (stage === 5) break;

      const nx = clamp(-gx + rng.range(-2.5, 2.5), -9, 9);
      const run = Math.max(36, Math.abs(nx - gx) / slope + 12);
      const rotorX = -side * 18;
      obstacles.push(box(rotorX, s + run * 0.5, 1.1, 8, 1.1, {
        kind: "pillar",
        role: "dim",
      }));
      obstacles.push({
        kind: "box",
        x: rotorX,
        s: s + run * 0.5,
        y: 1.4,
        hx: 7.2,
        hy: 0.65,
        hs: 0.55,
        role: "warn",
        glow: 1.8,
        motion: Motion.RotateYaw,
        m0: side * lerp(1.5, 2.25, d),
        m1: stage * 0.85,
      });
      s += run;
      gx = nx;
      side = -side;
    }
    return {
      length: s - s0 + 28,
      exitX: gx,
      exitHalf: gapHalf + 1,
      obstacles,
      pickups,
      announce: "APEX GAUNTLET",
    };
  },
};

export const SETPIECES: PatternDef[] = [
  monolithKeyhole,
  colossalArch,
  gravityWell,
  closingCanyon,
  breathingRings,
  turbineField,
  apexGauntlet,
];
