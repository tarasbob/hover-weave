import { expect, test as base, type Page } from "@playwright/test";

const game = (page: Page) => page.locator("[data-game-phase]");
const flightDeck = (page: Page) => page.getByRole("region", { name: "Flight deck" });

interface RenderSample {
  renderedFrames: number;
  frameSamples: number;
  drawCalls: number;
  textures: number;
  frameMs: number;
  frameP95Ms: number;
  frameP99Ms: number;
  gpuMs: number | null;
  gpuStatus: string;
  gpuPasses: { name: string; gpuMs: number; passes: number }[];
  gpuPassCoverage: "individual" | "aggregate" | "none";
  gpuSubmittedPasses: string[];
}

async function readPerformance(page: Page): Promise<RenderSample | null> {
  const value = await page.locator("[data-performance]").getAttribute("data-performance");
  return value ? JSON.parse(value) as RenderSample : null;
}

const test = base.extend<{ runtimeErrors: void }>({
  runtimeErrors: [async ({ page }, use, testInfo) => {
    const errors = new Set<string>();
    const diagnostics = new Map<string, number>();
    page.on("pageerror", (error) => errors.add(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      const text = message.text();
      const diagnostic = `[${message.type()}] ${text}`;
      diagnostics.set(diagnostic, (diagnostics.get(diagnostic) ?? 0) + 1);
      // Shader validation can be reported to the console without throwing.
      if ((message.type() === "error" && /three|webgpu|webgl|shader|pipeline|validation/i.test(text)) ||
          /GPUValidationError|GL_INVALID_|GL_OUT_OF_MEMORY|framebuffer is incomplete/i.test(text)) {
        errors.add(text);
      }
    });
    await use();
    const performance = await page.locator("[data-performance]").getAttribute("data-performance", { timeout: 1_000 }).catch(() => null);
    if (performance) {
      await testInfo.attach("render-performance", {
        body: JSON.stringify(JSON.parse(performance), null, 2),
        contentType: "application/json",
      });
    }
    if (diagnostics.size || errors.size) {
      await testInfo.attach("browser-diagnostics", {
        body: [
          ...Array.from(errors, (error) => `[runtime] ${error}`),
          ...Array.from(diagnostics, ([message, count]) => `[${count} occurrences] ${message}`),
        ].join("\n"),
        contentType: "text/plain",
      });
    }
    expect([...errors], "No uncaught errors or renderer validation failures").toEqual([]);
  }, { auto: true }],
});

test.beforeEach(async ({ page }, testInfo) => {
  // Fix only wall-clock date: daily/weekly identity is deterministic while
  // requestAnimationFrame, performance.now(), physics, and real input still run.
  // Playwright's clock API also installs a synthetic RAF/performance clock.
  // A Date-only proxy preserves native GPU, CPU, and input timing measurements.
  await page.addInitScript(() => {
    const NativeDate = Date;
    const epoch = NativeDate.parse("2026-09-05T12:00:00Z");
    globalThis.Date = new Proxy(NativeDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, args.length ? args : [epoch], newTarget);
      },
      apply() { return new NativeDate(epoch).toString(); },
      get(target, property, receiver) {
        return property === "now" ? () => epoch : Reflect.get(target, property, receiver);
      },
    });
  });
  await page.goto(testInfo.project.name === "webgl2" ? "/?gl=webgl" : "/");
  expect(await page.evaluate(() => ({
    animationFrames: requestAnimationFrame.toString().includes("[native code]"),
    performanceClock: performance.now.toString().includes("[native code]"),
    eventTimestamps: Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")?.get?.toString().includes("[native code]"),
  })), "Performance and input samples must use native browser clocks").toEqual({
    animationFrames: true, performanceClock: true, eventTimestamps: true,
  });
  await expect(flightDeck(page)).toBeVisible();
  await expect(game(page)).toHaveAttribute("data-renderer-backend", /^(webgpu|webgl2)$/, {
    timeout: 45_000,
  });
  const backend = await game(page).getAttribute("data-renderer-backend");
  expect(
    backend,
    testInfo.project.name === "webgpu"
      ? "WebGPU is required for this project. A WebGL fallback is not a WebGPU pass; use a WebGPU-capable machine or run only --project=webgl2."
      : "?gl=webgl must select the real WebGL2 renderer even when WebGPU is available.",
  ).toBe(testInfo.project.name);
  await expect(page.locator("canvas")).toBeVisible();
  await flightDeck(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
  await settings.getByRole("switch", { name: "Show FPS", exact: true }).click();
  await settings.getByRole("button", { name: "Close SETTINGS", exact: true }).click();
  await expect(settings).toBeHidden();
});

async function exploreModes(page: Page) {
  await flightDeck(page).getByRole("button", { name: "Explore all flight modes" }).click();
  await expect(page.getByRole("group", { name: "Choose a flight mode" })).toBeVisible();
}

async function launch(page: Page, mode: "endless" | "daily" | "sprint") {
  await flightDeck(page).getByRole("button", { name: "Launch flight", exact: true }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  await expect(game(page)).toHaveAttribute("data-game-mode", mode);
  await expect(page.getByRole("button", { name: "Pause flight", exact: true })).toBeVisible();
  await expectRenderedFrames(page);
  await expect(flightDeck(page)).toBeHidden();
}

async function expectRenderedFrames(page: Page) {
  await expect.poll(async () => {
    const sample = await readPerformance(page);
    return sample !== null && sample.renderedFrames > 0 && sample.frameSamples > 0 && sample.drawCalls > 0;
  }, { message: "The scene submits real rendered frames and nonzero draw calls" }).toBe(true);
}

test("a clean install launches the first flight with one steering lesson", async ({ page }, testInfo) => {
  await expect(flightDeck(page).getByRole("button", { name: "Begin first flight" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Choose a flight mode" })).toHaveCount(0);
  await flightDeck(page).getByRole("button", { name: "Begin first flight" }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  await expect(game(page)).toHaveAttribute("data-game-mode", "endless");
  await expect(page.getByRole("status").filter({ hasText: "HOLD ← / → OR A / D" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause flight", exact: true })).toBeVisible();
  await expectRenderedFrames(page);
  await expect(flightDeck(page)).toBeHidden();
  await testInfo.attach("first-flight", { body: await page.screenshot(), contentType: "image/png" });
});

test("each selected mode survives a settings round trip and launches correctly", async ({ page }) => {
  await exploreModes(page);
  for (const mode of [
    { id: "endless", label: /Free flight/ },
    { id: "daily", label: /Daily course/ },
    { id: "sprint", label: /Sprint/ },
  ] as const) {
    const selected = page.getByRole("group", { name: "Choose a flight mode" })
      .getByRole("button", { name: mode.label });
    await selected.click();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await flightDeck(page).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("switch", { name: "Reduce motion", exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Close SETTINGS", exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await launch(page, mode.id);
    if (mode.id === "sprint") {
      await expect(page.getByRole("timer", { name: "Sprint time remaining" })).toBeVisible();
    }
    await page.getByRole("button", { name: "Pause flight", exact: true }).click();
    await page.getByRole("dialog", { name: "PAUSED", exact: true })
      .getByRole("button", { name: "ABANDON RUN", exact: true }).click();
    await expect(flightDeck(page)).toBeVisible();
  }
});

test("pause freezes the run, settings keep it paused, and changing tabs pauses again", async ({ page, context }) => {
  // Playwright otherwise forces every page to stay focused, even when a real
  // tab change occurs. Disable that harness override for this lifecycle test.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await exploreModes(page);
  await page.getByRole("group", { name: "Choose a flight mode" })
    .getByRole("button", { name: /Sprint/ }).click();
  await launch(page, "sprint");
  const timer = page.getByRole("timer", { name: "Sprint time remaining" });
  await page.keyboard.press("Escape");
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  const pausedTime = await timer.innerText();
  // Deliberate observation window: the displayed timer must remain frozen
  // for longer than one second, not merely for two adjacent DOM reads.
  await page.waitForTimeout(1_250);
  await expect(timer).toHaveText(pausedTime);
  await page.getByRole("dialog", { name: "PAUSED", exact: true })
    .getByRole("button", { name: "SETTINGS", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "SETTINGS", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const pause = page.getByRole("dialog", { name: "PAUSED", exact: true });
  await expect(pause).toBeVisible();
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  await pause.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  await expect(timer).not.toHaveText(pausedTime);

  // Use a real foreground-tab change, with a control held. No synthetic blur
  // event or development-only access to the input manager is involved.
  await page.keyboard.down("ArrowLeft");
  const otherTab = await context.newPage();
  await otherTab.bringToFront();
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  await otherTab.close();
  await page.bringToFront();
  await page.keyboard.up("ArrowLeft");
  await expect(pause).toBeVisible();
  await pause.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
});

test("a real collision produces a flight report and retry starts the daily course", async ({ page }, testInfo) => {
  await flightDeck(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
  await settings.getByRole("button", { name: "HIGH", exact: true }).click();
  await settings.getByRole("button", { name: "Close SETTINGS", exact: true }).click();
  await exploreModes(page);
  await page.getByRole("group", { name: "Choose a flight mode" })
    .getByRole("button", { name: /Daily course/ }).click();
  await launch(page, "daily");
  // Let the production loop, collision code, and result events run. The
  // report must leave enough time for the visible ship breakup first.
  await expect.poll(async () => Number(await page.getByLabel("Distance traveled").getAttribute("data-distance")),
    { timeout: 30_000 }).toBeGreaterThanOrEqual(500);
  await testInfo.attach("curved-track", { body: await page.screenshot(), contentType: "image/png" });
  const report = page.getByRole("dialog", { name: "SIGNAL LOST", exact: true });
  await expect(game(page)).toHaveAttribute("data-game-phase", "crashing", { timeout: 60_000 });
  await expect(report).toBeHidden();
  const crashObservedAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1_200);
  await expect(game(page)).toHaveAttribute("data-game-phase", "crashing");
  await expect(report).toBeHidden();
  await expect(page.getByText("NEW COSMETIC UNLOCKED", { exact: true })).toBeHidden();
  await testInfo.attach("ship-breakup", { body: await page.screenshot(), contentType: "image/png" });
  await expect(report).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => performance.now()) - crashObservedAt,
    "The crash presentation precedes the results dialog by a few seconds").toBeGreaterThan(2_500);
  await expect(game(page)).toHaveAttribute("data-game-phase", "dead");
  await expect(report).toContainText("FLIGHT REPORT / DAILY");
  if ((await readPerformance(page))?.gpuStatus !== "unsupported") {
    await expect.poll(async () => (await readPerformance(page))?.gpuSubmittedPasses.some((name) => /DoF/i.test(name)), {
      message: "The High-quality crash retains the depth-of-field rendering passes",
    }).toBe(true);
    await testInfo.attach("crash-gpu-passes", {
      body: JSON.stringify(await readPerformance(page), null, 2), contentType: "application/json",
    });
  }
  await testInfo.attach("flight-report", { body: await page.screenshot(), contentType: "image/png" });
  await report.getByRole("button", { name: "RETRY COURSE", exact: true }).click();
  await expect(report).toBeHidden();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  await expect(game(page)).toHaveAttribute("data-game-mode", "daily");
  await expect(page.getByRole("button", { name: "Pause flight", exact: true })).toBeVisible();
  if ((await readPerformance(page))?.gpuStatus !== "unsupported") {
    await expect.poll(async () => {
      const sample = await readPerformance(page);
      return sample?.gpuStatus === "available" && sample.gpuPasses.length > 0 &&
        !sample.gpuSubmittedPasses.some((name) => /DoF/i.test(name));
    }, { message: "Retry deactivates the crash blur passes without rebuilding the pipeline" }).toBe(true);
  }
});

test("leaving either track edge crashes instead of clamping the ship", async ({ page }, testInfo) => {
  await exploreModes(page);
  await page.getByRole("group", { name: "Choose a flight mode" })
    .getByRole("button", { name: /Daily course/ }).click();
  await launch(page, "daily");
  const report = page.getByRole("dialog", { name: "SIGNAL LOST", exact: true });
  for (const key of ["ArrowLeft", "ArrowRight"]) {
    // Clear the opening's roadside pillar before the committed edge exit.
    // Read the actual flight distance so display refresh cannot shift the line.
    await expect.poll(async () => Number(await page.getByLabel("Distance traveled").getAttribute("data-distance")),
      { intervals: [30], timeout: 10_000 }).toBeGreaterThanOrEqual(110);
    await page.keyboard.down(key);
    await expect(game(page)).toHaveAttribute("data-game-phase", "crashing", { timeout: 12_000 });
    await page.keyboard.up(key);
    await expect(report).toBeHidden();
    // Restart shortcuts cannot skip the crash or accidentally launch a run
    // while the player is still reacting to the impact.
    await page.keyboard.press("Enter");
    await expect(game(page)).toHaveAttribute("data-game-phase", "crashing");
    await page.waitForTimeout(750);
    await testInfo.attach(`edge-breakup-${key}`, { body: await page.screenshot(), contentType: "image/png" });
    await expect(report).toBeVisible();
    await expect(report).toContainText(/track edge|left edge|right edge|off track/i);
    await report.getByRole("button", { name: "RETRY COURSE", exact: true }).click();
    await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  }
});

test("low and high quality survive repeated changes with bounded render resources", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const hardware = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter(options: { powerPreference: "high-performance" }): Promise<{ info?: {
        vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean;
      } } | null> };
    }).gpu;
    const adapter = await gpu?.requestAdapter({ powerPreference: "high-performance" });
    const info = adapter?.info;
    const probe = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
    const debug = probe?.getExtension("WEBGL_debug_renderer_info");
    const webglRenderer: string | null = debug ? probe!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      webgpuAdapter: info ? {
        vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, isFallbackAdapter: info.isFallbackAdapter,
      } : null,
      webglRenderer,
    };
  });
  await testInfo.attach("browser-hardware", {
    body: JSON.stringify({ backend: testInfo.project.name, ...hardware }, null, 2), contentType: "application/json",
  });
  await exploreModes(page);
  await page.getByRole("group", { name: "Choose a flight mode" })
    .getByRole("button", { name: /Daily course/ }).click();
  await launch(page, "daily");
  const samples: { quality: string; sample: RenderSample }[] = [];
  for (const quality of ["LOW", "HIGH", "LOW", "HIGH", "LOW"]) {
    await page.getByRole("button", { name: "Pause flight", exact: true }).click();
    const pause = page.getByRole("dialog", { name: "PAUSED", exact: true });
    await pause.getByRole("button", { name: "SETTINGS", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
    await settings.getByRole("button", { name: quality, exact: true }).click();
    await expect(settings.getByRole("button", { name: quality, exact: true })).toHaveAttribute("aria-pressed", "true");
    await settings.getByRole("button", { name: "Close SETTINGS", exact: true }).click();
    const previousFrames = (await readPerformance(page))?.renderedFrames ?? 0;
    await pause.getByRole("button", { name: "RESTART RUN", exact: true }).click();
    await expect(game(page)).toHaveAttribute("data-game-phase", "running");
    // Each restart follows a pause, which clears the active-frame window.
    // Collect actual gameplay frames; viewport size is not device emulation.
    await expect.poll(async () => {
      const sample = await readPerformance(page);
      return sample !== null && sample.renderedFrames >= previousFrames + 120 && sample.frameSamples >= 120;
    }, {
      message: `${quality} quality produces 120 measured gameplay frames`, timeout: 30_000,
    }).toBe(true);
    const sample = (await readPerformance(page))!;
    expect(sample.drawCalls).toBeGreaterThan(0);
    expect(sample.frameMs).toBeGreaterThan(0);
    expect(sample.frameP99Ms).toBeGreaterThanOrEqual(sample.frameP95Ms);
    if (sample.gpuStatus === "available") {
      expect(sample.gpuMs).toBeGreaterThan(0);
      expect(sample.gpuPasses.length).toBeGreaterThan(0);
      const passTotal = sample.gpuPasses.reduce((sum, pass) => sum + pass.gpuMs, 0);
      expect(passTotal).toBeCloseTo(sample.gpuMs!, 3);
      expect(sample.gpuSubmittedPasses.some((name) => /DoF/i.test(name)),
        "Invisible crash blur must not execute during normal flight").toBe(false);
    }
    else expect(sample.gpuMs).toBeNull();
    samples.push({ quality, sample });
    // Large screenshot readbacks can stall the main thread beyond the game's
    // deliberate auto-pause threshold. DPR1 already supplies visual evidence;
    // keep the high-DPI timing/resource probe free of that observer effect.
    if (samples.length <= 2 && hardware.viewport.devicePixelRatio === 1) {
      await testInfo.attach(`${quality.toLowerCase()}-quality`, {
        body: await page.screenshot(), contentType: "image/png",
      });
    }
  }
  await testInfo.attach("quality-performance", {
    body: JSON.stringify(samples, null, 2), contentType: "application/json",
  });
  const low = samples.filter(({ quality }) => quality === "LOW");
  // Warm both pipelines before comparing: lazy one-time textures may be
  // initialized during the first visit to high quality.
  expect(low[2].sample.textures, "Returning to low quality must release superseded render targets")
    .toBeLessThanOrEqual(low[1].sample.textures);
});
