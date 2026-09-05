import { expect, test } from "@playwright/test";

test("profiling is opt-in and benchmark capture cannot award progress or leak into human play", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if ((message.type() === "error" && /three|webgpu|webgl|shader|pipeline|validation/i.test(text)) ||
      /GPUValidationError|GL_INVALID_|GL_OUT_OF_MEMORY|framebuffer is incomplete/i.test(text)) errors.push(text);
  });
  await page.goto("/");
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "title", { timeout: 45_000 });
  expect(await page.evaluate(() => window.__HOVER_PROFILE__)).toBeUndefined();
  await page.goto(`/?profile=1${info.project.name === "webgl2" ? "&gl=webgl" : ""}`);
  await page.waitForFunction(() => Boolean(window.__HOVER_PROFILE__));
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-renderer-backend", info.project.name, { timeout: 45_000 });
  const saved = await page.evaluate(() => ({ meta: localStorage.getItem("cubefield:meta"), replays: localStorage.getItem("cubefield:replays") }));
  await page.evaluate(async () => {
    const pending = window.__HOVER_PROFILE__!.start({ seconds: 60, quality: "low" });
    window.__HOVER_PROFILE__!.stop();
    await pending;
  });
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "title");
  expect(await page.evaluate(() => window.__HOVER_PROFILE__!.snapshot())).toBeNull();
  await page.evaluate(() => window.__HOVER_PROFILE__!.start({ seconds: 60, warmupSeconds: 0, quality: "low" }));
  await expect.poll(() => page.evaluate(() => {
    // A quality change can compile long enough to trigger the normal stall
    // pause. Follow the diagnostic runner's explicit resume path; keep that
    // stall in the capture instead of altering native clocks or the safeguard.
    if (document.querySelector("[data-game-phase]")?.getAttribute("data-game-phase") === "paused") {
      window.__HOVER_PROFILE__!.note("Test resumed a shader-startup pause");
      window.__HOVER_PROFILE__!.resume();
    }
    return window.__HOVER_PROFILE__!.snapshot()?.route?.simulatedSteps ?? 0;
  })).toBeGreaterThan(120);
  expect(await page.evaluate(() => ({ meta: localStorage.getItem("cubefield:meta"), replays: localStorage.getItem("cubefield:replays") }))).toEqual(saved);
  const beforeEditing = await page.evaluate(() => {
    const report = window.__HOVER_PROFILE__!.snapshot()!;
    return { startedAt: report.startedAt, steps: report.route!.simulatedSteps };
  });
  await page.locator("[data-profile-panel] summary").click();
  const label = page.getByRole("textbox", { name: "Capture device label" });
  await label.pressSequentially("power profile room", { delay: 20 });
  await expect(label).toHaveValue("power profile room");
  const observation = page.getByRole("textbox", { name: "Playtest observation" });
  await observation.pressSequentially("proper response reported", { delay: 20 });
  await observation.press("Escape");
  await expect(observation).toHaveValue("proper response reported");
  await page.getByRole("button", { name: "Add observation", exact: true }).click();
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "running");
  const afterEditing = await page.evaluate(() => window.__HOVER_PROFILE__!.snapshot()!);
  expect(afterEditing.startedAt).toBe(beforeEditing.startedAt);
  expect(afterEditing.status).toBe("running");
  expect(afterEditing.route!.simulatedSteps).toBeGreaterThan(beforeEditing.steps);
  expect(afterEditing.playtest.counts.runStart).toBe(1);
  expect(afterEditing.playtest.notes.some((note) => note.text === "proper response reported")).toBe(true);
  const frozen = await page.evaluate(() => {
    const before = window.__HOVER_PROFILE__!.stop()!;
    window.__HOVER_PROFILE__!.setQuality("high");
    window.__HOVER_PROFILE__!.note("Observer notes after stopping must export");
    const after = window.__HOVER_PROFILE__!.snapshot()!;
    return { before: { metadata: before.metadata, route: before.route, coverage: before.coverage },
      after: { metadata: after.metadata, route: after.route, coverage: after.coverage }, notes: after.playtest.notes };
  });
  expect(frozen.before).toEqual(frozen.after);
  expect(frozen.after.route?.simulatedSteps).toBeGreaterThan(120);
  expect(frozen.notes.some((note) => note.text.includes("Observer notes after stopping must export"))).toBe(true);
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "title");
  await page.evaluate(() => window.__HOVER_PROFILE__!.start({ seconds: 60, quality: "low" }));
  await page.evaluate(() => window.__HOVER_PROFILE__!.start({ kind: "human", seconds: 60, warmupSeconds: 0 }));
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "title");
  expect(await page.evaluate(() => window.__HOVER_PROFILE__!.snapshot()?.route)).toBeNull();
  expect(await page.evaluate(() => ({ meta: localStorage.getItem("cubefield:meta"), replays: localStorage.getItem("cubefield:replays") }))).toEqual(saved);
  expect(await page.evaluate(() => window.__HOVER_PROFILE__!.snapshot()?.measurements.inputToRenderSubmission.samples)).toBe(0);
  const firstFlight = page.getByRole("button", { name: "Begin first flight", exact: true });
  await firstFlight.click();
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "running");
  // The fading flight deck retains focused controls until its exit completes.
  // Send gameplay keys only after that UI no longer owns keyboard focus.
  await expect(firstFlight).toBeHidden();
  await page.keyboard.press("ArrowRight", { delay: 150 });
  await expect.poll(() => page.evaluate(() => {
    const timings = window.__HOVER_PROFILE__!.snapshot()!.measurements;
    return timings.inputToSimulationUpperBound.samples > 0 && timings.inputToRenderSubmission.samples > 0;
  })).toBe(true);
  const report = await page.evaluate(() => window.__HOVER_PROFILE__!.stop());
  expect(report?.options.kind).toBe("human");
  expect(report!.measurements.inputToSimulationUpperBound.meanMs).toBeGreaterThanOrEqual(0);
  expect(report!.measurements.inputToRenderSubmission.meanMs).toBeGreaterThanOrEqual(0);
  expect(errors, "No uncaught or renderer validation errors during profiling").toEqual([]);
});
