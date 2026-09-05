import type { GameBundle } from "../GameController";
import type { SimWorld } from "../core/world";
import { useGame, type GraphicsStats } from "../state/game";
import { useSettings, type QualityPreset } from "../state/settings";
import { PROFILE_LIMITS, ProfileDistribution } from "./metrics";
import type { ProfileRouteDriver } from "./route";

export interface ProfileFrameInput {
  at: number;
  frameMs: number;
  cpuMs: number;
  active: boolean;
  graphics: GraphicsStats;
}

export interface ProfileOptions {
  kind?: "benchmark" | "human";
  seconds?: number;
  warmupSeconds?: number;
  quality?: QualityPreset;
  /** Operator-supplied hardware/conditions; never inferred from viewport emulation. */
  label?: string;
}

interface InputObservation { at: number; worldTime: number; type: string; simulationAt?: number; }
interface ProfileEvent { atSeconds: number; simSeconds: number; distance: number; type: string; detail?: unknown; }
interface SeriesEntry {
  atSeconds: number; simSeconds: number; distance: number; biome: number;
  activeObstacles: number; frame: ReturnType<ProfileDistribution["snapshot"]>;
  cpu: ReturnType<ProfileDistribution["snapshot"]>; graphics: GraphicsStats;
}

type Report = ReturnType<Capture["report"]>;
export interface ProfileApi {
  start(options?: ProfileOptions): Promise<void>;
  stop(): Report | null;
  snapshot(): Report | null;
  resume(): void;
  setQuality(quality: QualityPreset): void;
  note(text: string): void;
  download(): void;
}

declare global { interface Window { __HOVER_PROFILE__?: ProfileApi; } }

const controllers = new WeakMap<SimWorld, Controller>();
export const hasActiveProfile = (world: SimWorld): boolean => Boolean(controllers.get(world)?.capture?.running);
export const isBenchmarkRun = (world: SimWorld): boolean => Boolean(controllers.get(world)?.benchmark);

/** Called by normal launch/title actions so diagnostic driving cannot leak into a player run. */
export function clearProfileRoute(world: SimWorld): void {
  const controller = controllers.get(world);
  if (!controller) return;
  controller.startGeneration++;
  if (!controller.benchmark) return;
  controller.capture?.finish("interrupted by normal game action");
  controller.driver = null;
  controller.benchmark = false;
}

/** Return true only when an opted-in route owns this update. Native RAF/time remain unchanged. */
export function advanceProfile(world: SimWorld, dt: number): boolean {
  const controller = controllers.get(world);
  if (!controller?.benchmark || !controller.driver) return false;
  controller.driver.advance(dt);
  if (controller.driver.failed) controller.capture?.finish(controller.driver.failed);
  return true;
}

export function recordProfileSimulation(world: SimWorld): void {
  const capture = controllers.get(world)?.capture;
  if (capture?.running) capture.simulation(performance.now());
}

export function recordProfileFrame(world: SimWorld, input: ProfileFrameInput): void {
  controllers.get(world)?.capture?.frame(input);
}

class Capture {
  running = true;
  reason: string | null = null;
  readonly started = performance.now();
  readonly startedAt = new Date().toISOString();
  private activeMs = 0;
  private measuredMs = 0;
  private intervalMs = 0;
  private lastGpuAt: number | null = null;
  private lastWasRunning = false;
  private frameTimes = new ProfileDistribution();
  private cpuTimes = new ProfileDistribution();
  private gpuTimes = new ProfileDistribution();
  private inputSim = new ProfileDistribution();
  private inputSubmit = new ProfileDistribution();
  private intervalFrame = new ProfileDistribution();
  private intervalCpu = new ProfileDistribution();
  private passes = new Map<string, ProfileDistribution>();
  private pendingInputs: InputObservation[] = [];
  private series: SeriesEntry[] = [];
  private events: ProfileEvent[] = [];
  private counts: Record<string, number> = {};
  private notes: { atSeconds: number; text: string }[] = [];
  private biomes = new Set<number>();
  private maxActiveObstacles = 0;
  private maxDistance = 0;
  private firstChoiceSeconds: number | null = null;
  private firstSteeringSeconds: number | null = null;
  private droppedEvents = 0;
  private droppedInputs = 0;
  private suspendedFrames = 0;
  private ended: number | null = null;
  private offs: (() => void)[] = [];
  private frozenReport: ReturnType<Capture["buildReport"]> | null = null;

  constructor(readonly controller: Controller, readonly options: Required<ProfileOptions>) {
    const world = controller.bundle.world;
    const event = <K extends Parameters<typeof world.events.on>[0]>(type: K) =>
      world.events.on(type, (detail) => this.event(type, detail));
    this.offs = [event("runStart"), event("death"), event("finish"), event("nearMiss"),
      event("routeChoice"), event("biome"), event("boostStart"), event("launch"), event("land"),
      event("sectionGrade"), event("patternAhead")];
    const dropPending = () => {
      this.droppedInputs += this.pendingInputs.length;
      this.pendingInputs.length = 0;
    };
    const visibility = () => { if (document.hidden) dropPending(); };
    window.addEventListener("blur", dropPending);
    document.addEventListener("visibilitychange", visibility);
    this.offs.push(() => window.removeEventListener("blur", dropPending),
      () => document.removeEventListener("visibilitychange", visibility),
      useGame.subscribe((state, previous) => {
        if (state.phase !== previous.phase && state.phase !== "running") dropPending();
      }), world.events.on("runStart", dropPending));
    const onInput = (event: Event) => {
      if (options.kind !== "human" || !this.running || !event.isTrusted || useGame.getState().phase !== "running") return;
      if (event.target instanceof Element && event.target.closest("[data-ui],button,input,textarea,select")) return;
      if (event instanceof KeyboardEvent && (event.repeat || !["ArrowLeft", "ArrowRight", "KeyA", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code))) return;
      const at = event.timeStamp > performance.timeOrigin ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      if (!Number.isFinite(at) || at <= 0) return;
      if (this.pendingInputs.length === PROFILE_LIMITS.maxInputs) { this.droppedInputs++; return; }
      this.pendingInputs.push({ at, worldTime: world.time, type: event.type });
      if (this.firstSteeringSeconds === null && (event instanceof PointerEvent || event instanceof KeyboardEvent && ["ArrowLeft", "ArrowRight", "KeyA", "KeyD"].includes(event.code))) {
        this.firstSteeringSeconds = (performance.now() - this.started) / 1000;
      }
    };
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup"]) {
      document.addEventListener(type, onInput, true);
      this.offs.push(() => document.removeEventListener(type, onInput, true));
    }
  }

  private event(type: string, detail?: unknown) {
    if (!this.running) return;
    const world = this.controller.bundle.world;
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    const atSeconds = (performance.now() - this.started) / 1000;
    if (type === "routeChoice" && this.firstChoiceSeconds === null) this.firstChoiceSeconds = atSeconds;
    if (this.events.length < PROFILE_LIMITS.maxEvents) {
      this.events.push({ atSeconds, simSeconds: world.time, distance: world.distance, type, detail });
    } else this.droppedEvents++;
  }

  simulation(at: number) {
    const world = this.controller.bundle.world;
    for (const event of this.pendingInputs) {
      if (event.simulationAt === undefined && at - event.at <= 1000 && world.time > event.worldTime) event.simulationAt = at;
    }
  }

  frame(input: ProfileFrameInput) {
    if (!this.running) return;
    const world = this.controller.bundle.world;
    const playing = input.active && useGame.getState().phase === "running";
    // Keep the boundary frame that caused an automatic stall pause. Ordinary
    // background/pause intervals never inflate active gameplay duration.
    const stallBoundary = this.lastWasRunning && !playing && input.frameMs > 250 && !document.hidden;
    this.lastWasRunning = playing;
    if (!playing && !stallBoundary) { this.suspendedFrames++; return; }
    if (!Number.isFinite(input.frameMs) || input.frameMs <= 0) return;
    this.activeMs += input.frameMs;
    const warmed = this.activeMs >= this.options.warmupSeconds * 1000;
    if (warmed) {
      this.measuredMs += input.frameMs;
      this.intervalMs += input.frameMs;
      this.frameTimes.add(input.frameMs);
      this.cpuTimes.add(input.cpuMs);
      this.intervalFrame.add(input.frameMs);
      this.intervalCpu.add(input.cpuMs);
      const graphics = input.graphics;
      if (graphics.gpuSampleAt !== null && graphics.gpuSampleAt !== this.lastGpuAt && graphics.gpuMs !== null) {
        this.lastGpuAt = graphics.gpuSampleAt;
        this.gpuTimes.add(graphics.gpuMs);
        for (const pass of graphics.gpuPasses) {
          if (!this.passes.has(pass.name) && this.passes.size < PROFILE_LIMITS.maxPasses) this.passes.set(pass.name, new ProfileDistribution());
          this.passes.get(pass.name)?.add(pass.gpuMs);
        }
      }
      this.biomes.add(world.biomeIndex);
      this.maxDistance = Math.max(this.maxDistance, world.distance);
      let obstacles = 0;
      for (const obstacle of world.obstacles) if (obstacle.active) obstacles++;
      this.maxActiveObstacles = Math.max(this.maxActiveObstacles, obstacles);
      if (this.intervalMs >= 1000 && this.series.length < PROFILE_LIMITS.maxSeries) {
        this.series.push({ atSeconds: this.measuredMs / 1000, simSeconds: world.time,
          distance: world.distance, biome: world.biomeIndex, activeObstacles: obstacles,
          frame: this.intervalFrame.snapshot(), cpu: this.intervalCpu.snapshot(), graphics: { ...graphics } });
        this.intervalMs = 0;
        this.intervalFrame = new ProfileDistribution();
        this.intervalCpu = new ProfileDistribution();
      }
    }
    for (let i = this.pendingInputs.length - 1; i >= 0; i--) {
      const event = this.pendingInputs[i];
      if (event.simulationAt !== undefined) {
        // Event dispatch through the first observed simulation tick and render
        // submission. This is a CPU-side upper bound, never input-to-photon.
        this.inputSim.add(event.simulationAt - event.at);
        this.inputSubmit.add(input.at - event.at);
        this.pendingInputs.splice(i, 1);
      } else if (input.at - event.at > 1000) { this.pendingInputs.splice(i, 1); this.droppedInputs++; }
    }
    if (this.measuredMs >= this.options.seconds * 1000) this.finish("duration complete");
  }

  note(text: string) {
    if (this.notes.length >= PROFILE_LIMITS.maxNotes) return;
    const entry = { atSeconds: (performance.now() - this.started) / 1000,
      text: `${this.running ? "" : "Post-capture observation: "}${text}`.slice(0, 1000) };
    this.notes.push(entry);
    this.frozenReport?.playtest.notes.push({ ...entry });
  }

  finish(reason: string) {
    if (!this.running) return;
    this.running = false;
    this.reason = reason;
    this.ended = performance.now();
    this.offs.forEach((off) => off());
    this.frozenReport = structuredClone(this.buildReport());
    if (this.options.kind === "benchmark" && this.controller.benchmark) this.controller.bundle.backToTitle();
  }

  report(): ReturnType<Capture["buildReport"]> {
    return this.frozenReport ?? this.buildReport();
  }

  buildReport() {
    const { bundle, driver } = this.controller;
    return {
      format: "hover-weave-profile", version: 1, startedAt: this.startedAt, options: this.options,
      status: this.running ? "running" : "stopped", stopReason: this.reason,
      elapsedSeconds: ((this.ended ?? performance.now()) - this.started) / 1000,
      activeSeconds: this.activeMs / 1000, measuredSeconds: this.measuredMs / 1000,
      metadata: { ...this.controller.hardware, backend: useGame.getState().webgpu === null ? "pending" : useGame.getState().webgpu ? "webgpu" : "webgl2",
        quality: useSettings.getState().quality, autoTier: useSettings.getState().autoTier, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        settings: { reduceMotion: useSettings.getState().reduceMotion, reduceFlash: useSettings.getState().reduceFlash, highContrast: useSettings.getState().highContrast },
        hardwareIdentity: "Browser-reported; label supplied by operator. Viewport/DPR emulation is not actual phone validation." },
      route: this.options.kind === "benchmark" ? { ...this.controller.routeMetadata, loops: driver?.loops ?? 0, simulatedSteps: driver?.totalSteps ?? 0, failure: driver?.failed ?? null } : null,
      measurements: { gpuPassCoverage: useGame.getState().graphics.gpuPassCoverage, gpuSubmittedPasses: useGame.getState().graphics.gpuSubmittedPasses, frame: this.frameTimes.snapshot(), cpu: this.cpuTimes.snapshot(), gpu: this.gpuTimes.snapshot(),
        gpuPasses: [...this.passes].map(([name, timing]) => ({ name, ...timing.snapshot() })),
        inputToSimulationUpperBound: this.inputSim.snapshot(), inputToRenderSubmission: this.inputSubmit.snapshot() },
      coverage: { biomes: [...this.biomes], maxActiveObstacles: this.maxActiveObstacles, maxDistance: this.maxDistance,
        currentDistance: bundle.world.distance, seed: bundle.world.seed },
      playtest: { clockOrigin: "capture start; event simSeconds resets with each ordinary run", counts: this.counts, firstRouteChoiceSeconds: this.firstChoiceSeconds,
        firstSteeringInputSeconds: this.firstSteeringSeconds, notes: this.notes, events: this.events,
        interpretation: "Steering input is not proof of understanding. Route choice is one observable choice, not every meaningful player decision. Interviews and accessibility observation remain required." },
      series: this.series, limits: PROFILE_LIMITS,
      discarded: { events: this.droppedEvents, inputs: this.droppedInputs, suspendedFrames: this.suspendedFrames },
      measurementNotes: ["Frame percentiles use every measured rendered frame, with 0.1 ms histogram precision; values beyond 1000 ms use the observed maximum conservatively.",
        "GPU samples are asynchronous completed query results, deduplicated by capture timestamp. Null means unsupported or unavailable; callback cadence is not GPU throughput.",
        "CPU measures scene callbacks and render submission, not the complete browser main thread. Input timestamps measure CPU-side observation, not display presentation latency.",
        "The benchmark drives genuine recorded 120 Hz inputs. Geometry, collisions and native RAF are unchanged. Input latency applies only to trusted human events.",
        "Browser APIs do not expose reliable device temperature. Compare early/late series and record device, power, ambient conditions and heat observations in notes."],
    };
  }
}

interface Controller {
  bundle: GameBundle;
  capture: Capture | null;
  driver: ProfileRouteDriver | null;
  benchmark: boolean;
  routeMetadata: Record<string, unknown> | null;
  hardware: Record<string, unknown>;
  startGeneration: number;
  disposed: boolean;
}

function normalizedOptions(options: ProfileOptions): Required<ProfileOptions> {
  const seconds = options.seconds ?? 120;
  const warmupSeconds = options.warmupSeconds ?? 10;
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > PROFILE_LIMITS.maxSeconds) throw new Error("Capture duration must be between 60 and 900 seconds");
  if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0 || warmupSeconds > 60) throw new Error("Warmup must be between 0 and 60 seconds");
  const quality = options.quality ?? useSettings.getState().quality;
  if (!["auto", "low", "medium", "high"].includes(quality)) throw new Error("Invalid quality preset");
  const kind = options.kind ?? "benchmark";
  if (kind !== "benchmark" && kind !== "human") throw new Error("Invalid capture kind");
  return { kind, seconds, warmupSeconds, quality, label: (options.label ?? "Unlabelled device").slice(0, 200) };
}

/** Query gated and removable; no endpoint, remote upload, or persistent diagnostic data. */
export function installProfiler(bundle: GameBundle): () => void {
  if (typeof window === "undefined" || new URLSearchParams(location.search).get("profile") !== "1") return () => {};
  const controller: Controller = { bundle, startGeneration: 0, disposed: false, capture: null, driver: null, benchmark: false, routeMetadata: null,
    hardware: { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null } };
  controllers.set(bundle.world, controller);
  const api: ProfileApi = {
    async start(options = {}) {
      const normalized = normalizedOptions(options);
      const generation = ++controller.startGeneration;
      const cancelled = () => controller.disposed || controller.startGeneration !== generation;
      // Load route input bytes only after the explicit benchmark request.
      const route = normalized.kind === "benchmark" ? await import("./route") : null;
      if (cancelled()) return;
      const identity = await readGpuIdentity();
      if (cancelled()) return;
      controller.hardware = { ...controller.hardware, ...identity };
      if (controller.benchmark && normalized.kind === "human") bundle.backToTitle();
      controller.capture?.finish("replaced by new capture");
      controller.driver = null;
      controller.benchmark = normalized.kind === "benchmark";
      if (useSettings.getState().quality !== normalized.quality) useSettings.getState().setQuality(normalized.quality);
      controller.capture = new Capture(controller, normalized);
      if (route) {
        bundle.ghost.arm(null);
        bundle.rival.recording = null;
        bundle.session.config = { mode: "endless", seed: route.PROFILE_ROUTE.recording.seed };
        bundle.session.periodKey = null;
        useGame.getState().setMode("endless");
        useGame.getState().setOutcome(null);
        useGame.getState().setOverlay("none");
        useGame.getState().clearRunFeedback();
        controller.routeMetadata = { id: route.PROFILE_ROUTE.id, seed: route.PROFILE_ROUTE.recording.seed,
          replayVersion: route.PROFILE_ROUTE.recording.v, recordedSteps: route.PROFILE_ROUTE.recording.steps,
          recordedSeconds: route.PROFILE_ROUTE.seconds, generatedBy: route.PROFILE_ROUTE.generatedBy };
        controller.driver = new route.ProfileRouteDriver(bundle.world);
        useGame.getState().setPhase("running");
        bundle.audio.startMusic();
      }
    },
    stop() { controller.startGeneration++; controller.capture?.finish("stopped by operator"); return controller.capture?.report() ?? null; },
    snapshot() { return controller.capture?.report() ?? null; },
    resume() { if (controller.capture?.running && useGame.getState().phase === "paused") bundle.togglePause(); },
    setQuality(quality) { normalizedOptions({ quality }); useSettings.getState().setQuality(quality); controller.capture?.note(`Quality changed to ${quality}`); },
    note(text) { controller.capture?.note(text); },
    download() {
      const report = api.snapshot();
      if (!report) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `hover-weave-profile-${report.startedAt.replace(/[:.]/g, "-")}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
  window.__HOVER_PROFILE__ = api;
  const removePanel = installPanel(api);
  return () => { controller.disposed = true; controller.startGeneration++; controller.capture?.finish("profiler detached"); controllers.delete(bundle.world); removePanel(); delete window.__HOVER_PROFILE__; };
}

async function readGpuIdentity(): Promise<Record<string, unknown>> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options: { powerPreference: string }): Promise<{ info?: { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean } } | null> } }).gpu;
  let webgpuAdapter: Record<string, unknown> | null = null;
  try {
    const adapter = await gpu?.requestAdapter({ powerPreference: "high-performance" });
    const info = adapter?.info;
    if (info) webgpuAdapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter };
  } catch { /* Unsupported GPU identity remains explicitly unavailable. */ }
  const probe = document.createElement("canvas").getContext("webgl2");
  const extension = probe?.getExtension("WEBGL_debug_renderer_info");
  const webglRenderer: string | null = extension ? probe!.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  probe?.getExtension("WEBGL_lose_context")?.loseContext();
  return { webgpuAdapter, webglRenderer };
}

function installPanel(api: ProfileApi) {
  const panel = document.createElement("details");
  panel.dataset.profilePanel = "true";
  panel.dataset.ui = "true";
  panel.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:1000;width:min(350px,90vw);padding:10px;background:#09131fee;color:#edf7ff;border:1px solid #66889c;border-radius:8px;font:12px system-ui;max-height:80vh;overflow:auto";
  panel.innerHTML = `<summary style="cursor:pointer">Performance & playtest capture</summary><p>Local diagnostic capture. Benchmark flights do not earn progress.</p><label>Device / conditions <input aria-label="Capture device label" placeholder="Model, power, room temperature" style="width:100%;color:black"></label><label>Duration <select aria-label="Capture duration" style="color:black"><option value="120">2 minutes</option><option value="600">10 minutes (thermal)</option></select></label><label> Quality <select aria-label="Capture quality" style="color:black"><option value="auto">Auto</option><option value="high" selected>High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><div data-profile-actions style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px"></div><p data-profile-status role="status">Ready. Human capture uses normal controls and progression.</p><label>Observation <input aria-label="Playtest observation" placeholder="First mistake understood; felt delayed…" style="width:100%;color:black"></label>`;
  // Preserve text/select editing while keeping the game's global R/P/Escape
  // shortcuts out of observer input. Keyup still releases any held control.
  panel.addEventListener("keydown", (event) => {
    if (event.target instanceof Element && event.target.closest("input,textarea,select")) event.stopPropagation();
  });
  const actions = panel.querySelector<HTMLElement>("[data-profile-actions]")!;
  const status = panel.querySelector<HTMLElement>("[data-profile-status]")!;
  const options = () => ({ seconds: Number(panel.querySelector<HTMLSelectElement>("[aria-label='Capture duration']")!.value),
    quality: panel.querySelector<HTMLSelectElement>("[aria-label='Capture quality']")!.value as QualityPreset,
    label: panel.querySelector<HTMLInputElement>("[aria-label='Capture device label']")!.value });
  const button = (label: string, action: () => void | Promise<void>) => {
    const node = document.createElement("button");
    node.textContent = label; node.type = "button"; node.style.cssText = "padding:7px;background:#213c50;border:1px solid #7395ab;border-radius:4px;cursor:pointer";
    node.onclick = () => { Promise.resolve(action()).catch((error: unknown) => { status.textContent = String(error); }); };
    actions.append(node);
  };
  button("Start route", () => api.start({ ...options(), kind: "benchmark" }));
  button("Capture human play", () => api.start({ ...options(), kind: "human", warmupSeconds: 0 }));
  button("Resume", () => api.resume()); button("Stop", () => { api.stop(); }); button("Export JSON", () => api.download());
  button("Add observation", () => { const input = panel.querySelector<HTMLInputElement>("[aria-label='Playtest observation']")!; api.note(input.value); input.value = ""; });
  document.body.append(panel);
  const timer = setInterval(() => {
    const capture = api.snapshot();
    if (capture) status.textContent = `${capture.status}: ${capture.measuredSeconds.toFixed(1)} / ${capture.options.seconds}s measured · ${capture.metadata.backend} · ${capture.coverage.maxActiveObstacles} obstacles · ${capture.stopReason ?? "capturing"}${useGame.getState().phase === "paused" && capture.status === "running" ? " · paused; Resume to continue" : ""}`;
  }, 1000);
  return () => { clearInterval(timer); panel.remove(); };
}
