import type { BufferAttribute } from "three/webgpu";

/** Mark only the rewritten, rendered prefix of an instanced buffer for upload. */
export function updateInstanceRange(attribute: BufferAttribute, count: number): void {
  if (count === 0) return;
  // A mesh can be skipped by an auxiliary pass; replace any pending range
  // because every live instance in this prefix has just been rewritten.
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}
