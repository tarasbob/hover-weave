import { clamp } from "./mathUtils";

export interface InputState {
  /** Steering axis, -1 (left) .. 1 (right). */
  axis: number;
  boost: boolean;
  /** Held dash button (lab 5.3 only; the sim detects the rising edge). */
  dash: boolean;
  /** Edge-triggered actions consumed by the game loop / UI. */
  restart: boolean;
  pause: boolean;
}

/**
 * Sub-tick steering (fun-frontier 1.1): instead of sampling "is the key down
 * right now?" once per frame, integrate *how long* each direction was held
 * across the poll window using event timestamps. Holding reads exactly ±1
 * (the novice feel is unchanged); tapping produces honest fractions of the
 * window — PWM steering, the Trackmania keyboard technique — and a tap that
 * begins and ends inside a single frame can no longer be lost.
 *
 * Pure and DOM-free: the InputManager feeds it press/release transitions
 * with high-resolution timestamps and drains it once per poll. The sim is
 * untouched — it already consumes a 1/127-quantized axis, so recordings of
 * fractional values replay bit-exactly.
 */
export class SubTickAxis {
  private left = false;
  private right = false;
  /** Signed hold-time integral (ms) accumulated since the last drain. */
  private integral = 0;
  private lastEvent = 0;
  private lastDrain = 0;

  private get sign(): number {
    return (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }

  /** Fold the stretch since the last event (at the current sign) in. */
  private settle(now: number): void {
    const t = Math.max(now, this.lastEvent); // events may arrive out of order
    this.integral += (t - this.lastEvent) * this.sign;
    this.lastEvent = t;
  }

  /** Align the window origin (call when listeners attach). */
  reset(now: number): void {
    this.left = false;
    this.right = false;
    this.integral = 0;
    this.lastEvent = now;
    this.lastDrain = now;
  }

  set(dir: -1 | 1, held: boolean, now: number): void {
    this.settle(now);
    if (dir < 0) this.left = held;
    else this.right = held;
  }

  clear(now: number): void {
    this.settle(now);
    this.left = false;
    this.right = false;
  }

  /** True if either direction is currently held. */
  get held(): boolean {
    return this.left || this.right;
  }

  /** Average signed axis over the window since the last drain (-1..1). */
  drain(now: number): number {
    this.settle(now);
    const window = now - this.lastDrain;
    const axis = window > 1e-6 ? this.integral / window : this.sign;
    this.integral = 0;
    this.lastDrain = this.lastEvent;
    return clamp(axis, -1, 1);
  }
}

const nowMs = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Merges keyboard, pointer hold-zones (touch) and gamepad into one input
 * state. Pure DOM listeners; no React.
 *
 * Steering is two buttons everywhere by design (roadmap 5.2 cut): the
 * pointer's screen half, the stick's sign, and the d-pad all produce the
 * same digital -1 / 0 / +1 the keyboard does. Depth lives in the momentum
 * model — and, since fun-frontier 1.1, in *cadence*: keyboard and touch
 * transitions are integrated sub-tick, so the axis the sim sees is the
 * fraction of the frame each direction was actually held.
 */
export class InputManager {
  readonly state: InputState = { axis: 0, boost: false, dash: false, restart: false, pause: false };

  private keys = new Set<string>();
  /** Active game pointers (fingers on the field), id -> last clientX. */
  private pointers = new Map<number, number>();
  private pointerTarget: HTMLElement | null = null;
  private detach: (() => void) | null = null;
  private gamepadRestartHeld = false;
  private gamepadPauseHeld = false;
  /** Sub-tick integrators (keyboard and touch are separate sources). */
  private keySteer = new SubTickAxis();
  private touchSteer = new SubTickAxis();

  attach(target: HTMLElement): void {
    this.dispose();
    this.keySteer.reset(nowMs());
    this.touchSteer.reset(nowMs());
    const stamp = (e: Event): number => (e.timeStamp > 0 ? e.timeStamp : nowMs());
    const syncKeySteer = (t: number) => {
      this.keySteer.set(-1, this.keys.has("ArrowLeft") || this.keys.has("KeyA"), t);
      this.keySteer.set(1, this.keys.has("ArrowRight") || this.keys.has("KeyD"), t);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const inUi = e.target instanceof Element && e.target.closest("[data-ui]");
      const globalShortcut = e.code === "KeyR" || e.code === "Escape" || e.code === "KeyP";
      if (inUi && !globalShortcut) return;
      this.keys.add(e.code);
      syncKeySteer(stamp(e));
      if (e.code === "KeyR" || e.code === "Enter") this.state.restart = true;
      if (e.code === "Escape" || e.code === "KeyP") this.state.pause = true;
      if (["ArrowLeft", "ArrowRight", "Space", "ArrowUp", "ArrowDown"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      syncKeySteer(stamp(e));
    };
    const onBlur = () => {
      this.keys.clear();
      this.pointers.clear();
      this.keySteer.clear(nowMs());
      this.touchSteer.clear(nowMs());
    };

    this.pointerTarget = target;
    const onPointerDown = (e: PointerEvent) => {
      // Fingers on UI never enter the map, so lifting them can't cancel or
      // boost the fingers that are actually steering.
      if (e.target instanceof Element && e.target.closest("[data-ui]")) return;
      this.pointers.set(e.pointerId, e.clientX);
      this.syncTouchSteer(stamp(e));
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, e.clientX);
        this.syncTouchSteer(stamp(e)); // crossing the center flips the zone
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (this.pointers.delete(e.pointerId)) this.syncTouchSteer(stamp(e));
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    target.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    this.detach = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      target.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.pointers.clear();
    this.pointerTarget = null;
  }

  /**
   * Hold zones, not an analog stick: each finger is a left or right button
   * by screen half, and opposite halves cancel exactly like holding both
   * arrow keys. Crossing the center flips that finger's direction. Zone
   * occupancy transitions feed the sub-tick integrator.
   */
  private syncTouchSteer(t: number): void {
    const rect = this.pointerTarget?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    let left = false;
    let right = false;
    for (const x of this.pointers.values()) {
      if (x < cx) left = true;
      else right = true;
    }
    this.touchSteer.set(-1, left, t);
    this.touchSteer.set(1, right, t);
  }

  /** Poll gamepad + merge sources. Call once per rendered frame. */
  poll(sensitivity = 1): void {
    const t = nowMs();
    const keyAxis = this.keySteer.drain(t);
    const touchAxis = this.touchSteer.drain(t);
    // Touch replaces keyboard while any finger contributed to the window.
    let axis = this.pointers.size > 0 || touchAxis !== 0 ? touchAxis : keyAxis;

    let boost =
      this.keys.has("Space") ||
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      this.keys.has("KeyW") ||
      this.keys.has("ArrowUp");

    // Dash is inert unless the Phase Dash lab flag is on (the sim masks it).
    let dash = this.keys.has("KeyS") || this.keys.has("ArrowDown");

    if (this.pointers.size > 0) {
      // Touch: a second finger ignites the boost, a third dashes. Both
      // halves held = boost straight ahead (the zones cancel above).
      if (this.pointers.size >= 2) boost = true;
      if (this.pointers.size >= 3) dash = true;
    }

    if (typeof navigator !== "undefined" && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      let restartPressed = false;
      let pausePressed = false;
      for (const pad of pads) {
        if (!pad) continue;
        // The stick is two buttons with a wide deadzone; the d-pad is native.
        const gx = pad.axes[0] ?? 0;
        if (Math.abs(gx) > 0.35) axis = Math.sign(gx);
        if (pad.buttons[14]?.pressed) axis = -1;
        if (pad.buttons[15]?.pressed) axis = 1;
        if (pad.buttons[0]?.pressed || pad.buttons[7]?.pressed) boost = true;
        if (pad.buttons[2]?.pressed) dash = true;
        restartPressed = Boolean(pad.buttons[1]?.pressed);
        pausePressed = Boolean(pad.buttons[9]?.pressed);
        break;
      }
      if (restartPressed && !this.gamepadRestartHeld) this.state.restart = true;
      if (pausePressed && !this.gamepadPauseHeld) this.state.pause = true;
      this.gamepadRestartHeld = restartPressed;
      this.gamepadPauseHeld = pausePressed;
    }

    this.state.axis = clamp(axis * sensitivity, -1, 1);
    this.state.boost = boost;
    this.state.dash = dash;
  }

  /** Consume edge-triggered flags. */
  consumeRestart(): boolean {
    const v = this.state.restart;
    this.state.restart = false;
    return v;
  }

  consumePause(): boolean {
    const v = this.state.pause;
    this.state.pause = false;
    return v;
  }
}
