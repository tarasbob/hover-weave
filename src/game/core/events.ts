/** Minimal typed event emitter used to decouple sim -> audio/fx/ui. */

export type GameEvents = {
  nearMiss: { x: number; s: number; clearance: number; flowPoints: number };
  shard: { x: number; y: number; combo: number };
  shieldPickup: { x: number };
  shieldBreak: { x: number };
  death: { x: number; speed: number };
  boostStart: undefined;
  boostEnd: undefined;
  flowTier: { tier: number; prev: number };
  biome: { index: number; name: string };
  lightning: { intensity: number };
  setpiece: { name: string };
  runStart: { seed: string; daily: boolean };
  slabFall: { x: number; s: number };
};

type Handler<T> = (payload: T) => void;

export class Emitter {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) (fn as Handler<GameEvents[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
