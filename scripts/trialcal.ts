/**
 * One-off trial medal calibration (roadmap 4.1): run the greedy and lookahead
 * autopilot tiers on every trial's fixed seed and print their walls, plus the
 * breather-fallback share of generated chunks. Medal thresholds in
 * src/game/track/trials.ts are baked from this output.
 *
 * Run: npx tsx scripts/trialcal.ts
 */
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import type { RunConfig } from "../src/game/core/modes";
import { SimWorld } from "../src/game/core/world";
import { TRIALS, trialSeed } from "../src/game/track/trials";
import { autopilot, lookaheadPilot } from "./pilots";

const CAPS = { greedy: 300, lookahead: 480 } as const;

for (const trial of TRIALS) {
  const line: string[] = [trial.id.padEnd(18)];
  for (const tier of ["greedy", "lookahead"] as const) {
    const world = new SimWorld();
    const config: RunConfig = { mode: "trial", seed: trialSeed(trial.id), trialId: trial.id };
    world.start(config);
    const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
    const mem = { targetX: 0 };
    const maxSteps = Math.floor(CAPS[tier] / FIXED_DT);
    const seenChunks = new Map<number, string>();
    let steps = 0;
    while (world.status === "running" && steps < maxSteps) {
      if (tier === "greedy") autopilot(world, input);
      else lookaheadPilot(world, input, mem);
      world.update(FIXED_DT, input);
      if (steps % 30 === 0) {
        for (const c of world.chunkLog) seenChunks.set(c.s0, c.patternId);
      }
      steps++;
    }
    const total = seenChunks.size;
    const fallbacks = [...seenChunks.values()].filter((id) => id !== trial.id).length;
    const capped = world.status === "running" ? " CAPPED" : "";
    line.push(
      `${tier}=${world.distance.toFixed(0).padStart(6)}m${capped}` +
      ` (fb ${((fallbacks / Math.max(1, total)) * 100).toFixed(0)}%)`,
    );
  }
  console.log(line.join("  "));
}
