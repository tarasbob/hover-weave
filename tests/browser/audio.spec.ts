import { expect, test, type Page } from "@playwright/test";

type AudioAuditWindow = Window & { __audioContexts: AudioContext[] };

async function readAudio(page: Page) {
  return page.evaluate(() => {
    const contexts = (window as unknown as AudioAuditWindow).__audioContexts;
    // Tone also creates temporary feature-detection contexts, which it closes.
    const live = contexts.filter((context) => context.state !== "closed");
    return live.map((context) => ({ state: context.state, time: context.currentTime }));
  });
}

test("audio sleeps while idle and unfocused, and resumes on user interaction", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    (window as unknown as AudioAuditWindow).__audioContexts = contexts;
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    };
    localStorage.setItem("cubefield:settings", JSON.stringify({
      state: { quality: "low" }, version: 0,
    }));
  });
  await page.goto(testInfo.project.name === "webgl2" ? "/?gl=webgl" : "/");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  const deck = page.getByRole("region", { name: "Flight deck" });
  const game = page.locator("[data-game-phase]");
  await expect(deck).toBeVisible();
  await expect(game).toHaveAttribute("data-renderer-backend", testInfo.project.name, { timeout: 45_000 });

  // Unlock the real audio graph without launching a simulation.
  await deck.getByRole("button", { name: "How to fly", exact: true }).click();
  await expect.poll(async () => (await readAudio(page)).some((audio) => audio.state === "running")).toBe(true);
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state), {
    message: "Idle audio contexts suspend after effect tails finish", timeout: 12_000,
  }).toEqual(["suspended"]);
  const asleep = await readAudio(page);
  await page.waitForTimeout(200);
  expect(await readAudio(page), "Suspended audio consumes no audio rendering time").toEqual(asleep);

  await page.getByRole("button", { name: "Close HOW TO FLY", exact: true }).click();
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state)).toEqual(["running"]);
  await deck.getByRole("button", { name: "Begin first flight", exact: true }).click();
  await expect(deck.getByRole("button", { name: "Begin first flight", exact: true })).toBeHidden();
  // A shader-startup stall is also allowed to pause the initial flight.
  if (await game.getAttribute("data-game-phase") === "running") {
    await page.getByRole("button", { name: "Pause flight", exact: true }).click();
  }
  await expect(game).toHaveAttribute("data-game-phase", "paused");
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state), {
    message: "Paused flights stop their audio graph", timeout: 12_000,
  }).toEqual(["suspended"]);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state)).toEqual(["running"]);

  const otherTab = await context.newPage();
  await otherTab.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await testInfo.attach("background-page-state", {
    body: JSON.stringify(await page.evaluate(() => ({
      focused: document.hasFocus(), hidden: document.hidden, visibility: document.visibilityState,
    }))),
    contentType: "application/json",
  });
  await expect(game).toHaveAttribute("data-game-phase", "paused");
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state), {
    message: "Losing focus suspends audio without waiting for the idle tail", timeout: 2_000,
  }).toEqual(["suspended"]);
  await otherTab.close();
  await page.bringToFront();
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state)).toEqual(["suspended"]);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state)).toEqual(["running"]);

  // Headless Chrome may keep a blurred page visible. Exercise the separate
  // visibility handler explicitly; AudioContext and browser clocks stay native.
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(game).toHaveAttribute("data-game-phase", "paused");
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state), {
    message: "A simulated hidden visibility event immediately suspends native audio", timeout: 2_000,
  }).toEqual(["suspended"]);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(game).toHaveAttribute("data-game-phase", "paused");
  expect((await readAudio(page)).map((audio) => audio.state)).toEqual(["suspended"]);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect.poll(async () => (await readAudio(page)).map((audio) => audio.state)).toEqual(["running"]);
  expect(errors, "Audio lifecycle produces no uncaught errors").toEqual([]);
});
