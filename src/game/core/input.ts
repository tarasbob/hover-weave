import { clamp } from "./mathUtils";

export interface InputState {
  /** Steering axis, -1 (left) .. 1 (right). */
  axis: number;
  boost: boolean;
  /** Edge-triggered actions consumed by the game loop / UI. */
  restart: boolean;
  pause: boolean;
}

/**
 * Merges keyboard, pointer-drag (touch) and gamepad into one input state.
 * Pure DOM listeners; no React.
 */
export class InputManager {
  readonly state: InputState = { axis: 0, boost: false, restart: false, pause: false };

  private keys = new Set<string>();
  private pointerActive = false;
  private pointerAxis = 0;
  private pointerCount = 0;
  private detach: (() => void) | null = null;
  private gestureCallbacks: (() => void)[] = [];
  private gestureFired = false;

  attach(target: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyR" || e.code === "Enter") this.state.restart = true;
      if (e.code === "Escape" || e.code === "KeyP") this.state.pause = true;
      if (["ArrowLeft", "ArrowRight", "Space", "ArrowUp", "ArrowDown"].includes(e.code)) {
        e.preventDefault();
      }
      this.fireGesture();
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => {
      this.keys.clear();
      this.pointerActive = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("[data-ui]")) return;
      this.pointerCount++;
      this.pointerActive = true;
      if (this.pointerCount === 1) this.updatePointer(e, target);
      this.fireGesture();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (this.pointerActive && e.isPrimary) this.updatePointer(e, target);
    };
    const onPointerUp = (e: PointerEvent) => {
      this.pointerCount = Math.max(0, this.pointerCount - 1);
      if (e.isPrimary || this.pointerCount === 0) {
        this.pointerActive = this.pointerCount > 0;
        if (!this.pointerActive) this.pointerAxis = 0;
      }
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
  }

  /** Register a one-shot callback for the first user gesture (audio unlock). */
  onFirstGesture(cb: () => void): void {
    if (this.gestureFired) cb();
    else this.gestureCallbacks.push(cb);
  }

  private fireGesture(): void {
    if (this.gestureFired) return;
    this.gestureFired = true;
    for (const cb of this.gestureCallbacks) cb();
    this.gestureCallbacks = [];
  }

  private updatePointer(e: PointerEvent, target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    // Full deflection at 22% of the screen width from center.
    this.pointerAxis = clamp((e.clientX - cx) / (rect.width * 0.22), -1, 1);
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

    if (this.pointerActive) {
      axis = this.pointerAxis;
      // Touch: a second finger anywhere ignites the boost.
      if (this.pointerCount >= 2) boost = true;
    }

    if (typeof navigator !== "undefined" && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      for (const pad of pads) {
        if (!pad) continue;
        const gx = pad.axes[0] ?? 0;
        if (Math.abs(gx) > 0.12) axis = clamp(gx * 1.15, -1, 1);
        if (pad.buttons[0]?.pressed || pad.buttons[7]?.pressed) boost = true;
        if (pad.buttons[1]?.pressed) this.state.restart = true;
        if (pad.buttons[9]?.pressed) this.state.pause = true;
        break;
      }
    }

    this.state.axis = clamp(axis * sensitivity, -1, 1);
    this.state.boost = boost;
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
