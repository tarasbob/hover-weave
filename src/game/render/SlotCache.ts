/**
 * Fixed-size cache for deterministic scenery indexed by integer track slots.
 * A moving window reuses descriptors until it advances into the next slot;
 * wrapping, retries and distance jumps never grow retained memory.
 */
export class SlotCache<T> {
  private readonly keys: Float64Array;
  private readonly values: Array<T | undefined>;

  constructor(
    private readonly capacity: number,
    private readonly create: (slot: number) => T,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Slot cache capacity must be a positive integer");
    }
    this.keys = new Float64Array(capacity).fill(Number.NaN);
    this.values = new Array<T | undefined>(capacity);
  }

  get(slot: number): T {
    const index = ((slot % this.capacity) + this.capacity) % this.capacity;
    if (this.keys[index] !== slot) {
      this.values[index] = this.create(slot);
      this.keys[index] = slot;
    }
    return this.values[index] as T;
  }
}
