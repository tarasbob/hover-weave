import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

const deck = (page: Page) => page.getByRole("region", { name: "Flight deck" });
const game = (page: Page) => page.locator("[data-game-phase]");
const runtimeErrors = new WeakMap<Page, Set<string>>();

test.beforeEach(async ({ page }) => {
  const errors = new Set<string>();
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.add(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if ((message.type() === "error" && /three|webgpu|webgl|shader|pipeline|validation/i.test(text)) ||
        /GPUValidationError|GL_INVALID_|GL_OUT_OF_MEMORY|framebuffer is incomplete/i.test(text)) errors.add(text);
  });
});

test.afterEach(async ({ page }) => {
  expect([...runtimeErrors.get(page) ?? []], "No uncaught errors or renderer validation failures").toEqual([]);
});

async function openGame(page: Page, webgl: boolean) {
  await page.goto(webgl ? "/?gl=webgl" : "/");
  await expect(deck(page)).toBeVisible();
  await expect(game(page)).toHaveAttribute("data-renderer-backend", webgl ? "webgl2" : "webgpu", { timeout: 45_000 });
}

async function sensorMock(page: Page, permission: "granted" | "denied") {
  await page.addInitScript((answer) => {
    // Synthetic readings are the test's sensor source; the host laptop may
    // separately emit a trusted null reading because it has no phone sensor.
    window.addEventListener("deviceorientation", (event) => {
      if (event.isTrusted) event.stopImmediatePropagation();
    }, true);
    Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
      configurable: true, value: async () => answer,
    });
    Object.defineProperty(screen.orientation, "angle", { configurable: true, get: () => 90 });
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => false });
    Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => false });
  }, permission);
}

async function wheel(page: Page, angle: number) {
  await page.evaluate((roll) => {
    const rad = Math.PI / 180;
    const pitch = 55 * rad;
    const screenX = -Math.sin(roll * rad) * Math.sin(pitch);
    const screenY = Math.cos(roll * rad) * Math.sin(pitch);
    const angle = screen.orientation.angle * rad;
    const upX = screenX * Math.cos(angle) + screenY * Math.sin(angle);
    const upY = -screenX * Math.sin(angle) + screenY * Math.cos(angle);
    const sensorWindow = window as Window & { __mobileSensorTimer?: number };
    window.clearInterval(sensorWindow.__mobileSensorTimer);
    const emit = () => window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", {
      beta: Math.asin(upY) / rad,
      gamma: Math.atan2(-upX, Math.cos(pitch)) / rad,
    }));
    emit();
    sensorWindow.__mobileSensorTimer = window.setInterval(emit, 50);
  }, angle);
}

test("portrait mobile menu keeps setup reachable and explains Home Screen full screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sensorMock(page, "denied");
  await openGame(page, testInfo.project.name === "webgl2");
  await expect(page.getByText("ROTATE YOUR DEVICE", { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("mobile-portrait.png") });
  await deck(page).getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(deck(page).getByText("Full screen on iPhone", { exact: true })).toBeVisible();
  await expect(deck(page).getByText("Add to Home Screen", { exact: true })).toBeVisible();
  await expect(deck(page).getByText("Open as Web App", { exact: true })).toBeVisible();
  await deck(page).getByRole("button", { name: "Enable tilt steering", exact: true }).click();
  await expect(deck(page).getByText(/Motion access wasn’t allowed/)).toBeVisible();
  await expect(deck(page).getByRole("button", { name: "Begin first flight" })).toBeEnabled();
  await deck(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Enable tilt steering", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close SETTINGS" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await deck(page).getByRole("button", { name: "Begin first flight", exact: true }).click();
  await expect(page.getByText("ROTATE YOUR DEVICE", { exact: true })).toBeVisible();
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  await page.getByRole("button", { name: "Back to menu", exact: true }).click();
  await expect(deck(page)).toBeVisible();
});

test("tilt permission, proportional wheel preview and recenter work on both landscape sides", async ({ page }, testInfo) => {
  await sensorMock(page, "granted");
  await openGame(page, testInfo.project.name === "webgl2");
  await deck(page).getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "SETTINGS", exact: true });
  await settings.getByRole("button", { name: "Enable tilt steering", exact: true }).click();
  await wheel(page, 0);
  await expect(settings.getByRole("button", { name: "Tilt steering on", exact: true })).toHaveAttribute("aria-pressed", "true");
  const meter = settings.locator(".mobile-steering-meter > span");
  await wheel(page, 12);
  await expect.poll(async () => meter.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeGreaterThan(5);
  const gentle = await meter.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41);
  await wheel(page, 28);
  await expect.poll(async () => meter.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeGreaterThan(gentle + 10);
  await settings.getByRole("button", { name: "Center steering", exact: true }).click();
  await expect(settings.getByText(/This hold position now steers straight/)).toBeVisible();
  await expect.poll(async () => meter.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeLessThan(1);
  await page.evaluate(() => {
    // Stop samples encoded for the previous screen angle before rotating.
    // Otherwise an interval tick between these evaluate calls can establish
    // the new neutral position from an old, now-inverted sensor reading.
    window.clearInterval((window as Window & { __mobileSensorTimer?: number }).__mobileSensorTimer);
    Object.defineProperty(screen.orientation, "angle", { configurable: true, get: () => 270 });
    window.dispatchEvent(new Event("orientationchange"));
  });
  await wheel(page, 0);
  await wheel(page, -20);
  await expect.poll(async () => meter.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).m41)).toBeLessThan(-5);
  const sensitivity = settings.getByRole("slider", { name: "Tilt angle for full steering" });
  await sensitivity.press("Home");
  for (let i = 0; i < 5; i++) await sensitivity.press("ArrowRight");
  await expect(settings.getByText("Full steering at 20°")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-landscape-tilt.png") });
  await settings.getByRole("button", { name: "Tilt steering on", exact: true }).click();
  await expect(settings.getByText(/Hold either half of the track/)).toBeVisible();
  await settings.getByRole("button", { name: "Close SETTINGS" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("touch flight has reachable boost and pause, and portrait rotation pauses safely", async ({ page }, testInfo) => {
  await sensorMock(page, "denied");
  await openGame(page, testInfo.project.name === "webgl2");
  await deck(page).getByRole("button", { name: "Begin first flight", exact: true }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "running");
  const boost = page.getByRole("button", { name: "Hold to boost", exact: true });
  await expect(boost).toBeVisible();
  const boostBox = await boost.boundingBox();
  expect(boostBox!.width).toBeGreaterThanOrEqual(44);
  expect(boostBox!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Pause flight", exact: true }).click();
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  const pause = page.getByRole("dialog", { name: "PAUSED", exact: true });
  await expect(pause.getByRole("button", { name: "Full screen", exact: true })).toBeVisible();
  await pause.getByRole("button", { name: "RESUME", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("ROTATE YOUR DEVICE", { exact: true })).toBeVisible();
  await expect(game(page)).toHaveAttribute("data-game-phase", "paused");
  await page.getByRole("button", { name: "Back to menu", exact: true }).click();
  await expect(deck(page)).toBeVisible();
  await expect(page.getByText("ROTATE YOUR DEVICE", { exact: true })).toBeHidden();
});
