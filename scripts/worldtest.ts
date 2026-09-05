/** Exact v8 simulation fingerprints: broad bends, lethal edges and captured wreck state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FIXED_DT } from "../src/game/core/constants";
import type { InputState } from "../src/game/core/input";
import type { RunConfig } from "../src/game/core/modes";
import { SimWorld } from "../src/game/core/world";
import { autopilot } from "./pilots";

const cases: { name: string; config: RunConfig; expected: string }[] = [
  { name: "opening", config: { mode: "endless", seed: "test-3" }, expected: "4f8b6970be8e7827ff4d15b23e42a2955e38700e4625c56a218d39acb52d1e32" },
  { name: "heated", config: { mode: "endless", seed: "world-contract", heat: ["fastMovers", "denseField"] }, expected: "cb54dfbc7ccaf4527b56b1ea237a0f8d2b7e296f765e902752446e579aace8d6" },
  { name: "laboratory", config: { mode: "endless", seed: "world-contract", lab: ["surge", "dash", "carve"] }, expected: "cd447b2cad36353973f89bec0305f5c073b1ec1dad479cf8ed49ecc90579b652" },
  { name: "deep-events", config: { mode: "endless", seed: "world-contract", skipTo: 9000 }, expected: "4672df0644edad5de8fe84a91fc955dd1fdd7a4f4d08557075342c579b30182c" },
  { name: "mythic", config: { mode: "endless", seed: "world-contract", skipTo: 19950 }, expected: "ff434b853f6b8481ac833408fc9fff762d0aa79fb04e75fc7f48de9e87ef7345" },
  { name: "sprint", config: { mode: "sprint", seed: "world-contract" }, expected: "f3c9e372879653417aad7c7369dc456b07080209acb6529016a3015be7d9e9e0" },
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
