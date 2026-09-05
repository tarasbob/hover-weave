import { clamp } from "./mathUtils";
import { ActionEventBuffer, type ActionFrame } from "./actionInput";

export interface InputState {
  /** Steering axis, -1 (left) .. 1 (right). */
  axis: number;
  boost: boolean;
  /** Held dash button (lab 5.3 only; the sim detects the rising edge). */
  dash: boolean;
  /** Edge-triggered actions consumed by the game loop / UI. */
  restart: boolean;
  pause: boolean;
  /** Live event-time actions; omitted by already sampled replay/pilot inputs. */
  actions?: ActionFrame;
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
  private actionEvents = new ActionEventBuffer();
  readonly state: InputState = {
    axis: 0, boost: false, dash: false, restart: false, pause: false,
    actions: this.actionEvents.frame,
  };

  private keys = new Set<string>();
  /** Active game pointers (fingers on the field), id -> last clientX. */
  private pointers = new Map<number, number>();
  private pointerTarget: HTMLElement | null = null;
  private detach: (() => void) | null = null;
  private focused = false;
  /** After focus returns, held pad buttons must not generate fresh shortcuts. */
  private baselineGamepad = false;
  private gamepadRestartHeld = false;
  private gamepadPauseHeld = false;
  private gamepadBoost = false;
  private gamepadDash = false;
  /** Sub-tick integrators (keyboard and touch are separate sources). */
  private keySteer = new SubTickAxis();
  private touchSteer = new SubTickAxis();

  attach(target: HTMLElement): void {
    this.dispose();
    this.focused = true;
    this.keySteer.reset(nowMs());
    this.touchSteer.reset(nowMs());
    const stamp = (e: Event): number => {
      const now = nowMs();
      // Older browsers can use epoch timestamps; all buffers use performance time.
      return e.timeStamp > 0 && Math.abs(e.timeStamp - now) < 60_000 ? e.timeStamp : now;
    };
    const syncKeySteer = (t: number) => {
      this.keySteer.set(-1, this.keys.has("ArrowLeft") || this.keys.has("KeyA"), t);
      this.keySteer.set(1, this.keys.has("ArrowRight") || this.keys.has("KeyD"), t);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !this.focused) return;
      const inUi = e.target instanceof Element && e.target.closest("[data-ui]");
      const globalShortcut = e.code === "KeyR" || e.code === "Escape" || e.code === "KeyP";
      if (inUi && !globalShortcut) return;
      this.keys.add(e.code);
      const t = stamp(e);
      syncKeySteer(t);
      this.syncActions(t);
      if (e.code === "KeyR" || e.code === "Enter") this.state.restart = true;
      if (e.code === "Escape" || e.code === "KeyP") this.state.pause = true;
      if (["ArrowLeft", "ArrowRight", "Space", "ArrowUp", "ArrowDown"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      const t = stamp(e);
      syncKeySteer(t);
      this.syncActions(t);
    };
    const onBlur = () => {
      this.focused = false;
      this.reset();
    };
    const onFocus = () => {
      this.focused = true;
      this.baselineGamepad = true;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBlur();
      else onFocus();
    };

    this.pointerTarget = target;
    const onPointerDown = (e: PointerEvent) => {
      // Fingers on UI never enter the map, so lifting them can't cancel or
      // boost the fingers that are actually steering.
      if (!this.focused || (e.target instanceof Element && e.target.closest("[data-ui]"))) return;
      this.pointers.set(e.pointerId, e.clientX);
      const t = stamp(e);
      this.syncTouchSteer(t);
      this.syncActions(t);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, e.clientX);
        this.syncTouchSteer(stamp(e)); // crossing the center flips the zone
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (this.pointers.delete(e.pointerId)) {
        const t = stamp(e);
        this.syncTouchSteer(t);
        this.syncActions(t);
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    target.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    this.detach = () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      target.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.focused = false;
    this.reset();
    this.pointerTarget = null;
  }

  /** Drop held controls and pending actions when focus or listeners are lost. */
  private reset(): void {
    this.keys.clear();
    this.pointers.clear();
    const t = nowMs();
    this.keySteer.reset(t);
    this.touchSteer.reset(t);
    this.actionEvents.reset(t);
    this.gamepadRestartHeld = false;
    this.gamepadPauseHeld = false;
    this.gamepadBoost = false;
    this.gamepadDash = false;
    this.baselineGamepad = false;
    this.state.axis = 0;
    this.state.boost = false;
    this.state.dash = false;
    this.state.restart = false;
    this.state.pause = false;
  }

  /** Merge held sources before recording edges, so releasing one never cancels another. */
  private syncActions(t: number): void {
    this.state.boost = this.gamepadBoost || this.pointers.size >= 2 ||
      this.keys.has("Space") || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ||
      this.keys.has("KeyW") || this.keys.has("ArrowUp");
    this.state.dash = this.gamepadDash || this.pointers.size >= 3 ||
      this.keys.has("KeyS") || this.keys.has("ArrowDown");
    this.actionEvents.set(this.state.boost, this.state.dash, t);
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
    if (!this.focused) return;
    const t = nowMs();
    const keyAxis = this.keySteer.drain(t);
    const touchAxis = this.touchSteer.drain(t);
    // Touch replaces keyboard while any finger contributed to the window.
    let axis = this.pointers.size > 0 || touchAxis !== 0 ? touchAxis : keyAxis;

    this.gamepadBoost = false;
    this.gamepadDash = false;
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
        this.gamepadBoost = Boolean(pad.buttons[0]?.pressed || pad.buttons[7]?.pressed);
        this.gamepadDash = Boolean(pad.buttons[2]?.pressed);
        restartPressed = Boolean(pad.buttons[1]?.pressed);
        pausePressed = Boolean(pad.buttons[9]?.pressed);
        break;
      }
      if (!this.baselineGamepad) {
        if (restartPressed && !this.gamepadRestartHeld) this.state.restart = true;
        if (pausePressed && !this.gamepadPauseHeld) this.state.pause = true;
      }
      this.gamepadRestartHeld = restartPressed;
      this.gamepadPauseHeld = pausePressed;
      this.baselineGamepad = false;
    }

    this.state.axis = clamp(axis * sensitivity, -1, 1);
    // Gamepad has no DOM button events, so its transitions use poll time.
    this.syncActions(t);
    this.actionEvents.drain(t);
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
