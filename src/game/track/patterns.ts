import { TRACK } from "../core/constants";
import { clamp, lerp } from "../core/mathUtils";
import {
  Motion,
  type BuildCtx,
  type ObstacleSpec,
  type PatternDef,
  type PatternResult,
  type PickupSpec,
} from "../core/types";
import { PATH_SLOPE } from "./validator";

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

export function shardLine(s0: number, x: number, count: number, spacing = 3.2): PickupSpec[] {
  const out: PickupSpec[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ type: "shard", s: s0 + i * spacing, x, y: 1.3 });
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
  category: "normal",
  weight: 1.3,
  minDifficulty: 0,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const length = rng.range(90, 150);
    const obstacles: ObstacleSpec[] = [];
    const spacing = lerp(19, 11, d);
    for (let s = 16; s < length - 6; s += spacing * rng.range(0.8, 1.3)) {
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

const slalomGates: PatternDef = {
  id: "slalomGates",
  category: "normal",
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
      s += Math.max(lerp(30, 22, d), rowRun(nx - gx, gh, nh) + 6);
      gx = nx;
      gh = nh;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups };
  },
};

const narrowGates: PatternDef = {
  id: "narrowGates",
  category: "normal",
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
      s += Math.max(lerp(30, 24, d), rowRun(nx - gx, gh, gh) + 6);
      gx = nx;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups };
  },
};

/** Funnel mouth + swaying canyon corridor. */
const sCurveCanyon: PatternDef = {
  id: "sCurveCanyon",
  category: "normal",
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
      s += rowGap;
    }
    return { length: s - s0 + 12, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

const combTeeth: PatternDef = {
  id: "combTeeth",
  category: "normal",
  weight: 0.9,
  minDifficulty: 0.18,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const rows = rng.int(3, 4);
    const rowGap = lerp(40, 30, d);
    const length = rows * rowGap + 20;
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const pitch = lerp(14.5, 11, d);
    for (let r = 0; r < rows; r++) {
      const offset = rng.range(-pitch / 2, pitch / 2);
      // Teeth leave gaps ~2.2x the pitch shift needed between rows.
      const toothHalf = pitch / 2 - lerp(4.1, 3.2, d);
      for (let x = -XP + offset; x < XP; x += pitch) {
        const cx = x + pitch / 2;
        if (Math.abs(cx) > XP) continue;
        obstacles.push(
          box(cx, s0 + 18 + r * rowGap, toothHalf, rng.range(3, 6), 0.8, {
            role: "primary",
            kind: rng.chance(0.3) ? "pillar" : "box",
          }),
        );
      }
      if (rng.chance(0.5)) {
        pickups.push({ type: "shard", s: s0 + 18 + r * rowGap, x: rng.range(-16, 16), y: 1.3 });
      }
    }
    return { length, exitX: 0, exitHalf: XP - 5, obstacles, pickups };
  },
};

/** Sweeping walls alternating sides; static outer gaps always survive. */
const oscillatingWalls: PatternDef = {
  id: "oscillatingWalls",
  category: "normal",
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
  weight: 0.9,
  minDifficulty: 0.35,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(3, 5);
    const gap = lerp(44, 34, d);
    const obstacles: ObstacleSpec[] = [];
    const pickups: PickupSpec[] = [];
    const wallX = 20;
    const corridorStart = funnelTo(ctx, obstacles, 0, wallX, 5);
    const innerLen = count * gap + 14;
    // Corridor walls.
    for (let s = 0; s < innerLen; s += 12) {
      obstacles.push(box(-(wallX + 5.5), corridorStart + s, 5, 5, 6.2, { role: "dim" }));
      obstacles.push(box(wallX + 5.5, corridorStart + s, 5, 5, 6.2, { role: "dim" }));
    }
    let side = rng.sign();
    for (let i = 0; i < count; i++) {
      const stroke = lerp(12, 15, d); // Rest gap on the far side stays >= ~9m wide.
      const headHalf = 3.4;
      const baseX = side * (wallX + headHalf - 0.5);
      obstacles.push({
        kind: "box",
        x: baseX,
        s: corridorStart + 16 + i * gap,
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
      pickups.push({ type: "shard", s: corridorStart + 16 + i * gap, x: -side * (wallX - 7), y: 1.3 });
      side = -side;
    }
    const length = corridorStart + innerLen - s0 + 12;
    return { length, exitX: 0, exitHalf: wallX - 5, obstacles, pickups };
  },
};

/** Swinging pendulum bobs; center channel always survives. */
const pendulumAlley: PatternDef = {
  id: "pendulumAlley",
  category: "normal",
  weight: 0.8,
  minDifficulty: 0.3,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(3, 5);
    const gap = lerp(40, 30, d);
    const length = count * gap + 22;
    const obstacles: ObstacleSpec[] = [];
    let side = rng.sign();
    for (let i = 0; i < count; i++) {
      const pivotX = side * rng.range(11, 14);
      obstacles.push({
        kind: "sphere",
        x: pivotX,
        s: s0 + 20 + i * gap,
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
      side = -side;
    }
    return { length, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

/** Spinning blade rotors on alternating sides. */
const bladeRotors: PatternDef = {
  id: "bladeRotors",
  category: "normal",
  weight: 0.8,
  minDifficulty: 0.4,
  maxDifficulty: 1,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(2, 4);
    const gap = lerp(52, 40, d);
    const length = count * gap + 26;
    const obstacles: ObstacleSpec[] = [];
    let side = rng.sign();
    for (let i = 0; i < count; i++) {
      const cx = side * rng.range(8, 11);
      const s = s0 + 24 + i * gap;
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
      side = -side;
    }
    return { length, exitX: 0, exitHalf: 12, obstacles, pickups: [] };
  },
};

/** Slabs slam down into gate rows ahead of the craft. */
const collapsingBridge: PatternDef = {
  id: "collapsingBridge",
  category: "normal",
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
      s += Math.max(lerp(36, 27, d), rowRun(nx - gx, gh, gh) + 6);
      gx = nx;
    }
    return { length: s - s0 + 16, exitX: gx, exitHalf: gh + 1, obstacles, pickups: [] };
  },
};

/** Telegraphed crystal meteors crash into the field ahead. */
const meteorShower: PatternDef = {
  id: "meteorShower",
  category: "normal",
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
  weight: 1,
  minDifficulty: 0.12,
  maxDifficulty: 1,
  biomes: [0],
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const count = rng.int(4, 6);
    const gap = lerp(34, 26, d);
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

export const NORMAL_PATTERNS: PatternDef[] = [
  pillarForest,
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
];

export const BREATHER = openField;
