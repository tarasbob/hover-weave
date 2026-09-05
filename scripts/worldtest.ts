/** Exact v9 simulation fingerprints: demanding bends and curve-aware obstacle routes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import type { RunConfig } from "../src/game/core/modes";
import { SimWorld } from "../src/game/core/world";
import { autopilot } from "./pilots";

const cases: { name: string; config: RunConfig; expected: string }[] = [
  { name: "opening", config: { mode: "endless", seed: "test-3" }, expected: "597006e9d531717190bec1d9e5867da985e72563a7bf3a5b757a158751b9f42c" },
  { name: "heated", config: { mode: "endless", seed: "world-contract", heat: ["fastMovers", "denseField"] }, expected: "1b1dd153439224ed6a556ab37546964f5caa8fc9d7b4f729083550aad514f89d" },
  { name: "laboratory", config: { mode: "endless", seed: "world-contract", lab: ["surge", "dash", "carve"] }, expected: "83b39daa9f32fbf0143de476c1bb367b0e74882565fce95ffd3afe3f397d6bfe" },
  { name: "deep-events", config: { mode: "endless", seed: "world-contract", skipTo: 9000 }, expected: "ec16813e4d9030c2f50cb5b34b4106cf757153df868f7792ff97ba110cddc283" },
  { name: "mythic", config: { mode: "endless", seed: "world-contract", skipTo: 19950 }, expected: "ea387d4303ae4a66014b03404d0e0167ed00e588d55de242b5d8f30539972624" },
  { name: "sprint", config: { mode: "sprint", seed: "world-contract" }, expected: "1bfec4d624769a7e3ec402ca99486a33814bb7b00e11958499a4ce97fcee98ec" },
];

function fingerprint(world: SimWorld, config: RunConfig): string {
  const hash = createHash("sha256");
  const record = (value: unknown) => hash.update(JSON.stringify(value));
  const originalEmit = world.events.emit.bind(world.events);
  world.events.emit = (type, payload) => {
    record([type, payload]);
    originalEmit(type, payload);
  };
  world.collectDebug = true;
  world.start(config);
  const input: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  for (let step = 0; step < 9600 && world.status === "running"; step++) {
    autopilot(world, input);
    input.boost = step % 240 < 80;
    input.dash = step % 360 === 120;
    world.update(FIXED_DT, input);
    if (step % 120 === 0) record([
      world.time, world.distance, world.x, world.y, world.latVel, world.vy,
      world.bank, world.speed, world.boostCharge, world.energy, world.flowPoints,
      world.dangerFactor, world.stats, world.activeEvent,
      world.obstacles.filter((o) => o.active), world.pickups.filter((p) => p.active),
    ]);
  }
  // Freeze/slow-motion, traces, pools, public analysis and replay exports belong
  // to the contract too; equal final scores alone miss ordering regressions.
  for (let i = 0; i < 240; i++) world.update(FIXED_DT, input);
  const recording = world.getRecording();
  if (recording) recording.at = 0; // Export wall time is not simulation state.
  record([
    world.status, world.time, world.distance, world.x, world.y, world.speed,
    world.alpha, world.renderX, world.renderY, world.renderDistance,
    world.stats, world.chunkLog, world.getTrace(), world.buildForensics(),
    recording, world.obstacles, world.pickups,
  ]);
  world.events.emit = originalEmit;
  return hash.digest("hex");
}

const reused = new SimWorld();
for (const { name, config, expected } of cases) {
  const actual = fingerprint(reused, config);
  assert.equal(actual, expected, `${name}: fixed-step simulation changed`);
}
console.log("Simulation structure: exact state, event, replay and restart fingerprints passed.");
