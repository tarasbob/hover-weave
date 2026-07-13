/**
 * Heat modifiers (roadmap 4.3): opt-in burdens on the endless track, each
 * paying a multiplicative score bonus. Pure registry + resolver — the sim
 * and the generator read a resolved `HeatEffects`, never the ids.
 *
 * Design rules:
 * - Endless only. Daily / sprint / trials stay pure shared-seed comparisons.
 * - Heat is part of run identity: recordings carry the stack, so replays and
 *   ghosts re-simulate heated runs exactly.
 * - With no heat selected every effect resolves to the identity (× 1, no
 *   flag) — the sim and generator execute bit-identical streams to a
 *   pre-heat build, which is what keeps old ghosts and baselines valid.
 */

export type HeatId =
  | "scarceShields"
  | "noMagnet"
  | "denseField"
  | "fastMovers"
  | "narrowGaps"
  | "tinHull";

export interface HeatDef {
  id: HeatId;
  name: string;
  desc: string;
  /** Score multiplier paid for carrying this burden (stack multiplies). */
  mult: number;
}

export const HEATS: HeatDef[] = [
  {
    id: "scarceShields",
    name: "Scarce Shields",
    desc: "Shields spawn rarely and late.",
    mult: 1.15,
  },
  {
    id: "noMagnet",
    name: "No Magnet",
    desc: "Shards must be hit dead-on — no pull.",
    mult: 1.1,
  },
  {
    id: "denseField",
    name: "Dense Field",
    desc: "More debris, tighter seams, fields arrive sooner.",
    mult: 1.25,
  },
  {
    id: "fastMovers",
    name: "Fast Movers",
    desc: "Everything that moves, moves faster.",
    mult: 1.2,
  },
  {
    id: "narrowGaps",
    name: "Narrow Gaps",
    desc: "The guaranteed corridor tightens toward razor width.",
    mult: 1.3,
  },
  {
    id: "tinHull",
    name: "Tin Hull",
    desc: "Shields do not exist. Every contact is fatal.",
    mult: 1.35,
  },
];

export const HEAT_BY_ID: Record<HeatId, HeatDef> = Object.fromEntries(
  HEATS.map((h) => [h.id, h]),
) as Record<HeatId, HeatDef>;

/** Canonical form: sorted, deduplicated, known ids only. */
export function normalizeHeat(heat: readonly string[] | undefined): HeatId[] {
  if (!heat || heat.length === 0) return [];
  const set = new Set<HeatId>();
  for (const id of heat) {
    if (id in HEAT_BY_ID) set.add(id as HeatId);
  }
  return [...set].sort();
}

/** Total score multiplier for a stack (1 when empty). */
export function heatScoreMult(heat: readonly HeatId[] | undefined): number {
  let mult = 1;
  for (const id of heat ?? []) mult *= HEAT_BY_ID[id].mult;
  return mult;
}

/**
 * Resolved knobs the sim/generator consume. Identity values when unheated —
 * multiplying by 1 and adding 0 are exact in IEEE754, so an empty stack
 * changes nothing, bit for bit.
 */
export interface HeatEffects {
  /** Total score multiplier (product of the stack). */
  scoreMult: number;
  /** Shield spawn chance scale + cooldown scale (scarceShields). */
  shieldChanceScale: number;
  shieldCooldownScale: number;
  /** False = shards never seek; collection radius only (noMagnet). */
  magnet: boolean;
  /** Mutator scatter chance/count scaling + seam shrink (denseField). */
  scatterChanceScale: number;
  scatterCountBonus: number;
  seamScale: number;
  /** Field-pattern cadence scale (denseField; < 1 = sooner). */
  fieldCadenceScale: number;
  /** Mutator mover-boost chance/magnitude scaling (fastMovers). */
  moverChanceScale: number;
  moverMagScale: number;
  /** Subtracted from the validator margin slack (narrowGaps). */
  slackBias: number;
  /** False = shields neither spawn nor absorb (tinHull). */
  shields: boolean;
}

export const NO_HEAT: HeatEffects = Object.freeze({
  scoreMult: 1,
  shieldChanceScale: 1,
  shieldCooldownScale: 1,
  magnet: true,
  scatterChanceScale: 1,
  scatterCountBonus: 0,
  seamScale: 1,
  fieldCadenceScale: 1,
  moverChanceScale: 1,
  moverMagScale: 1,
  slackBias: 0,
  shields: true,
});

export function resolveHeat(heat: readonly HeatId[] | undefined): HeatEffects {
  if (!heat || heat.length === 0) return NO_HEAT;
  const has = (id: HeatId) => heat.includes(id);
  return {
    scoreMult: heatScoreMult(heat),
    shieldChanceScale: has("scarceShields") ? 0.35 : 1,
    shieldCooldownScale: has("scarceShields") ? 2 : 1,
    magnet: !has("noMagnet"),
    scatterChanceScale: has("denseField") ? 1.8 : 1,
    scatterCountBonus: has("denseField") ? 2 : 0,
    seamScale: has("denseField") ? 0.75 : 1,
    fieldCadenceScale: has("denseField") ? 0.72 : 1,
    moverChanceScale: has("fastMovers") ? 1.6 : 1,
    moverMagScale: has("fastMovers") ? 1.25 : 1,
    slackBias: has("narrowGaps") ? 0.12 : 0,
    shields: !has("tinHull"),
  };
}
