/**
 * Gamepad haptics (fun-frontier 5.4): the craft in the hands. Event pulses
 * by skill grade plus a low rumble floor while boosting. Deliberately
 * gamepad-only — `navigator.vibrate` is coarse, unsupported on iOS, and
 * fights the touch-steering fingers, so pads are the one channel with real
 * texture. Every call is a no-op when no pad (or no actuator) is present.
 */

import { clamp01 } from "./mathUtils";
import type { SimWorld } from "./world";

/** Chromium's dual-rumble surface (not yet in every TS dom lib). */
interface DualRumbleActuator {
  playEffect(
    type: "dual-rumble",
    params: {
      duration: number;
      strongMagnitude: number;
      weakMagnitude: number;
      startDelay?: number;
    },
  ): Promise<unknown>;
}

const BOOST_BED_INTERVAL = 0.12;

export class GamepadHaptics {
  enabled = true;
  private boostClock = 0;

  private actuator(): DualRumbleActuator | null {
    if (!this.enabled || typeof navigator === "undefined" || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      const actuator = (pad as (Gamepad & { vibrationActuator?: DualRumbleActuator }) | null)
        ?.vibrationActuator;
      if (actuator?.playEffect) return actuator;
    }
    return null;
  }

  /** One dual-rumble pulse; magnitudes 0..1, duration in ms. */
  pulse(strong: number, weak: number, duration: number): void {
    const actuator = this.actuator();
    if (!actuator) return;
    try {
      void actuator.playEffect("dual-rumble", {
        duration,
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      });
    } catch {
      /* actuator busy or detached — a dropped pulse is fine */
    }
  }

  nearMiss(grade: "close" | "razor" | "perfect"): void {
    if (grade === "perfect") this.pulse(0.55, 0.9, 70);
    else if (grade === "razor") this.pulse(0.3, 0.6, 55);
    else this.pulse(0.12, 0.35, 40);
  }

  thread(tightness: number): void {
    this.pulse(0.6 + tightness * 0.35, 0.9, 110);
  }

  pump(strength: number, wall: boolean): void {
    this.pulse(wall ? 0.7 : 0.35 + strength * 0.35, 0.5, wall ? 90 : 65);
  }

  /** Skyhook lip (fun-frontier 6.1): a rising kick scaled by launch energy. */
  launch(energy: number): void {
    this.pulse(0.25 + energy * 0.3, 0.6 + energy * 0.3, 90);
  }

  /** Touchdown: perfect rings light and bright, hard slams the strong motor. */
  land(grade: "clean" | "hard" | "perfect", impact: number): void {
    if (grade === "perfect") this.pulse(0.4, 0.9, 90);
    else if (grade === "hard") this.pulse(0.8 + impact * 0.2, 0.5, 170);
    else this.pulse(0.18, 0.32, 55);
  }

  dash(): void {
    this.pulse(0.5, 0.8, 80);
  }

  bounce(): void {
    this.pulse(0.75, 0.4, 120);
  }

  shatter(): void {
    this.pulse(0.5, 0.75, 90);
  }

  shieldBreak(): void {
    this.pulse(0.85, 0.6, 180);
  }

  boostStart(): void {
    this.pulse(0.25, 0.5, 90);
  }

  death(speedNorm: number): void {
    this.pulse(1, 0.8, 260 + speedNorm * 140);
  }

  /** Per-frame: a faint continuous bed while the boost is lit. */
  update(world: SimWorld, dt: number): void {
    if (world.status === "running" && world.boosting) {
      this.boostClock += dt;
      if (this.boostClock >= BOOST_BED_INTERVAL) {
        this.boostClock = 0;
        this.pulse(0, 0.14 + world.boostCharge * 0.08, BOOST_BED_INTERVAL * 1000 + 30);
      }
    } else {
      this.boostClock = BOOST_BED_INTERVAL; // fire immediately on re-ignite
    }
  }
}
