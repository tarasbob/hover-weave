import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

test("a recorded pilot actively follows the strong bends on a phone viewport", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if ((message.type() === "error" && /three|webgpu|webgl|shader|pipeline|validation/i.test(text)) ||
      /GPUValidationError|GL_INVALID_|GL_OUT_OF_MEMORY|framebuffer is incomplete/i.test(text)) errors.push(text);
  });
  await page.goto(`/?profile=1${info.project.name === "webgl2" ? "&gl=webgl" : ""}`);
  await page.waitForFunction(() => Boolean(window.__HOVER_PROFILE__));
  await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-renderer-backend", info.project.name,
    { timeout: 45_000 });
  await page.evaluate(() => window.__HOVER_PROFILE__!.start({ seconds: 60, warmupSeconds: 0, quality: "low" }));
  // Replay ordinary inputs with collisions enabled and a real browser clock.
  // The sampled apices cover both a long sweep and its countersteer entry.
  for (const distance of [650, 1050]) {
    await expect.poll(async () => {
      if (await page.locator("[data-game-phase]").getAttribute("data-game-phase") === "paused") {
        await page.evaluate(() => window.__HOVER_PROFILE__!.resume());
      }
      return Number(await page.getByLabel("Distance traveled").getAttribute("data-distance"));
    }, { timeout: 35_000 }).toBeGreaterThanOrEqual(distance);
    await expect(page.locator("[data-game-phase]")).toHaveAttribute("data-game-phase", "running");
    await expect(page.getByRole("button", { name: "Hold to boost", exact: true })).toBeVisible();
    await info.attach(`phone-bend-${distance}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  const report = await page.evaluate(() => window.__HOVER_PROFILE__!.stop());
  expect(report?.route?.simulatedSteps).toBeGreaterThan(2000);
  expect(errors, "No browser or renderer errors while following the bends").toEqual([]);
});
