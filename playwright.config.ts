import { defineConfig } from "@playwright/test";

const port = 3100;
const deviceScaleFactor = Number(process.env.BROWSER_DPR ?? "1");
if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
  throw new Error("BROWSER_DPR must be a positive number");
}
const resultDirectory = deviceScaleFactor === 1 ? "test-results" : `test-results/dpr-${deviceScaleFactor}`;
const reportDirectory = deviceScaleFactor === 1 ? "playwright-report" : `playwright-report/dpr-${deviceScaleFactor}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  outputDir: resultDirectory,
  // GPU-heavy pages contend with one another and distort the smoke results.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: reportDirectory }],
    ["json", { outputFile: `${resultDirectory}/results.json` }],
  ],
  use: {
    browserName: "chromium",
    channel: "chromium",
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor,
    reducedMotion: "reduce",
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--enable-unsafe-webgpu"],
    },
  },
  projects: [{ name: "webgpu" }, { name: "webgl2" }],
  webServer: {
    // test:browser builds first. Never reuse an unrelated dev server or stale
    // process: these tests exercise the production bundle on an isolated port.
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
