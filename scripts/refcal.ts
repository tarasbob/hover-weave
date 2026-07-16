/**
 * Reference-distance calibration (fun-frontier 4.1): fly the TAS rollout pilot
 * and the lookahead planner on every trial's fixed seed and print the
 * composite automated distance:
 *
 *   reference = max(TAS wall, lookahead wall, 1.2 × author medal)
 *
 * The authored floor prevents a short-horizon model failure on mover-heavy
 * trials from lowering an existing aspirational target. `reference` in
 * src/game/track/trials.ts is baked from this output. Deterministic: it only
 * moves when tuning moves.
 *
 * Run: npx tsx scripts/refcal.ts
 */
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { SimWorld } from "../src/game/core/world";
import { TRIALS, trialSeed } from "../src/game/track/trials";
import { lookaheadPilot, superhumanPilot } from "./pilots";

// Trials escalate speed linearly without bound, so every pilot tier hits a
// wall well inside these caps (reaction bandwidth vs. raw closing speed).
const CAPS = { lookahead: 480, superhuman: 900 } as const;

for (const trial of TRIALS) {
  const walls: Record<string, number> = {};
  for (const tier of ["lookahead", "superhuman"] as const) {
    const world = new SimWorld();
    world.start({ mode: "trial", seed: trialSeed(trial.id), trialId: trial.id });
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    const mem = { targetX: 0 };
    const maxSteps = Math.floor(CAPS[tier] / FIXED_DT);
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      if (tier === "lookahead") lookaheadPilot(world, input, mem);
      else superhumanPilot(world, input);
      world.update(FIXED_DT, input);
      steps++;
    }
    walls[tier] = world.distance;
  }
  const composite = Math.round(
    Math.max(walls.superhuman, walls.lookahead, trial.medals.author * 1.2),
  );
  console.log(
    `${trial.id.padEnd(18)} reference=${String(composite).padStart(6)}m ` +
    `(TAS ${walls.superhuman.toFixed(0)}m, lookahead ${walls.lookahead.toFixed(0)}m, ` +
    `author ${trial.medals.author}m, baked ${trial.reference}m)`,
  );
}
