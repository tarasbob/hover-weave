/** Sustained production-browser capture. Native clocks; no CPU/GPU emulation by default. */
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ProfileOptions } from "../src/game/profiling/runtime";

const { values } = parseArgs({ options: {
  url: { type: "string" }, cdp: { type: "string" }, output: { type: "string", default: "test-results/profile.json" },
  seconds: { type: "string", default: "120" }, warmup: { type: "string", default: "10" },
  backend: { type: "string", default: "webgpu" }, quality: { type: "string", default: "high" },
  dpr: { type: "string", default: "1" }, width: { type: "string", default: "1440" }, height: { type: "string", default: "900" },
  label: { type: "string", default: "Local browser; hardware not externally verified" }, headed: { type: "boolean", default: false },
} });
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const dpr = Number(values.dpr);
const width = Number(values.width);
const height = Number(values.height);
if (!Number.isFinite(seconds) || seconds < 60 || seconds > 900) throw new Error("--seconds must be between 60 and 900");
if (!Number.isFinite(warmup) || warmup < 0 || warmup > 60) throw new Error("--warmup must be between 0 and 60");
if (![dpr, width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error("Viewport and DPR must be positive");
if (!["webgpu", "webgl2"].includes(values.backend!)) throw new Error("--backend must be webgpu or webgl2");
if (!["auto", "low", "medium", "high"].includes(values.quality!)) throw new Error("Unknown quality preset");
if (values.cdp && !values.url) throw new Error("A physical device needs --url pointing to the reachable production server");

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
const base = values.url ?? "http://127.0.0.1:3110";
const errors: string[] = [];
const notices: string[] = [];
let interrupted = false;
const onInterrupt = () => { interrupted = true; };
process.once("SIGINT", onInterrupt);

async function main() {
  if (!values.url) {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3110"], { stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", (data: Buffer) => { if (notices.length < 100) notices.push(data.toString()); });
    server.stderr?.on("data", (data: Buffer) => { if (notices.length < 100) notices.push(data.toString()); });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Production server exited: ${notices.join("\n")}`);
      try { if ((await fetch(base)).ok) break; } catch { /* Wait for this process's startup. */ }
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!(await fetch(base)).ok) throw new Error("Production server did not start; build first");
  }
  browser = values.cdp ? await chromium.connectOverCDP(values.cdp) : await chromium.launch({
    channel: "chromium", headless: !values.headed, args: ["--enable-unsafe-webgpu"],
  });
  context = values.cdp ? browser.contexts()[0] : await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dpr,
  });
  if (!context) throw new Error("The connected device did not expose a browser context");
  const page = await context.newPage();
  try {
    page.on("pageerror", (error) => { if (errors.length < 100) errors.push(error.message); });
    page.on("console", (message) => {
      if (message.type() === "error" && /three|webgpu|webgl|shader|pipeline|validation/i.test(message.text()) && errors.length < 100) errors.push(message.text());
    });
    const url = new URL(base);
    url.searchParams.set("profile", "1");
    if (values.backend === "webgl2") url.searchParams.set("gl", "webgl");
    await page.goto(url.toString());
    await page.waitForFunction(() => Boolean(window.__HOVER_PROFILE__), undefined, { timeout: 45_000 });
    await page.locator(`[data-renderer-backend="${values.backend}"]`).waitFor({ timeout: 45_000 });
    const clocks = await page.evaluate(() => ({
      animationFrames: requestAnimationFrame.toString().includes("[native code]"),
      performanceClock: performance.now.toString().includes("[native code]"),
      eventTimestamps: Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")?.get?.toString().includes("[native code]"),
    }));
    if (!Object.values(clocks).every(Boolean)) throw new Error("The benchmark requires native animation, performance and input clocks");
    const options: ProfileOptions = { kind: "benchmark", seconds, warmupSeconds: warmup, quality: values.quality as ProfileOptions["quality"], label: values.label };
    await page.evaluate((options) => window.__HOVER_PROFILE__!.start(options), options);
    console.log(`Capturing ${seconds}s + ${warmup}s warmup: ${values.backend}/${values.quality}; ${values.cdp ? "connected device viewport" : `${width}×${height} DPR${dpr}`}`);
    const deadline = Date.now() + (seconds + warmup + 180) * 1000;
    let lastLog = 0;
    let automaticResumes = 0;
    while (Date.now() < deadline && !interrupted) {
      await page.waitForTimeout(1000);
      const snapshot = await page.evaluate(() => ({ report: window.__HOVER_PROFILE__!.snapshot(), phase: document.querySelector("[data-game-phase]")?.getAttribute("data-game-phase") }));
      if (!snapshot.report) throw new Error("Capture vanished");
      if (snapshot.report.status !== "running") break;
      if (snapshot.phase === "paused") {
        automaticResumes++;
        // Preserve and report real stall pauses; do not change animation clocks
        // or hide their effect in the measured frame-tail distribution.
        await page.evaluate(() => { window.__HOVER_PROFILE__!.note("Runner resumed an automatic/focus pause; inspect frame tails and elapsed versus active time."); window.__HOVER_PROFILE__!.resume(); });
      }
      if (snapshot.report.measuredSeconds >= lastLog + 15) { lastLog = snapshot.report.measuredSeconds; console.log(`${lastLog.toFixed(0)}s measured; ${snapshot.report.coverage.maxDistance.toFixed(0)}m; ${snapshot.report.coverage.biomes.length} biomes`); }
    }
    const report = await page.evaluate(() => {
      const current = window.__HOVER_PROFILE__!.snapshot();
      return current?.status === "running" ? window.__HOVER_PROFILE__!.stop() : current;
    });
    const result = { runner: { kind: values.cdp ? "connected-browser" : "local-chromium", browserVersion: browser.version(),
      nativeClocks: clocks, automaticResumes, viewportEmulated: !values.cdp, cpuThrottleRate: 1,
      externalHardwareValidation: "Operator must identify real hardware. Connected-browser alone does not prove a physical phone.",
      interrupted, errors, serverNotices: notices }, report };
    const path = resolve(values.output!);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2));
    console.log(`Saved ${path}`);
    if (!report || report.stopReason !== "duration complete" || report.measuredSeconds < seconds || report.route?.failure || errors.length || report.coverage.biomes.length < 2) {
      process.exitCode = 1;
      console.error("Capture incomplete or failed coverage/runtime checks; inspect the saved report.");
    } else console.log(`Measured frame P95 ${report.measurements.frame.p95Ms}ms; GPU mean ${report.measurements.gpu.meanMs ?? "unavailable"}ms; ${automaticResumes} pause resumes.`);
  } finally { await page.close(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  process.removeListener("SIGINT", onInterrupt);
  if (!values.cdp) await context?.close();
  // Playwright disconnects a remotely connected browser; it owns local launches.
  await browser?.close();
  server?.kill("SIGTERM");
});
