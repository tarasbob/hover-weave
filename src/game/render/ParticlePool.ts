export interface Particle {
  alive: boolean;
  /** Track-space coordinates (s converts to z each frame). */
  x: number; y: number; s: number;
  vx: number; vy: number; vs: number;
  drag: number; grav: number;
  age: number; life: number;
  size0: number; size1: number;
  r: number; g: number; b: number; a: number;
  /** 0 = billboard spark, 1 = z-stretched streak. */
  kind: 0 | 1;
  stretch: number;
  /** Wreck sparks stay in the cinematic frame after the road stops gliding. */
  crash: boolean;
}

const SPAWN_DEFAULTS = {
  alive: true, age: 0, drag: 0, grav: 0, vx: 0, vy: 0, vs: 0,
  kind: 0, stretch: 1, a: 1, size1: 0, crash: false,
} as const;

/** Ring-buffer replacement with a dense live list: frames visit only live sparks. */
export class ParticlePool {
  readonly active: Particle[] = [];
  private readonly particles: Particle[];
  private cursor = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Particle capacity must be a positive integer");
    }
    this.particles = Array.from({ length: capacity }, () => ({
      alive: false, x: 0, y: 0, s: 0, vx: 0, vy: 0, vs: 0,
      drag: 0, grav: 0, age: 0, life: 1, size0: 1, size1: 1,
      r: 1, g: 1, b: 1, a: 1, kind: 0, stretch: 1, crash: false,
    }));
  }

  spawn(values: Partial<Omit<Particle, "alive">>): void {
    const particle = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % this.particles.length;
    if (!particle.alive) this.active.push(particle);
    Object.assign(particle, SPAWN_DEFAULTS, values);
  }

  removeAt(index: number): void {
    this.active[index].alive = false;
    const last = this.active.pop()!;
    if (index < this.active.length) this.active[index] = last;
  }

  clear(): void {
    for (const particle of this.active) particle.alive = false;
    this.active.length = 0;
  }
}
