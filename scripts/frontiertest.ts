/**
 * Deterministic synthetic skill-frontier gate.
 *
 * These cohorts are ordered design stress models, not human baselines. They
 * differ only in explicit observation/control constraints and never receive
 * validator paths, generator state, or future RNG.
 *
 * Run:
 *   npm run test:frontier
 *   npm run test:frontier -- --json
 *   npm run test:frontier -- --json reports/frontier.json
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { InputState } from "../src/game/core/input";
import { quantizeAxis } from "../src/game/core/replay";
import type { SimWorld } from "../src/game/core/world";
import {
  MODELED_INTERMEDIATE_PROFILE,
  MODELED_NOVICE_PROFILE,
  MODELED_REACTIVE_PROFILE,
  createSyntheticPilot,
  runPilotCohort,
  runSyntheticCohort,
  type PilotCohortController,
  type PilotCohortReport,
  type SyntheticPilotProfile,
} from "./pilots";

const SEEDS = ["frontier-0", "frontier-1", "frontier-2", "frontier-3", "frontier-4"] as const;
const MAX_SECONDS = 140;
const MAX_TRIMMED_SPREAD = 3.5;
const MIN_SEPARATION = 1.03;
// v9's first turn already demands correction before the 650m apex. Frozen
// novice policies reach 318–405m; they must clear the 300m steering lesson,
// while wider preview and finer control must buy survival through the turn.
const FIRST_FLIGHT_DISTANCE = 300;

const PROFILES = [
  MODELED_NOVICE_PROFILE,
  MODELED_REACTIVE_PROFILE,
  MODELED_INTERMEDIATE_PROFILE,
] as const;

interface PeriodicMacro {
  id: string;
  axisAt(time: number): number;
}

const PERIODIC_MACROS: readonly PeriodicMacro[] = [
  {
    id: "periodic-neutral",
    axisAt: () => 0,
  },
  {
    id: "periodic-fast-square",
    axisAt: (time) => (Math.floor(time / 0.42) % 2 === 0 ? -1 : 1),
  },
  {
    id: "periodic-slow-square",
    axisAt: (time) => (Math.floor(time / 1.15) % 2 === 0 ? -0.7 : 0.7),
  },
  {
    id: "periodic-sine",
    axisAt: (time) => Math.sin((time * Math.PI * 2) / 1.8),
  },
];

class PeriodicController implements PilotCohortController {
  private readonly macro: PeriodicMacro;

  constructor(macro: PeriodicMacro) {
    this.macro = macro;
  }

  step(world: SimWorld, input: InputState): void {
    input.axis = quantizeAxis(this.macro.axisAt(world.time));
    input.boost = false;
    input.dash = false;
  }
}

function assertHealthyCohort(report: PilotCohortReport): void {
  for (const run of report.runs) {
    assert.equal(run.obstacleDrops, 0, `${report.cohortId}/${run.seed} exhausted obstacle capacity`);
    assert.equal(run.pickupDrops, 0, `${report.cohortId}/${run.seed} exhausted pickup capacity`);
  }
}

function runProfile(profile: SyntheticPilotProfile): PilotCohortReport {
  const report = runSyntheticCohort(profile, SEEDS, MAX_SECONDS);
  assertHealthyCohort(report);
  return report;
}

function runMacro(macro: PeriodicMacro): PilotCohortReport {
  const report = runPilotCohort({
    cohortId: macro.id,
    seeds: SEEDS,
    maxSeconds: MAX_SECONDS,
    createController: () => new PeriodicController(macro),
  });
  assertHealthyCohort(report);
  return report;
}

function parseJsonDestination(args: readonly string[]): "stdout" | string | null {
  let destination: "stdout" | string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      if (destination !== null) throw new Error("--json may only be supplied once");
      const candidate = args[i + 1];
      if (candidate && !candidate.startsWith("-")) {
        destination = candidate;
        i++;
      } else {
        destination = "stdout";
      }
    } else if (arg.startsWith("--json=")) {
      if (destination !== null) throw new Error("--json may only be supplied once");
      destination = arg.slice("--json=".length);
      if (!destination) throw new Error("--json= requires a path");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return destination;
}

const startedAt = performance.now();
const jsonDestination = parseJsonDestination(process.argv.slice(2));
const adaptive = PROFILES.map(runProfile);
const macros = PERIODIC_MACROS.map(runMacro);
const carveProfiles = [MODELED_NOVICE_PROFILE, MODELED_INTERMEDIATE_PROFILE] as const;
const carveCohorts = carveProfiles.map((profile) => {
  const report = runPilotCohort({
    cohortId: `${profile.id}-carve`,
    seeds: SEEDS,
    maxSeconds: MAX_SECONDS,
    createController: (seed) =>
      // Keep the same noise stream as the plain cohort: only physics differs.
      createSyntheticPilot(profile, `${profile.id}|${seed}|noise`),
    configForSeed: (seed) => ({ mode: "endless", seed, lab: ["carve"] }),
  });
  assertHealthyCohort(report);
  return report;
});

const separations = adaptive.slice(1).map((stronger, index) => {
  const weaker = adaptive[index];
  const meanRatio = stronger.aggregate.meanDistance / weaker.aggregate.meanDistance;
  const medianRatio = stronger.aggregate.medianDistance / weaker.aggregate.medianDistance;
  assert.ok(
    meanRatio >= MIN_SEPARATION,
    `${stronger.cohortId} mean must exceed ${weaker.cohortId} by at least ` +
      `${MIN_SEPARATION.toFixed(2)}x (${meanRatio.toFixed(3)}x)`,
  );
  assert.ok(
    medianRatio >= MIN_SEPARATION,
    `${stronger.cohortId} median must exceed ${weaker.cohortId} by at least ` +
      `${MIN_SEPARATION.toFixed(2)}x (${medianRatio.toFixed(3)}x)`,
  );
  return {
    weaker: weaker.cohortId,
    stronger: stronger.cohortId,
    meanRatio,
    medianRatio,
  };
});

for (const run of adaptive[0].runs) {
  assert.ok(
    run.distance >= FIRST_FLIGHT_DISTANCE,
    `modeled novice must clear the ${FIRST_FLIGHT_DISTANCE}m first-flight curriculum ` +
      `(${run.seed}: ${run.distance.toFixed(0)}m)`,
  );
}
assert.ok(adaptive[0].aggregate.medianDistance >= 375,
  "the median modeled novice must progress into the first noticeable turn");

for (const report of adaptive) {
  assert.ok(
    report.aggregate.trimmedSpreadRatio <= MAX_TRIMMED_SPREAD,
    `${report.cohortId} seed spread is unbounded ` +
      `(${report.aggregate.trimmedSpreadRatio.toFixed(2)}x > ${MAX_TRIMMED_SPREAD.toFixed(2)}x)`,
  );
}

const reactive = adaptive.find((report) => report.cohortId === MODELED_REACTIVE_PROFILE.id)!;
const bestMacroMean = Math.max(...macros.map((report) => report.aggregate.meanDistance));
const bestMacroMedian = Math.max(...macros.map((report) => report.aggregate.medianDistance));
assert.ok(adaptive[0].aggregate.medianDistance > bestMacroMedian * 1.1,
  "even novice adaptive steering must beat a fixed periodic macro by at least 10%");
assert.ok(
  bestMacroMean < reactive.aggregate.meanDistance,
  `fixed periodic macro mean (${bestMacroMean.toFixed(0)}m) must not dominate adaptive play ` +
    `(${reactive.aggregate.meanDistance.toFixed(0)}m)`,
);
assert.ok(
  bestMacroMedian < reactive.aggregate.medianDistance,
  `fixed periodic macro median (${bestMacroMedian.toFixed(0)}m) must not dominate adaptive play ` +
    `(${reactive.aggregate.medianDistance.toFixed(0)}m)`,
);

// Re-run one noisy policy to prove the report inputs are reproducible exactly.
const determinismProbe = runSyntheticCohort(
  MODELED_INTERMEDIATE_PROFILE,
  [SEEDS[0]],
  MAX_SECONDS,
).runs[0];
assert.deepEqual(
  determinismProbe,
  adaptive[2].runs[0],
  "restricted-observation pilot must reproduce exactly for a fixed track/noise seed",
);

const plainNovice = adaptive[0];
const plainIntermediate = adaptive[2];
const carveNovice = carveCohorts[0];
const carveIntermediate = carveCohorts[1];
const carveVerdict = {
  noviceMeanRetention:
    carveNovice.aggregate.meanDistance / plainNovice.aggregate.meanDistance,
  noviceMedianRetention:
    carveNovice.aggregate.medianDistance / plainNovice.aggregate.medianDistance,
  intermediateMeanGain:
    carveIntermediate.aggregate.meanDistance / plainIntermediate.aggregate.meanDistance,
};
const carvePromotionEligible =
  carveVerdict.noviceMeanRetention >= 0.9 &&
  carveVerdict.noviceMedianRetention >= 0.9 &&
  carveVerdict.intermediateMeanGain >= 1.05;

const report = {
  schemaVersion: 1,
  test: "synthetic-skill-frontier",
  seeds: SEEDS,
  maxSeconds: MAX_SECONDS,
  thresholds: {
    minimumAdjacentSeparation: MIN_SEPARATION,
    maximumTrimmedSeedSpread: MAX_TRIMMED_SPREAD,
    firstFlightDistance: FIRST_FLIGHT_DISTANCE,
  },
  checks: {
    monotonicAggregateSeparation: true,
    periodicMacrosBelowReactive: true,
    boundedSeedSpread: true,
    deterministicReplay: true,
    carveAutomaticallyEvaluated: true,
    modeledNovicesClearFirstFlight: true,
  },
  separations,
  adaptive,
  periodicMacros: macros,
  carve: {
    promotionCriteria: {
      noviceMeanRetention: 0.9,
      noviceMedianRetention: 0.9,
      intermediateMeanGain: 1.05,
    },
    verdict: carvePromotionEligible ? "promotion-candidate" : "lab-only",
    ratios: carveVerdict,
    cohorts: carveCohorts,
  },
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (jsonDestination === "stdout") {
  process.stdout.write(json);
} else if (jsonDestination) {
  writeFileSync(jsonDestination, json, "utf8");
  console.log(`synthetic frontier report written to ${jsonDestination}`);
} else {
  for (const profile of adaptive) {
    const a = profile.aggregate;
    console.log(
      `${profile.cohortId.padEnd(20)} mean=${a.meanDistance.toFixed(0).padStart(5)}m ` +
        `median=${a.medianDistance.toFixed(0).padStart(5)}m ` +
        `trimmed-spread=${a.trimmedSpreadRatio.toFixed(2)}x`,
    );
  }
  for (const macro of macros) {
    const a = macro.aggregate;
    console.log(
      `${macro.cohortId.padEnd(20)} mean=${a.meanDistance.toFixed(0).padStart(5)}m ` +
        `median=${a.medianDistance.toFixed(0).padStart(5)}m`,
    );
  }
  console.log(
    `carve verdict         ${carvePromotionEligible ? "PROMOTION CANDIDATE" : "LAB ONLY"} ` +
      `(novice mean ${carveVerdict.noviceMeanRetention.toFixed(2)}x, ` +
      `median ${carveVerdict.noviceMedianRetention.toFixed(2)}x; ` +
      `intermediate ${carveVerdict.intermediateMeanGain.toFixed(2)}x)`,
  );
  console.log(
    `synthetic frontier assertions: PASS (${((performance.now() - startedAt) / 1000).toFixed(2)}s)`,
  );
}
