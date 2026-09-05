import { clamp } from "./mathUtils";

const DEG = Math.PI / 180;
export const TILT_DEADZONE = 2.5;
export const TILT_FULL_ANGLE = 28;
const STALE_MS = 750;

/** Clockwise roll in the displayed screen plane, independent of compass heading.
 * Project the orientation matrix's world-up vector into screen coordinates.
 * Unlike swapping beta/gamma, this stays continuous past their Euler seams.
 */
export function screenRoll(beta: number | null, gamma: number | null, screenAngle: number): number | null {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const upX = -Math.cos(beta * DEG) * Math.sin(gamma * DEG);
  const upY = Math.sin(beta * DEG);
  if (Math.hypot(upX, upY) < 0.15) return null; // A flat phone has no useful wheel angle.
  const a = screenAngle * DEG;
  const x = upX * Math.cos(a) - upY * Math.sin(a);
  const y = upX * Math.sin(a) + upY * Math.cos(a);
  return Math.atan2(-x, y) / DEG;
}

export function tiltAxis(angle: number, fullAngle = TILT_FULL_ANGLE): number {
  return Math.sign(angle) * clamp((Math.abs(angle) - TILT_DEADZONE) / (fullAngle - TILT_DEADZONE), 0, 1);
}

/** Pure sensor processing, shared by live input and deterministic tests. */
export class TiltAxis {
  fullAngle = TILT_FULL_ANGLE;
  private center: number | null = null;
  private roll: number | null = null;
  private orientation: number | null = null;
  private sampledAt = -Infinity;
  private polledAt = 0;
  private value = 0;

  sample(beta: number | null, gamma: number | null, orientation: number, now: number): boolean {
    const roll = screenRoll(beta, gamma, orientation);
    if (roll === null) { this.reset(); return false; }
    if (this.orientation !== orientation || now - this.sampledAt > STALE_MS) this.reset();
    this.orientation = orientation;
    this.roll = roll;
    this.sampledAt = now;
    if (this.center === null) this.center = roll;
    return true;
  }

  recalibrate(): void {
    this.center = this.roll;
    this.value = 0;
  }

  reset(): void {
    this.center = null;
    this.roll = null;
    this.value = 0;
    this.sampledAt = -Infinity;
    this.polledAt = 0;
  }

  poll(now: number): number {
    if (now - this.sampledAt > STALE_MS || this.roll === null || this.center === null) {
      this.reset();
      return 0;
    }
    const delta = ((this.roll - this.center + 540) % 360) - 180;
    const target = tiltAxis(delta, this.fullAngle);
    const dt = this.polledAt ? clamp(now - this.polledAt, 0, 100) : 16;
    this.polledAt = now;
    this.value += (target - this.value) * (1 - Math.exp(-dt / 65));
    if (Math.abs(this.value) < 0.001) this.value = 0;
    return this.value;
  }
}

export type TiltStatus = "off" | "requesting" | "waiting" | "ready" | "denied" | "unavailable";
type OrientationPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

/** Permission is deliberately session-only; saved preferences cannot grant sensors. */
export class TiltControls {
  readonly axis = new TiltAxis();
  private status: TiltStatus = "off";
  private listeners = new Set<() => void>();
  private detach: (() => void) | null = null;
  private generation = 0;
  private active = false;
  private lastSample = -Infinity;
  private enabledAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  getSnapshot = (): TiltStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private setStatus(status: TiltStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.listeners.forEach((listener) => listener());
  }

  /** Call directly in the click handler, before any fullscreen await. */
  async enable(): Promise<boolean> {
    this.disable();
    const generation = this.generation;
    if (typeof window === "undefined" || !window.isSecureContext || !window.DeviceOrientationEvent) {
      this.setStatus("unavailable");
      return false;
    }
    this.setStatus("requesting");
    try {
      const api = window.DeviceOrientationEvent as OrientationPermission;
      if (api.requestPermission && await api.requestPermission() !== "granted") {
        if (generation === this.generation) this.setStatus("denied");
        return false;
      }
      if (generation !== this.generation) return false;
      this.active = true;
      this.enabledAt = performance.now();
      this.lastSample = -Infinity;
      this.setStatus("waiting");
      const receive = (event: DeviceOrientationEvent) => {
        if (document.visibilityState === "hidden") return;
        const angle = window.screen?.orientation?.angle ??
          (window as Window & { orientation?: number }).orientation ?? 0;
        const now = performance.now();
        if (this.axis.sample(event.beta, event.gamma, angle, now)) {
          this.lastSample = now;
          this.setStatus("ready");
        } else this.setStatus("waiting");
      };
      const reset = () => this.axis.reset();
      window.addEventListener("deviceorientation", receive);
      window.addEventListener("orientationchange", reset);
      window.screen?.orientation?.addEventListener("change", reset);
      this.detach = () => {
        window.removeEventListener("deviceorientation", receive);
        window.removeEventListener("orientationchange", reset);
        window.screen?.orientation?.removeEventListener("change", reset);
      };
      this.timer = setInterval(() => {
        if (document.visibilityState === "hidden") return;
        const now = performance.now();
        if (now - this.lastSample > 2500 && now - this.enabledAt > 2500) this.setStatus("unavailable");
      }, 500);
      return true;
    } catch {
      if (generation === this.generation) this.setStatus("denied");
      return false;
    }
  }

  disable(): void {
    this.generation++;
    this.active = false;
    this.detach?.();
    this.detach = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.axis.reset();
    this.setStatus("off");
  }

  recalibrate(): void { this.axis.recalibrate(); }
  reset(): void { this.axis.reset(); }
  poll(now: number): number { return this.active ? this.axis.poll(now) : 0; }
}
