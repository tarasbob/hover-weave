/**
 * Lab prototypes (roadmap Phase 5): flag-gated experiments, default off.
 * Pure registry + resolver, modeled on heat — the sim reads a resolved
 * `LabEffects`, never the ids.
 *
 * Design rules:
 * - Endless only, and every effect is the exact identity when its flag is
 *   off: an empty stack executes bit-identical to a build without the lab.
 * - Lab is part of run identity: recordings carry the stack so replays
 *   re-simulate exactly — but lab runs are *unranked sandboxes*. They write
 *   no PBs, no rating, no streaks, and never persist as ghosts (unlike heat,
 *   which makes runs harder and pays on the real ladder, lab flags change
 *   the physics economy — their scores are play money).
 */

export type LabId = "surge" | "dash" | "resonance";

export interface LabDef {
  id: LabId;
  name: string;
  desc: string;
}

export const LABS: LabDef[] = [
  {
    id: "surge",
    name: "Surge Windows",
    desc: "A perfect pass or thread opens 0.6 s of free boost — no drain, ignites even on an empty meter.",
  },
  {
    id: "dash",
    name: "Phase Dash",
    desc: "A third verb: tap S / ↓ (gamepad X, third finger) while steering to blink sideways. Costs energy, 2 s cooldown, no mercy frames.",
  },
  {
    id: "resonance",
    name: "Rhythm Resonance",
    desc: "Every mover phase-locks to the soundtrack's beat grid; perfect passes landed on the beat ring out and pay ×1.25.",
  },
];

export const LAB_BY_ID: Record<LabId, LabDef> = Object.fromEntries(
  LABS.map((l) => [l.id, l]),
) as Record<LabId, LabDef>;

/** Canonical form: sorted, deduplicated, known ids only. */
export function normalizeLab(lab: readonly string[] | undefined): LabId[] {
  if (!lab || lab.length === 0) return [];
  const set = new Set<LabId>();
  for (const id of lab) {
    if (id in LAB_BY_ID) set.add(id as LabId);
  }
  return [...set].sort();
}

/**
 * Resolved flags the sim consumes. All false when the stack is empty — the
 * flag-off code paths are pure conditionals, so plain runs stay bit-exact.
 */
export interface LabEffects {
  /** Perfect passes / threads open a free-boost window (roadmap 5.1). */
  surge: boolean;
  /** Third verb: short lateral displacement on a cooldown (roadmap 5.3). */
  dash: boolean;
  /** Movers lock to the beat grid; on-beat perfects pay extra (roadmap 5.4). */
  resonance: boolean;
}

export const NO_LAB: LabEffects = Object.freeze({
  surge: false,
  dash: false,
  resonance: false,
});

export function resolveLab(lab: readonly LabId[] | undefined): LabEffects {
  if (!lab || lab.length === 0) return NO_LAB;
  return {
    surge: lab.includes("surge"),
    dash: lab.includes("dash"),
    resonance: lab.includes("resonance"),
  };
}
