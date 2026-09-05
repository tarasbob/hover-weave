import assert from "node:assert/strict";
import { FIXED_DT } from "../src/game/core/constants";
import { InputManager } from "../src/game/core/input";
import { ghostKey } from "../src/game/core/modes";
import { AXIS_LEVELS, resimulate, unpackAxis, unpackBoost, unpackDash } from "../src/game/core/replay";
import { createRunSession, retryRunSession } from "../src/game/core/session";
import { SimWorld } from "../src/game/core/world";

// A result belongs to the launch's course, including UTC and ISO-year edges.
{
  const clock = new Date("2026-09-06T23:59:59.999Z");
  const daily = createRunSession("daily", undefined, clock);
  const sprint = createRunSession("sprint", undefined, clock);
  clock.setTime(Date.parse("2026-09-07T00:00:00.001Z"));
  const nextDaily = createRunSession("daily", undefined, clock);
  const nextSprint = createRunSession("sprint", undefined, clock);
  assert.equal(daily.config.seed, "cubefield-daily-2026-09-06");
  assert.equal(ghostKey(daily.config.mode, daily.periodKey), "daily:2026-09-06");
  assert.equal(nextDaily.periodKey, "2026-09-07");
  assert.equal(sprint.config.seed, "cubefield-sprint-2026-W36");
  assert.equal(ghostKey(sprint.config.mode, sprint.periodKey), "sprint:2026-W36");
  assert.equal(nextSprint.periodKey, "2026-W37");

  // The retry action preserves the course that ended, even though a fresh
  // menu launch now targets a different UTC day/week. Its ghost key follows
  // the old period too, so a retry never races or writes the new course's PB.
  for (const [launched, next] of [[daily, nextDaily], [sprint, nextSprint]]) {
    const retry = retryRunSession(launched);
    assert.deepEqual(retry, launched, "fixed-course retry preserves seed and period");
    assert.notEqual(retry, launched, "a retry gets an independent session object");
    assert.notEqual(retry.config, launched.config, "launch setup must not mutate the prior config");
    assert.notEqual(retry.config.seed, next.config.seed, "retry does not rotate to the new period");
    assert.equal(
      ghostKey(retry.config.mode, retry.periodKey),
      ghostKey(launched.config.mode, launched.periodKey),
    );
  }

  // Friday Jan 1 still belongs to the previous ISO week-year.
  const newYear = createRunSession("sprint", undefined, new Date("2027-01-01T12:00:00Z"));
  assert.equal(newYear.periodKey, "2026-W53");
  assert.equal(newYear.config.seed, "cubefield-sprint-2026-W53");
  const trial = createRunSession("trial", "slalomGates", clock);
  assert.equal(trial.periodKey, null);
  assert.equal(trial.config.seed, "cubefield-trial-slalomGates");
  assert.equal(trial.config.trialId, "slalomGates");
  assert.deepEqual(retryRunSession(trial), trial, "trial retries retain their fixed identity");

  // Restarting endless draws again even when wall time has not moved.
  const originalRandom = Math.random;
  let draw = 0;
  try {
    Math.random = () => ++draw / 10;
    const first = createRunSession("endless", undefined, clock);
    const second = retryRunSession(first);
    assert.equal(first.periodKey, null);
    assert.notEqual(first.config.seed, second.config.seed);
    assert.equal(
      retryRunSession({ config: { mode: "endless", seed: "" }, periodKey: null }).config.mode,
      "endless",
      "restart before any launch begins free flight",
    );
  } finally {
    Math.random = originalRandom;
  }
  console.log("run session gate: PASS (UTC/day/week identity, fresh endless restarts)");
}

// Browser listener lifecycle without a renderer. A release event can be lost
// while focus/listeners are gone, so cleanup must discard every input source.
{
  class Surface extends EventTarget {
    ui = false;
    closest(): Surface | null { return this.ui ? this : null; }
    getBoundingClientRect() { return { left: 0, width: 800 }; }
  }
  const browser = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const field = new Surface();
  const pad = {
    axes: [0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
  };
  let clock = 1000;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: unknown) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const send = (target: EventTarget, type: string, data: object = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "timeStamp", { value: clock });
    Object.assign(event, data);
    target.dispatchEvent(event);
  };
  const key = (code: string, down = true) =>
    send(browser, down ? "keydown" : "keyup", { code, repeat: false });
  const pointer = (id: number, x: number, type = "pointerdown") =>
    send(type === "pointerdown" ? field : browser, type, { pointerId: id, clientX: x });
  const neutral = { axis: 0, boost: false, dash: false, restart: false, pause: false };
  const input = new InputManager();
  const snapshot = () => ({
    axis: input.state.axis, boost: input.state.boost, dash: input.state.dash,
    restart: input.state.restart, pause: input.state.pause,
  });
  try {
    replace("window", browser);
    replace("document", page);
    replace("Element", Surface);
    replace("navigator", { getGamepads: () => [pad] });
    replace("performance", { now: () => clock });

    input.attach(field as unknown as HTMLElement);
    key("KeyD");
    key("Space");
    key("KeyS");
    key("KeyR");
    key("Escape");
    clock += 16;
    input.poll();
    assert.deepEqual(snapshot(), {
      axis: 1, boost: true, dash: true, restart: true, pause: true,
    });
    input.dispose();
    assert.deepEqual(snapshot(), neutral, "dispose clears held controls and pending shortcuts");
    key("KeyA");
    pointer(1, 100);
    clock += 16;
    input.poll();
    assert.deepEqual(snapshot(), neutral, "detached listeners cannot reactivate input");

    input.attach(field as unknown as HTMLElement);
    pointer(1, 100);
    pointer(2, 150);
    pointer(3, 200);
    clock += 16;
    input.poll();
    assert.equal(input.state.axis, -1);
    assert.equal(input.state.boost, true);
    assert.equal(input.state.dash, true);
    // No pointerup or keyup is delivered. A remount must still be neutral.
    input.attach(field as unknown as HTMLElement);
    clock += 16;
    input.poll();
    assert.deepEqual(snapshot(), neutral, "reattaching clears all previous sources");

    key("KeyA");
    key("Space");
    key("KeyR");
    clock += 8;
    send(browser, "blur");
    clock += 8;
    input.poll();
    assert.deepEqual(snapshot(), neutral, "blur discards pre-blur tap integrals and actions");

    pad.buttons[9].pressed = true;
    pad.buttons[1].pressed = true;
    clock += 16;
    input.poll();
    assert.deepEqual(snapshot(), neutral, "background gamepad buttons cannot restart or unpause");
    send(browser, "focus");
    input.poll();
    assert.deepEqual(snapshot(), neutral, "held gamepad shortcuts do not fire on refocus");
    pad.buttons[9].pressed = false;
    pad.buttons[1].pressed = false;
    input.poll();
    pad.buttons[9].pressed = true;
    input.poll();
    assert.equal(input.consumePause(), true, "a fresh gamepad press works after refocus");
    pad.buttons[9].pressed = false;
    input.poll();

    field.ui = true;
    pointer(1, 100);
    pointer(2, 100);
    clock += 16;
    input.poll();
    assert.deepEqual(snapshot(), neutral, "UI pointers never become flight controls");
    field.ui = false;
    pointer(1, 700);
    clock += 16;
    input.poll();
    assert.equal(input.state.axis, 1, "fresh controls work after focus cleanup");
    assert.equal(input.state.boost, false, "no stale second finger survives cleanup");
    input.dispose();
    input.dispose();

    input.attach(field as unknown as HTMLElement);
    key("Space");
    key("KeyS");
    page.visibilityState = "hidden";
    send(page, "visibilitychange");
    input.poll();
    assert.deepEqual(snapshot(), neutral, "a hidden document clears actions even without window blur");
    page.visibilityState = "visible";
    send(page, "visibilitychange");
    input.dispose();

    // DOM action transitions are placed on fixed ticks, independent of the
    // render partition. Both edges of a 2 ms tap must survive; a held action
    // must remain held without creating additional rising edges.
    const actionEvents = [
      { at: 1, code: "Space", down: true }, { at: 1, code: "KeyS", down: true },
      { at: 3, code: "Space", down: false }, { at: 3, code: "KeyS", down: false },
      { at: 21, code: "Space", down: true }, { at: 24, code: "Space", down: false },
      { at: 51, code: "Space", down: true }, { at: 91, code: "Space", down: false },
      { at: 101, code: "Space", down: true }, { at: 103, code: "Space", down: false },
    ];
    class ChargedWorld extends SimWorld {
      override start(config: Parameters<SimWorld["start"]>[0]): void {
        super.start(config);
        this.energy = 60; // Enough to exercise dash alongside boost.
      }
    }
    let referenceActions: number[] | undefined;
    for (const hz of [30, 60, 144, 240]) {
      clock = 2000;
      input.attach(field as unknown as HTMLElement);
      key("KeyD");
      const live = new ChargedWorld();
      live.start({ mode: "endless", seed: "action-timing-regression", lab: ["dash"] });
      let event = 0;
      let previous = 0;
      for (let frame = 1; previous < 201; frame++) {
        const end = Math.min(201, frame * 1000 / hz);
        while (event < actionEvents.length && actionEvents[event].at <= end) {
          const change = actionEvents[event++];
          clock = 2000 + change.at;
          key(change.code, change.down);
        }
        clock = 2000 + end;
        input.poll();
        live.update((end - previous) / 1000, input.state);
        previous = end;
      }
      const recording = live.getRecording();
      assert.ok(recording);
      assert.equal(live.stats.boosts, 4, `${hz} Hz preserves every boost press`);
      assert.equal(live.stats.dashes, 1, `${hz} Hz preserves a sub-frame dash`);
      assert.ok(unpackBoost(recording.data[0]), "the first tap reaches the first tick");
      assert.ok(unpackDash(recording.data[0]), "dash is timestamped with boost");
      if (referenceActions) assert.deepEqual(recording.data, referenceActions, `${hz} Hz tick stream`);
      else referenceActions = [...recording.data];
      const replayed = resimulate(recording, new ChargedWorld());
      assert.equal(replayed.x, live.x);
      assert.equal(replayed.latVel, live.latVel);
      assert.equal(replayed.energy, live.energy);
      assert.deepEqual(replayed.stats, live.stats, `${hz} Hz actions replay exactly`);
      input.dispose();
    }

    // An airborne tap uses its press AND release. Starting at a controlled
    // apex isolates the input path from course generation and launch timing.
    for (const hz of [30, 60, 144, 240]) {
      for (const releaseAt of [3, 301]) {
        clock = 3000;
        input.attach(field as unknown as HTMLElement);
        const live = new ChargedWorld();
        live.start({ mode: "endless", seed: "air-action-timing" });
        live.airborne = true;
        live.y = live.prevY = 8;
        live.vy = 0;
        (live as unknown as { airJumpsLeft: number }).airJumpsLeft = 1;
        const changes = [{ at: 1, down: true }, { at: releaseAt, down: false }];
        let event = 0;
        let previous = 0;
        for (let frame = 1; previous < 351; frame++) {
          const end = Math.min(351, frame * 1000 / hz);
          while (event < changes.length && changes[event].at <= end) {
            const change = changes[event++];
            clock = 3000 + change.at;
            key("Space", change.down);
          }
          clock = 3000 + end;
          input.poll();
          live.update((end - previous) / 1000, input.state);
          previous = end;
        }
        assert.equal(live.stats.airJumps, releaseAt === 3 ? 1 : 0,
          `${hz} Hz distinguishes a 2 ms air-jump tap from a committed dive`);
        input.dispose();
      }
    }

    // Touch and keyboard are merged before queuing: lifting a second finger
    // cannot release a keyboard boost that remains held.
    clock = 4000;
    input.attach(field as unknown as HTMLElement);
    key("Space");
    pointer(1, 100);
    pointer(2, 700);
    clock += 2;
    pointer(2, 700, "pointerup");
    input.poll();
    assert.deepEqual(input.state.actions?.transitions.map((edge) => [edge.action, edge.held]),
      [["boost", true]], "overlapping sources produce a single merged boost edge");
    key("Space", false);
    input.poll();
    assert.deepEqual(input.state.actions?.transitions.map((edge) => [edge.action, edge.held]),
      [["boost", false]], "the last source releases the merged action");
    input.dispose();

    // A tap already delivered to an unfinished simulation tick must be
    // forgotten after focus loss or skipped polls while the game is paused.
    for (const interruption of ["blur", "hidden", "pause"] as const) {
      clock = 5000;
      input.attach(field as unknown as HTMLElement);
      const live = new ChargedWorld();
      live.start({ mode: "endless", seed: "pending-action-reset", lab: ["dash"] });
      key("KeyD");
      clock += 1;
      key("Space");
      key("KeyS");
      clock += 2;
      key("Space", false);
      key("KeyS", false);
      clock += 1;
      input.poll();
      live.update(0.004, input.state);
      assert.equal(live.time, 0, "action tap waits for a complete simulation tick");
      clock += 1;
      if (interruption === "blur") {
        send(browser, "blur");
        send(browser, "focus");
      } else if (interruption === "hidden") {
        page.visibilityState = "hidden";
        send(page, "visibilitychange");
        page.visibilityState = "visible";
        send(page, "visibilitychange");
      } else {
        input.poll(); // The paused renderer polls, but does not simulate.
      }
      clock += 8;
      input.poll();
      live.update(0.008, input.state);
      assert.equal(live.stats.boosts, 0, `${interruption} clears pending boost edges`);
      assert.equal(live.stats.dashes, 0, `${interruption} clears pending dash edges`);
      input.dispose();
    }
    console.log("event-time action gate: PASS (30/60/144/240 Hz, dash, air taps, holds, exact replay)");

    // End-to-end key events -> InputManager -> fixed-step sim -> recording.
    // The entire 2 ms tap fits before the first sim step at 144/240 Hz. The
    // former per-frame drain discarded it on the first zero-step frame.
    for (const hz of [30, 60, 144, 240]) {
      clock = 2000;
      input.attach(field as unknown as HTMLElement);
      const live = new SimWorld();
      live.start({ mode: "endless", seed: "short-tap-regression" });
      const events = [
        { at: 1, down: true }, { at: 3, down: false },
        // Also exercise the remainder of a frame that already ran a tick.
        { at: 21, down: true }, { at: 24, down: false },
      ];
      let event = 0;
      let previous = 0;
      while (previous < 100) {
        const end = Math.min(100, previous + 1000 / hz);
        while (event < events.length && events[event].at <= end) {
          const change = events[event++];
          clock = 2000 + change.at;
          key("KeyD", change.down);
        }
        clock = 2000 + end;
        input.poll();
        live.update((end - previous) / 1000, input.state);
        previous = end;
      }
      assert.ok(live.x > 0, `${hz} Hz must move the craft for an intra-frame tap`);
      const recording = live.getRecording();
      assert.ok(recording, `${hz} Hz must record the consumed input`);
      let recordedHoldTime = 0;
      for (let i = 0; i < recording.data.length; i += 2) {
        recordedHoldTime += unpackAxis(recording.data[i]) * recording.data[i + 1] * FIXED_DT;
      }
      // Frame averages can distribute the tap across different ticks; its
      // steering area must survive, within the existing axis quantization.
      assert.ok(
        Math.abs(recordedHoldTime - 0.005) <= 2 * FIXED_DT / AXIS_LEVELS,
        `${hz} Hz must preserve both taps' 5 ms total (recorded ${recordedHoldTime * 1000} ms)`,
      );
      const replayed = resimulate(recording, new SimWorld());
      assert.equal(replayed.x, live.x, `${hz} Hz buffered inputs must replay exactly`);
      assert.equal(replayed.latVel, live.latVel);
      assert.deepEqual(replayed.stats, live.stats);
      input.dispose();
    }
    const restarting = new SimWorld();
    const config = { mode: "endless" as const, seed: "pending-input-reset" };
    restarting.start(config);
    restarting.update(FIXED_DT / 2, { ...neutral, axis: 1 });
    restarting.start(config);
    restarting.update(FIXED_DT, neutral);
    assert.equal(restarting.x, 0, "restarting clears an unfinished tick's steering");
    console.log("fixed-step input gate: PASS (30/60/144/240 Hz taps, conserved steering, exact replay)");
  } finally {
    input.dispose();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log("input lifecycle gate: PASS (dispose, reattach, blur, UI pointer isolation)");
}
