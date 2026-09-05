/** Exact simulation fingerprints captured before splitting SimWorld systems. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import type { RunConfig } from "../src/game/core/modes";
import { SimWorld } from "../src/game/core/world";
import { autopilot } from "./pilots";

const cases: { name: string; config: RunConfig; expected: string }[] = [
  { name: "opening", config: { mode: "endless", seed: "test-3" }, expected: "8c1278d31f8d6632bd2f00176afb31b8b77b7faba3411cc7e66b16f4bab181fc" },
  { name: "heated", config: { mode: "endless", seed: "world-contract", heat: ["fastMovers", "denseField"] }, expected: "b6aec8a9917e62d7deabcab0281ff947c1607ea3561de38702b07fa59353d0cf" },
  { name: "laboratory", config: { mode: "endless", seed: "world-contract", lab: ["surge", "dash", "carve"] }, expected: "702119bf19a6410933774fdadf2bf7c29bbc0fe19031af1f296170362d5d9caf" },
  { name: "deep-events", config: { mode: "endless", seed: "world-contract", skipTo: 9000 }, expected: "d29bce1c588cfa86096bf89d4faeff507101e805780027161618f0759632aa5b" },
  { name: "mythic", config: { mode: "endless", seed: "world-contract", skipTo: 19950 }, expected: "cc0d80033565d513f507f5c1a6f6857675e89eece1b85c40322bb304ca9b5f9b" },
  { name: "sprint", config: { mode: "sprint", seed: "world-contract" }, expected: "3a1d8f5058599f0ff02a6b3fe5590d797e3bbd13da7e93a0ecc0c355f9e5c03a" },
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
