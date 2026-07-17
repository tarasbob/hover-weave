/**
 * Skyhook ramp patterns (fun-frontier 6.1). Authored wedges loft the craft
 * into ballistic flight; every jump is strictly optional — the deck blocks
 * its own lanes, so the validator always proves a pure ground line around
 * it, and the guaranteed-clear landing tube past the lip is enforced by a
 * structural test gate (`assertSkyhookEnvelope`) rather than the lane DP.
 *
 * Every pattern carries `routes` metadata: it names the jump/ground fork for
 * telemetry, and it makes the mutator pipeline skip positional jitter and
 * scatter — nothing may drift into a landing tube. Mirroring still applies
 * and is safe (a wedge has no yaw or motion).
 */

import {
  CRAFT,
  RAMP,
  rampLaunchVy,
  rampAirTime,
  rampMaxFlight,
  rampTubeHalf,
  TRACK,
} from "../core/constants";
import { clamp, lerp } from "../core/mathUtils";
import type {
  ObstacleSpec,
  PatternDef,
  PatternResult,
  PickupSpec,
  RouteChoiceSpec,
} from "../core/types";
import { box, leadInDist, multiGapRow } from "./patterns";

const XP = TRACK.X_PATTERN;

/** Shared deck slope: lip height / deck length (well under steering slope). */
const DECK_SLOPE = 0.145;
const deckLenFor = (lipHeight: number) => lipHeight / DECK_SLOPE;

/** A launch wedge: deck rises from s0 to the lip at s0 + deckLen. */
export function rampDeck(
  x: number,
  s0: number,
  deckLen: number,
  halfW: number,
  lipHeight: number,
): ObstacleSpec {
  return {
    kind: "ramp",
    x,
    s: s0 + deckLen / 2,
    y: 0,
    hx: halfW,
    hy: lipHeight,
    hs: deckLen / 2,
    role: "accent",
    glow: 1.8,
  };
}

/** Height of the un-dived arc `t` seconds after leaving a lip at `vy`. */
function arcY(lipHeight: number, vy: number, t: number): number {
  return CRAFT.HOVER_HEIGHT + lipHeight + vy * t - 12 * t * t;
}

/**
 * Time/height of the double-jump apex for a launch at `vy`: ride to the arc
 * apex, fire a full-quality jump (fun-frontier 6.2), rise J/g further.
 * Rewards placed here are reachable only by a well-timed tap.
 */
function jumpApex(lipHeight: number, vy: number): { t: number; y: number } {
  const g = RAMP.GRAVITY;
  const j = RAMP.JUMP_VY;
  return {
    t: vy / g + j / g,
    y: CRAFT.HOVER_HEIGHT + lipHeight + (vy * vy) / (2 * g) + (j * j) / (2 * g),
  };
}

/**
 * A double-jump crown: a non-magnetic shard at the jump apex. `magnet:
 * false` keeps the 3D seek from handing it to a grounded arc (and pays the
 * risk-shard 1.6× bonus) — only a clean apex tap collects it.
 */
function jumpCrown(lipS: number, x: number, lipHeight: number, vy: number, speed: number): PickupSpec {
  const apex = jumpApex(lipHeight, vy);
  return { type: "shard", s: lipS + speed * apex.t, x, y: apex.y, magnet: false };
}

/**
 * Shards strung along the flight arc for a given approach speed. Magnetic:
 * collection seeks in 3D, so a close-but-imperfect arc still pays — reading
 * the arc is the skill, not pixel-hunting it.
 */
function arcShards(
  lipS: number,
  x: number,
  lipHeight: number,
  deckLen: number,
  speed: number,
  fractions: number[],
): PickupSpec[] {
  const vy = rampLaunchVy(lipHeight, deckLen, speed);
  const airTime = rampAirTime(vy, lipHeight);
  return fractions.map((f) => ({
    type: "shard" as const,
    s: lipS + speed * airTime * f,
    x,
    y: arcY(lipHeight, vy, airTime * f),
    magnet: true,
  }));
}

/** Jump/ground fork metadata (telemetry + mutator protection). */
function skyRoutes(
  id: string,
  s: number,
  deckX: number,
  deckHalf: number,
  groundX: number,
  groundHalf: number,
  jumpReward: RouteChoiceSpec["reward"],
): RouteChoiceSpec[] {
  return [
    {
      decisionId: id,
      routeId: "jump",
      label: "SKYHOOK",
      reward: jumpReward,
      s,
      x: deckX,
      half: deckHalf,
    },
    {
      decisionId: id,
      routeId: "ground",
      label: "GROUND LINE",
      reward: "flow",
      s,
      x: groundX,
      half: groundHalf,
    },
  ];
}

// ---------------------------------------------------------------------------

/**
 * Kicker line: two low wedges chained down the corridor — verticality as
 * ambient track texture from the opening kilometre, not a rare set-piece.
 * A cruise hop off kicker one rolls onto (or lands just before) kicker two;
 * a double-jump crown floats between them at the apex-tap altitude.
 */
const kickerLine: PatternDef = {
  id: "kickerLine",
  category: "normal",
  intensity: 2,
  skills: ["navigation"],
  // The sky cadence already guarantees presence; the everyday weight stays
  // modest so classic ground disciplines keep their rotation share.
  weight: 0.55,
  minDifficulty: 0.12,
  maxDifficulty: 1,
  maxSpeed: 160,
  // No entry cap: the lead-in funnels from any corridor width, and the sky
  // cadence must be able to fire right after wide-open stretches.
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const lip1 = rng.range(1.2, 1.45);
    const lip2 = rng.range(1.35, 1.6);
    const len1 = deckLenFor(lip1);
    const len2 = deckLenFor(lip2);
    const halfW = 6;
    const x1 = clamp(ctx.entryX + rng.range(-3, 3), -8, 8);
    const x2 = clamp(x1 + rng.sign() * rng.range(4, 7), -9, 9);
    const lead = leadInDist(ctx, x1, halfW);
    const deck1S = s0 + lead;
    const lip1S = deck1S + len1;

    const vy1 = rampLaunchVy(lip1, len1, ctx.speed);
    const cruise1 = ctx.speed * rampAirTime(vy1, lip1);
    // Kicker two receives the cruise hop: the deck begins under the tail of
    // the arc, so a plain flight rolls on while a dive lands short of it.
    const deck2S = lip1S + cruise1 * rng.range(0.72, 0.9);
    const lip2S = deck2S + len2;
    const flight1 = rampMaxFlight(lip1, len1, ctx.speed);
    const flight2 = rampMaxFlight(lip2, len2, ctx.speed);
    const tube = Math.max(rampTubeHalf(halfW, flight1), rampTubeHalf(halfW, flight2));

    const obstacles: ObstacleSpec[] = [
      rampDeck(x1, deck1S, len1, halfW, lip1),
      rampDeck(x2, deck2S, len2, halfW, lip2),
    ];
    const pickups: PickupSpec[] = [
      ...arcShards(lip1S, x1, lip1, len1, ctx.speed, [0.3, 0.6]),
      ...arcShards(lip2S, x2, lip2, len2, ctx.speed, [0.3, 0.6, 0.85]),
      // The crown: apex-tap only (non-magnetic, risk-shard payout).
      jumpCrown(lip1S, x1, lip1, vy1, ctx.speed),
    ];

    // Sparse flanking rubble outside both tubes — the line stays gentle
    // (intensity 2) but never empty; counts scale with difficulty.
    const n = Math.round(lerp(4, 11, d));
    const sEnd = lip2S + flight2 * 0.8;
    for (let i = 0; i < n; i++) {
      const s = deck1S + rng.range(0, Math.max(20, sEnd - deck1S));
      const fx = rng.range(-XP + 2.5, XP - 2.5);
      const w = rng.range(0.8, 1.5);
      if (Math.abs(fx - x1) < tube + w * 1.5 + 0.4) continue;
      if (Math.abs(fx - x2) < tube + w * 1.5 + 0.4) continue;
      obstacles.push(
        box(fx, s, w, rng.range(1.5, 2.8), w * 0.9, {
          kind: rng.chance(0.55) ? "crystal" : "box",
          yaw: rng.range(0, 3),
          role: rng.chance(0.3) ? "dim" : "primary",
        }),
      );
    }

    const length = Math.max(lip1S + flight1 + 12, lip2S + flight2 + 28) - s0;
    return {
      length,
      exitX: x2,
      exitHalf: 14,
      obstacles,
      pickups,
      routes: skyRoutes("kickerLine", deck1S - 6, x1, halfW, x1 + (x1 > 0 ? -14 : 14), 9, "energy"),
    };
  },
};

/**
 * Teaching wedge: wide deck mid-corridor, a shard arc tracing the default
 * flight, open ground on both sides. First contact with the skill stack.
 */
const skyRamp: PatternDef = {
  id: "skyRamp",
  // Intensity 3 keeps the wedge out of the recovery rotation: its open
  // flight tube is a breather already — it must not also fill breather duty.
  category: "normal",
  intensity: 3,
  skills: ["navigation"],
  weight: 0.7,
  minDifficulty: 0.18,
  maxDifficulty: 1,
  maxSpeed: 160,
  maxEntryHalf: 24,
  build(ctx): PatternResult {
    const { rng, s0 } = ctx;
    const lipHeight = 2.4;
    const deckLen = deckLenFor(lipHeight);
    const halfW = 6.5;
    const deckX = clamp(ctx.entryX + rng.range(-4, 4), -9, 9);
    const lead = leadInDist(ctx, deckX, halfW);
    const deckS = s0 + lead;
    const lipS = deckS + deckLen;
    const flight = rampMaxFlight(lipHeight, deckLen, ctx.speed);
    const obstacles: ObstacleSpec[] = [rampDeck(deckX, deckS, deckLen, halfW, lipHeight)];
    const pickups = arcShards(lipS, deckX, lipHeight, deckLen, ctx.speed, [0.22, 0.42, 0.62, 0.82]);
    // The deck is deliberately the easy line — that's the invitation. The
    // ground routes beside the tube carry a normal-difficulty weave, so
    // skipping the jump never skips the test (and the tier walls hold).
    const tube = rampTubeHalf(halfW, flight);
    const spacing = lerp(30, 22, ctx.difficulty);
    for (const side of [-1, 1]) {
      const inner = deckX + side * (tube + 1.8);
      const outer = side > 0 ? XP - 2.5 : -XP + 2.5;
      if (side > 0 ? inner >= outer - 3 : inner <= outer + 3) continue;
      let stagger = rng.chance(0.5);
      for (let s = deckS - 4; s < lipS + flight * 0.85; s += spacing * rng.range(0.9, 1.15)) {
        const w = rng.range(0.9, 1.5);
        const cx = stagger
          ? inner + side * (w + 0.6)
          : outer - side * (w + rng.range(0.6, 3));
        stagger = !stagger;
        // Deep-overdrive tubes can reach the far edge — never let a rock
        // placed off the *outer* wall drift back inside the flight tube
        // (yawed footprint can span w·√2).
        if (Math.abs(cx - deckX) < tube + w * 1.5 + 0.4) continue;
        obstacles.push(
          box(cx, s, w, rng.range(1.8, 3.2), w * 0.9, {
            kind: rng.chance(0.6) ? "crystal" : "box",
            yaw: rng.range(0, 3),
          }),
        );
      }
    }
    const length = lead + deckLen + flight + 30;
    return {
      length,
      exitX: deckX,
      exitHalf: 14,
      obstacles,
      pickups,
      routes: skyRoutes("skyRamp", deckS - 6, deckX, halfW, deckX + (deckX > 0 ? -16 : 16), 9, "energy"),
      announce: "SKYHOOK RAMP",
    };
  },
};

/**
 * The air becomes track: rings hang on the cruise and boosted arcs while the
 * grounded line threads a narrow gate gap beside the landing tube. Rings are
 * `noValidate` — their live collision band (a thin tube at altitude) can
 * never reach a grounded craft, which the structural gate re-proves.
 */
const skyGateRun: PatternDef = {
  id: "skyGateRun",
  category: "setpiece",
  intensity: 4,
  skills: ["commitment", "navigation"],
  weight: 0.75,
  minDifficulty: 0.4,
  maxDifficulty: 1,
  maxSpeed: 160,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const lipHeight = 2.6;
    const deckLen = deckLenFor(lipHeight);
    const halfW = 5;
    const side = rng.sign();
    const deckX = side * rng.range(6, 9);
    const lead = leadInDist(ctx, deckX, halfW + 2);
    const deckS = s0 + lead;
    const lipS = deckS + deckLen;
    const flight = rampMaxFlight(lipHeight, deckLen, ctx.speed);
    const tube = rampTubeHalf(halfW, flight);
    const obstacles: ObstacleSpec[] = [rampDeck(deckX, deckS, deckLen, halfW, lipHeight)];
    const pickups: PickupSpec[] = [];

    // Flight furniture: one ring on the cruise arc, one on the boosted arc,
    // and a third high on the double-jump apex line (fun-frontier 6.2) —
    // threading it demands a clean apex tap mid-flight.
    const cruiseVy = rampLaunchVy(lipHeight, deckLen, ctx.speed);
    const apex = jumpApex(lipHeight, cruiseVy);
    for (const [v, s, y, glow] of [
      (() => {
        const t = rampAirTime(cruiseVy, lipHeight) * 0.48;
        return [ctx.speed, lipS + ctx.speed * t, arcY(lipHeight, cruiseVy, t), 1.6] as const;
      })(),
      (() => {
        const bv = ctx.speed * 1.45;
        const bvy = rampLaunchVy(lipHeight, deckLen, bv);
        const t = rampAirTime(bvy, lipHeight) * 0.55;
        return [bv, lipS + bv * t, arcY(lipHeight, bvy, t), 2.2] as const;
      })(),
      [ctx.speed, lipS + ctx.speed * apex.t, apex.y, 2.6] as const,
    ]) {
      void v;
      if (y < 4.2) continue; // Too low to guarantee ground clearance — skip.
      obstacles.push({
        kind: "ring",
        x: deckX,
        s,
        y,
        hx: 4.6,
        hy: 0.55,
        hs: 0.55,
        inner: 3.2,
        role: "warn",
        glow,
        noValidate: true,
      });
    }
    pickups.push(...arcShards(lipS, deckX, lipHeight, deckLen, ctx.speed, [0.3, 0.7]));
    pickups.push(jumpCrown(lipS, deckX, lipHeight, cruiseVy, ctx.speed));

    // Ground line: gate rows with a narrow graze gap opposite the tube. The
    // tube-wide gap keeps every descent lane clear; the narrow gap pays.
    // Placed far enough out that the two gaps never merge into one span.
    const rows = 2 + Math.round(d);
    const gapHalf = lerp(3.4, 2.7, d);
    const groundX = -side * Math.max(rng.range(17, 21), tube + gapHalf + 2 - Math.abs(deckX));
    for (let i = 0; i < rows; i++) {
      const s = lipS + flight * (0.22 + 0.24 * i);
      obstacles.push(
        ...multiGapRow(
          s,
          [
            { x: deckX, half: tube + 1 },
            { x: groundX, half: gapHalf },
          ],
          lerp(1.8, 2.4, d),
          1,
          { role: "primary" },
        ),
      );
      pickups.push({ type: "shard", s, x: groundX, y: 1.3 });
    }

    const length = lead + deckLen + flight + 34;
    return {
      length,
      exitX: 0,
      exitHalf: 15,
      obstacles,
      pickups,
      routes: skyRoutes("skyGateRun", deckS - 6, deckX, halfW, groundX, gapHalf + 3, "tempo"),
      announce: "SKY GATES",
    };
  },
};

/**
 * Vault the debris: a dense crystal field owns the corridor while the deck
 * hugs one flank — the flight tube runs along the edge. Ground pays graze
 * income through the chaos; the vault trades it for airtime, arc shards,
 * and a landing-rush exit.
 */
const canyonVault: PatternDef = {
  id: "canyonVault",
  category: "setpiece",
  intensity: 4,
  skills: ["navigation", "commitment"],
  weight: 0.7,
  minDifficulty: 0.5,
  maxDifficulty: 1,
  maxSpeed: 160,
  maxEntryHalf: 22,
  build(ctx): PatternResult {
    const { rng, s0, difficulty: d } = ctx;
    const lipHeight = 2.9;
    const deckLen = deckLenFor(lipHeight);
    const halfW = 4.5;
    const side = rng.sign();
    const deckX = side * (XP - halfW - 4);
    const lead = leadInDist(ctx, deckX, halfW + 2);
    const deckS = s0 + lead;
    const lipS = deckS + deckLen;
    const flight = rampMaxFlight(lipHeight, deckLen, ctx.speed);
    const tube = rampTubeHalf(halfW, flight);
    const obstacles: ObstacleSpec[] = [rampDeck(deckX, deckS, deckLen, halfW, lipHeight)];
    const pickups = arcShards(lipS, deckX, lipHeight, deckLen, ctx.speed * 1.2, [0.25, 0.5, 0.75]);

    // The field: everything outside the tube, validator-proven navigable.
    // Edge margin covers the widest yawed footprint (w√2) plus slack.
    const fieldEdge = deckX - side * (tube + 3);
    const n = Math.round(lerp(24, 36, d));
    for (let i = 0; i < n; i++) {
      const s = lipS + rng.range(8, flight * 0.9);
      const fx = side > 0
        ? rng.range(-XP + 2, fieldEdge)
        : rng.range(fieldEdge, XP - 2);
      const w = rng.range(0.8, 1.7);
      const kind = rng.chance(0.5) ? "crystal" : rng.chance(0.5) ? "pillar" : "box";
      obstacles.push(
        box(fx, s, w, rng.range(1.5, 3.6), w, {
          kind,
          yaw: kind === "crystal" ? rng.range(0, 3) : 0,
          role: rng.chance(0.25) ? "dim" : "primary",
        }),
      );
      if (rng.chance(0.2)) pickups.push({ type: "shard", s, x: fx + rng.range(-3, 3), y: 1.3 });
    }

    // Apex-tap crown over the deepest part of the field (fun-frontier 6.2).
    pickups.push(
      jumpCrown(lipS, deckX, lipHeight, rampLaunchVy(lipHeight, deckLen, ctx.speed), ctx.speed),
    );

    const length = lead + deckLen + flight + 30;
    return {
      length,
      exitX: 0,
      exitHalf: 16,
      obstacles,
      pickups,
      routes: skyRoutes("canyonVault", deckS - 6, deckX, halfW, -side * 10, 12, "tempo"),
      announce: "THE VAULT",
    };
  },
};

/**
 * Two lips in sequence. The second deck begins around the floaty landing
 * zone of the first: carry speed through a perfect flare and the chain
 * launches deep; land hard and the numb, scrubbed approach barely lifts.
 */
const doubleSky: PatternDef = {
  id: "doubleSky",
  category: "setpiece",
  intensity: 5,
  skills: ["commitment", "rhythm"],
  weight: 0.6,
  minDifficulty: 0.62,
  maxDifficulty: 1,
  maxSpeed: 160,
  maxEntryHalf: 20,
  build(ctx): PatternResult {
    const { rng, s0 } = ctx;
    const lip1 = 2.2;
    const len1 = deckLenFor(lip1);
    const lip2 = 3;
    const len2 = deckLenFor(lip2);
    const halfW = 5.5;
    const deckX = clamp(ctx.entryX + rng.range(-3, 3), -7, 7);
    const lead = leadInDist(ctx, deckX, halfW);
    const deck1S = s0 + lead;
    const lip1S = deck1S + len1;

    // Deck 2 starts where an un-boosted cruise arc comes down, so a floaty
    // first hop rolls straight onto it; hot lines land on its deck mid-slope.
    const vy1 = rampLaunchVy(lip1, len1, ctx.speed);
    const cruiseFlight = ctx.speed * rampAirTime(vy1, lip1);
    const deck2S = lip1S + cruiseFlight + 14;
    const lip2S = deck2S + len2;
    const flight2 = rampMaxFlight(lip2, len2, ctx.speed);
    const tube = rampTubeHalf(halfW, flight2);

    const obstacles: ObstacleSpec[] = [
      rampDeck(deckX, deck1S, len1, halfW, lip1),
      rampDeck(deckX, deck2S, len2, halfW, lip2),
    ];
    const pickups: PickupSpec[] = [
      ...arcShards(lip1S, deckX, lip1, len1, ctx.speed, [0.35, 0.7]),
      ...arcShards(lip2S, deckX, lip2, len2, ctx.speed * 1.3, [0.3, 0.55, 0.8]),
    ];

    // Grounded rubble strictly outside the tube keeps the ground line a
    // real slalom while both descents stay untouched.
    const n = rng.int(14, 20);
    for (let i = 0; i < n; i++) {
      const s = lip1S + rng.range(6, cruiseFlight + len2 + flight2 * 0.7);
      const sideways = rng.sign();
      const fx = deckX + sideways * (tube + rng.range(3, 11));
      if (Math.abs(fx) > XP - 2) continue;
      const w = rng.range(0.8, 1.5);
      obstacles.push(
        box(fx, s, w, rng.range(1.4, 3), w, {
          kind: rng.chance(0.5) ? "crystal" : "box",
          yaw: rng.range(0, 3),
        }),
      );
    }

    const length = lead + len1 + cruiseFlight + 14 + len2 + flight2 + 30;
    return {
      length,
      exitX: deckX,
      exitHalf: 14,
      obstacles,
      pickups,
      routes: skyRoutes("doubleSky", deck1S - 6, deckX, halfW, deckX + (deckX > 0 ? -15 : 15), 10, "tempo"),
      announce: "DOUBLE SKYHOOK",
    };
  },
};

export const SKY_NORMAL: PatternDef[] = [kickerLine, skyRamp];
export const SKY_SETPIECES: PatternDef[] = [skyGateRun, canyonVault, doubleSky];
export const SKY_PATTERNS: PatternDef[] = [...SKY_NORMAL, ...SKY_SETPIECES];
