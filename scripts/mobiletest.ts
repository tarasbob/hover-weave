import assert from "node:assert/strict";
import { InputManager } from "../src/game/core/input";
import { TiltAxis, TiltControls, screenRoll, tiltAxis } from "../src/game/core/tilt";
import { isFullscreen, isStandalone, supportsFullscreen, toggleFullscreen } from "../src/game/core/orientation";

const rad = Math.PI / 180;
// Build physically consistent sensor readings from a screen-plane wheel angle.
function reading(roll: number, orientation: number, pitch = 55) {
  const x = -Math.sin(roll * rad) * Math.sin(pitch * rad);
  const y = Math.cos(roll * rad) * Math.sin(pitch * rad);
  const a = orientation * rad;
  const upX = x * Math.cos(a) + y * Math.sin(a);
  const upY = -x * Math.sin(a) + y * Math.cos(a);
  const upZ = Math.cos(pitch * rad);
  return { beta: Math.asin(upY) / rad, gamma: Math.atan2(-upX, upZ) / rad };
}

for (const orientation of [0, 90, 180, 270, -90]) {
  for (const pitch of [20, 55, 85]) {
    for (const roll of [-40, -15, 0, 15, 40]) {
      const { beta, gamma } = reading(roll, orientation, pitch);
      assert.ok(Math.abs(screenRoll(beta, gamma, orientation)! - roll) < 1e-8,
        `Screen roll ${roll}° remains correct at orientation ${orientation}°, pitch ${pitch}°`);
    }
  }
}
assert.equal(screenRoll(null, 0, 90), null);
assert.equal(screenRoll(NaN, 0, 90), null);
assert.equal(screenRoll(0, 0, 90), null, "flat device has no wheel direction");
assert.equal(tiltAxis(2), 0, "small hand jitter stays in the deadzone");
assert.equal(tiltAxis(28), 1);
assert.equal(tiltAxis(-60), -1);
assert.ok(tiltAxis(10) > 0 && tiltAxis(10) < tiltAxis(20), "rotation strength is continuous");
assert.equal(tiltAxis(15, 15), 1, "adjustable full steering angle");

{
  const axis = new TiltAxis();
  let time = 1000;
  const sample = (roll: number, orientation = 90) => {
    const sensor = reading(roll, orientation);
    axis.sample(sensor.beta, sensor.gamma, orientation, time);
  };
  sample(12);
  assert.equal(axis.poll(time), 0, "first reading calibrates a comfortable hold");
  sample(32);
  const initial = axis.poll(time += 16);
  assert.ok(initial > 0 && initial < tiltAxis(20), "smoothing avoids sudden input jumps");
  for (let i = 0; i < 25; i++) { sample(32); axis.poll(time += 16); }
  assert.ok(Math.abs(axis.poll(time) - tiltAxis(20)) < 0.002);
  axis.recalibrate();
  assert.equal(axis.poll(time += 16), 0, "manual centering immediately neutralizes input");
  sample(-15, 270);
  assert.equal(axis.poll(time += 16), 0, "changing landscape side recenters automatically");
  sample(15, 270);
  assert.ok(axis.poll(time += 16) > 0);
  assert.equal(axis.poll(time += 800), 0, "stale sensor data cannot leave steering stuck");
  sample(30, 270);
  assert.equal(axis.poll(time += 16), 0, "recovered sensor starts from a fresh center");
  sample(45, 270);
  assert.ok(axis.poll(time += 16) > 0);
  axis.sample(null, null, 270, time);
  assert.equal(axis.poll(time), 0, "invalid sensor data immediately releases steering");
}
console.log("tilt math: PASS (both landscape sides, screen-plane rotation, proportionality, deadzone, smoothing, centering, stale data)");

async function browserTests() {
  class Surface extends EventTarget {
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, width: 800 }; }
  }
  let time = 1000;
  let permission: "granted" | "denied" = "granted";
  let requests = 0;
  class Sensor extends Event {
    static async requestPermission() { requests++; return permission; }
  }
  const orientation = Object.assign(new EventTarget(), { angle: 90 });
  const root = {
    requestFullscreen: async () => { page.fullscreenElement = root; },
  };
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible", fullscreenElement: null as object | null,
    documentElement: root, fullscreenEnabled: true,
    exitFullscreen: async () => { page.fullscreenElement = null; },
  });
  const browser = Object.assign(new EventTarget(), {
    DeviceOrientationEvent: Sensor, isSecureContext: true, screen: { orientation },
    matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" ||
      (query === "(display-mode: fullscreen)" && Boolean(page.fullscreenElement)) }),
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const event = (target: EventTarget, type: string, data: object = {}) => {
    const e = new Event(type);
    Object.assign(e, data);
    Object.defineProperty(e, "timeStamp", { value: time });
    target.dispatchEvent(e);
  };
  const sendRoll = (roll: number) => event(browser, "deviceorientation", reading(roll, 90));
  const input = new InputManager();
  const tilt = new TiltControls();
  try {
    replace("window", browser);
    replace("document", page);
    replace("navigator", { getGamepads: () => [] });
    replace("Element", Surface);
    replace("performance", { now: () => time });
    const field = new Surface();
    input.attach(field as unknown as HTMLElement);
    assert.equal(requests, 0, "attaching input must never request sensor permission");
    assert.equal(await input.tilt.enable(), true);
    assert.equal(requests, 1);
    assert.equal(input.tilt.getSnapshot(), "waiting");
    sendRoll(0);
    assert.equal(input.tilt.getSnapshot(), "ready");
    sendRoll(20);
    time += 16;
    input.poll();
    assert.ok(input.state.axis > 0 && input.state.axis < 1, "sensor reaches merged input as a fraction");
    event(field, "pointerdown", { pointerId: 1, clientX: 100 });
    time += 16;
    input.poll();
    assert.equal(input.state.axis, -1, "touch can override tilt immediately");
    event(browser, "pointerup", { pointerId: 1 });
    time += 16;
    input.poll();
    assert.ok(input.state.axis > 0, "tilt resumes after touch releases");
    input.setBoostHeld(true);
    time += 16;
    input.poll();
    assert.equal(input.state.boost, true);
    assert.ok(input.state.axis > 0, "boost button preserves proportional tilt steering");
    event(browser, "blur");
    assert.equal(input.state.axis, 0);
    assert.equal(input.state.boost, false);
    input.dispose();
    assert.equal(input.tilt.getSnapshot(), "off", "disposal releases sensor listeners");
    sendRoll(-20);
    assert.equal(input.tilt.getSnapshot(), "off");

    permission = "denied";
    assert.equal(await tilt.enable(), false);
    assert.equal(tilt.getSnapshot(), "denied");
    assert.equal(tilt.poll(time), 0, "denied permission cannot contribute steering");
    permission = "granted";
    const pending = tilt.enable();
    tilt.disable();
    assert.equal(await pending, false, "cancelled permission request cannot reactivate sensors");
    browser.isSecureContext = false;
    assert.equal(await tilt.enable(), false);
    assert.equal(tilt.getSnapshot(), "unavailable");

    assert.equal(supportsFullscreen(), true);
    assert.equal(await toggleFullscreen(), "entered");
    assert.equal(isFullscreen(), true);
    assert.equal(isStandalone(), false, "native fullscreen remains distinguishable from an installed app");
    assert.equal(await toggleFullscreen(), "exited");
    assert.equal(isFullscreen(), false);
  } finally {
    input.dispose();
    tilt.disable();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log("mobile input lifecycle: PASS (permission, denial, cancellation, source merging, boost, blur, disposal, native fullscreen exit)");
}
void browserTests().catch((error) => { console.error(error); process.exitCode = 1; });
