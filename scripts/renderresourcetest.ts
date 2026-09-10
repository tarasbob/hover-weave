import assert from "node:assert/strict";
import { InstancedBufferAttribute } from "three/webgpu";
import { LOOKAHEAD } from "../src/game/core/constants";
import { ParticlePool } from "../src/game/render/ParticlePool";
import { SlotCache } from "../src/game/render/SlotCache";
import { updateInstanceRange } from "../src/game/render/instanceUpdates";

// The maximum visible window stays hot, including negative startup slots.
let generated = 0;
const capacity = Math.ceil((LOOKAHEAD.MAX + 100) / 21) + 2;
const slots = new SlotCache(capacity, (slot) => {
  generated++;
  return { slot };
});
const first = -2;
const last = Math.ceil((LOOKAHEAD.MAX + 60) / 21);
const descriptors = Array.from({ length: last - first + 1 }, (_, i) => slots.get(first + i));
for (let frame = 0; frame < 600; frame++) {
  for (let slot = first; slot <= last; slot++) {
    assert.equal(slots.get(slot), descriptors[slot - first]);
  }
}
assert.equal(generated, descriptors.length, "stationary scenery must not rebuild descriptors");
slots.get(last + 1);
assert.equal(generated, descriptors.length + 1, "advancing one slot creates one descriptor");
for (const jump of [1_000_000, -1_000_000, 0, 100_000_000]) {
  for (let slot = jump; slot < jump + capacity; slot++) assert.equal(slots.get(slot).slot, slot);
  const generationAtJump = generated;
  for (let slot = jump; slot < jump + capacity; slot++) assert.equal(slots.get(slot).slot, slot);
  assert.equal(generated, generationAtJump, "jumped windows must remain cached within fixed capacity");
}
const nullableSlots = new SlotCache(1, () => null);
assert.equal(nullableSlots.get(-1), null);
assert.equal(nullableSlots.get(-1), null);

// Every backend receives component ranges, including shrink/grow after a skipped frame.
for (const itemSize of [2, 4, 16]) {
  const attribute = new InstancedBufferAttribute(new Float32Array(100 * itemSize), itemSize);
  updateInstanceRange(attribute, 0);
  assert.equal(attribute.version, 0, "empty pools must not request uploads");
  updateInstanceRange(attribute, 7);
  assert.deepEqual(attribute.updateRanges, [{ start: 0, count: 7 * itemSize }]);
  updateInstanceRange(attribute, 3);
  assert.deepEqual(attribute.updateRanges, [{ start: 0, count: 3 * itemSize }]);
  attribute.clearUpdateRanges(); // Renderer consumed the upload.
  updateInstanceRange(attribute, 0);
  assert.equal(attribute.updateRanges.length, 0);
  updateInstanceRange(attribute, 80);
  assert.deepEqual(attribute.updateRanges, [{ start: 0, count: 80 * itemSize }]);
  assert.equal(attribute.version, 3);
}

// Ring replacement must neither duplicate active particles nor lose the swapped
// element when multiple particles expire in a single frame.
const particles = new ParticlePool(3);
assert.equal(particles.active.length, 0);
particles.spawn({ x: 1, grav: -9, kind: 1, crash: true, a: 0.2 });
particles.spawn({ x: 2 });
particles.spawn({ x: 3 });
particles.spawn({ x: 4 });
assert.equal(particles.active.length, 3);
assert.equal(new Set(particles.active).size, 3);
assert.deepEqual(particles.active.map((p) => p.x).sort(), [2, 3, 4]);
const reused = particles.active.find((p) => p.x === 4)!;
assert.equal(reused.grav, 0);
assert.equal(reused.kind, 0);
assert.equal(reused.crash, false);
assert.equal(reused.a, 1);
particles.removeAt(1);
assert.equal(particles.active.length, 2);
assert.ok(particles.active.every((p) => p.alive));
particles.spawn({ x: 5 });
assert.equal(new Set(particles.active).size, particles.active.length);
const visited: number[] = [];
for (let i = 0; i < particles.active.length;) {
  visited.push(particles.active[i].x);
  particles.removeAt(i);
}
assert.equal(new Set(visited).size, 3);
assert.equal(particles.active.length, 0);
particles.spawn({ x: 6 });
const beforeClear = particles.active[0];
particles.clear();
assert.equal(beforeClear.alive, false);
assert.equal(particles.active.length, 0);
for (let i = 0; i < 20; i++) particles.spawn({ x: i });
assert.equal(particles.active.length, 3);
assert.equal(new Set(particles.active).size, 3);
assert.throws(() => new ParticlePool(0), RangeError);
assert.throws(() => new SlotCache(0, () => 0), RangeError);

console.log("Render resources: bounded scenery reuse, live-only particle iteration and active-prefix GPU uploads verified.");
