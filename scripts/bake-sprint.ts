/** Offline fixture bake: survive the canonical sprint using ordinary recorded inputs. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import { serializeFlight } from "../src/game/core/replay";
import { SimWorld } from "../src/game/core/world";
import { competitionRunConfig, selectCompetitionCourse } from "../src/game/competition/manifest";
import { verifyCompetitionFlight } from "../src/game/competition/verify";
import { superhumanPilot } from "./pilots";

const selection = { seasonId: "2026-preview-v9", courseId: "sprint-2026-w36" };
const { course } = selectCompetitionCourse(selection);
assert.equal(course.seed, "cubefield-sprint-2026-W36");
const world = new SimWorld();
world.start(competitionRunConfig(course));
const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
for (let step = 0; step < course.maxSteps && world.status === "running"; step++) {
  // This offline bake can spend more search time on the dense late sprint.
  // Controls still enter the same fixed-step world and recorder as human input.
  superhumanPilot(world, input, {
    horizonSeconds: 3.2,
    switchFractions: [0.5, 0.25, 0.75, 0.125],
  });
  world.update(FIXED_DT, input);
  if ((step + 1) % 3600 === 0) {
    console.log(`${world.time.toFixed(0)}s: ${world.distance.toFixed(0)}m, ${world.status}`);
  }
}
assert.equal(world.status, "finished", `Pilot crashed at ${world.time.toFixed(3)}s: ${JSON.stringify(world.stats.deathCause)}`);
const recording = world.getRecording();
assert.ok(recording);
recording.at = 0;
const payload = serializeFlight(recording);
const verified = verifyCompetitionFlight(payload, selection, Date.UTC(2026, 8, 5, 12));
assert.equal(verified.terminal, "finished");
assert.equal(verified.steps, 21600);
assert.equal(verified.duration, 180);
assert.equal(verified.score, world.stats.score);
assert.equal(verified.distance, world.stats.distance);
writeFileSync(new URL("../src/game/competition/fixtures/sprint-v9.flight", import.meta.url), payload + "\n");
console.log(JSON.stringify([verified.terminal, verified.steps, verified.duration, verified.score, verified.distance]));
