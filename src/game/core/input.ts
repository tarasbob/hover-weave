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
 * Merges keyboard, pointer hold-zones (touch) and gamepad into one input
 * state. Pure DOM listeners; no React.
 *
 * Steering is two buttons everywhere by design (roadmap 5.2 cut): the
 * pointer's screen half, the stick's sign, and the d-pad all produce the
 * same digital -1 / 0 / +1 the keyboard does. Depth lives in the momentum
 * model, not in analog input.
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

  attach(target: HTMLElement): void {
    this.dispose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const inUi = e.target instanceof Element && e.target.closest("[data-ui]");
      const globalShortcut = e.code === "KeyR" || e.code === "Escape" || e.code === "KeyP";
      if (inUi && !globalShortcut) return;
      this.keys.add(e.code);
      if (e.code === "KeyR" || e.code === "Enter") this.state.restart = true;
      if (e.code === "Escape" || e.code === "KeyP") this.state.pause = true;
      if (["ArrowLeft", "ArrowRight", "Space", "ArrowUp", "ArrowDown"].includes(e.code)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => {
      this.keys.clear();
      this.pointers.clear();
    };

    this.pointerTarget = target;
    const onPointerDown = (e: PointerEvent) => {
      // Fingers on UI never enter the map, so lifting them can't cancel or
      // boost the fingers that are actually steering.
      if (e.target instanceof Element && e.target.closest("[data-ui]")) return;
      this.pointers.set(e.pointerId, e.clientX);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, e.clientX);
    };
    const onPointerUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
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
   * arrow keys. Crossing the center flips that finger's direction.
   */
  private pointerAxis(): number {
    const rect = this.pointerTarget?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    let left = false;
    let right = false;
    for (const x of this.pointers.values()) {
      if (x < cx) left = true;
      else right = true;
    }
    return (right ? 1 : 0) - (left ? 1 : 0);
  }

  /** Poll gamepad + merge sources. Call once per rendered frame. */
  poll(sensitivity = 1): void {
    let axis = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) axis -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) axis += 1;

    let boost =
      this.keys.has("Space") ||
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      this.keys.has("KeyW") ||
      this.keys.has("ArrowUp");

    // Dash is inert unless the Phase Dash lab flag is on (the sim masks it).
    let dash = this.keys.has("KeyS") || this.keys.has("ArrowDown");

    if (this.pointers.size > 0) {
      axis = this.pointerAxis();
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
