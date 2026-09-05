import assert from "node:assert/strict";
import { LOOKAHEAD, lookaheadFor, SPEED, TRACK } from "../src/game/core/constants";
import { BIOMES } from "../src/game/track/biomes";
import {
  CAMERA_FAR,
  OCEAN_DEPTH,
  SKYDOME_RADIUS,
  TERRAIN_DEPTH,
} from "../src/game/render/visualConstants";
import { QUALITY_CONFIGS, type QualityTier } from "../src/game/state/settings";
import { createHullGeometry, createWingGeometry } from "../src/game/render/craftGeometry";
import { TrailRibbon } from "../src/game/render/TrailRibbon";
import { GpuFrameTimer, ResolutionController, TimingWindow } from "../src/game/render/performance";
import { createDepthOfField, disposePostResources } from "../src/game/render/disposePostResources";
import { PerspectiveCamera, Scene, type Node, type RenderTarget } from "three/webgpu";
import { pass, rtt } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";

/**
 * Static render-budget guard. These costs are not GPU measurements; the
 * in-game overlay reports those separately. This keeps preset costs monotonic and prevents premium
 * passes from accidentally leaking into lower tiers.
 */
const tiers: QualityTier[] = [0, 1, 2];
let previousCost = 0;

for (const tier of tiers) {
  const quality = QUALITY_CONFIGS[tier];
  const sceneSamples = Math.max(1, quality.msaaSamples);
  const sceneCost = quality.maxDpr ** 2 * sceneSamples;
  const bloomCost = quality.maxDpr ** 2 * quality.bloomResolutionScale ** 2 * 6;
  const reflectionCost = quality.reflections
    ? quality.maxDpr ** 2 * quality.reflectionScale ** 2
    : 0;
  const premiumPostCost = quality.premiumPost ? quality.maxDpr ** 2 * 2.5 : 0;
  const estimatedPixelCost = sceneCost + bloomCost + reflectionCost + premiumPostCost;

  assert(
    estimatedPixelCost >= previousCost,
    `tier ${tier} must not cost less than the preceding visual tier`,
  );
  assert(
    quality.minDprScale >= 0.65 && quality.minDprScale <= 1,
    `tier ${tier} has an unsafe DRS floor`,
  );
  assert(
    quality.bloomResolutionScale >= 0.22 && quality.bloomResolutionScale <= 0.65,
    `tier ${tier} bloom resolution is outside the supported budget`,
  );
  assert(
    !quality.reflections || quality.reflectionScale >= 0.3,
    `tier ${tier} enables reflections below a useful resolution`,
  );
  if (tier < 2) {
    assert.equal(quality.premiumPost, false, "premium post is reserved for high quality");
    assert.equal(quality.msaaSamples, 0, "lower tiers should avoid multisampled scene targets");
  }

  previousCost = estimatedPixelCost;
  console.log(
    `tier ${tier}: ${estimatedPixelCost.toFixed(2)} relative pixel units, ` +
      `${quality.maxParticles} particles, sky detail ${quality.skyDetail}`,
  );
}

console.log("Graphics quality budgets valid.");

// --- Speed-proportional lookahead: static no-pop-in invariant ---------------
// Geometry finishes materializing at MATERIALIZE_START_FRAC × viewDistance,
// and env.ts scales fog density by GEN_HORIZON / viewDistance. Whatever the
// speed, the remaining scene transmittance at the materialize-start depth
// must stay negligible: exp(-(density·fogScale·depth)²) with the thinnest
// biome fog (worst case, and the GameScene height factor ≥ 0.28 only
// *thickens* it near the ground where obstacles live... the factor floor is
// applied for honesty). Checked out to 2× SPEED.MAX plus the horizon cap.
{
  const minBiomeDensity = Math.min(...BIOMES.map((b) => b.fogDensity));
  // GameScene thins fog with altitude: smoothstep(64, 3, y) * 0.72 + 0.28.
  // Collidable geometry tops out around ~32 m (tall pillars, arch crowns);
  // huge horizon landmarks scale in from zero instead and are exempt.
  const OBSTACLE_MAX_Y = 32;
  const t = Math.min(1, Math.max(0, (OBSTACLE_MAX_Y - 64) / (3 - 64)));
  const heightFactor = (t * t * (3 - 2 * t)) * 0.72 + 0.28;
  let worst = 0;
  for (let speed = 30; speed <= SPEED.MAX * 2 + 40; speed += 10) {
    const view = lookaheadFor(speed);
    const fogScale = TRACK.GEN_HORIZON / view;
    const matStart = view * LOOKAHEAD.MATERIALIZE_START_FRAC;
    const opticalDepth = minBiomeDensity * fogScale * heightFactor * matStart;
    const transmittance = Math.exp(-opticalDepth * opticalDepth);
    worst = Math.max(worst, transmittance);
    assert.ok(
      transmittance < 0.02,
      `pop-in risk at speed ${speed}: transmittance ${transmittance.toExponential(2)} ` +
      `at materialize start ${matStart.toFixed(0)}m (view ${view.toFixed(0)}m)`,
    );
  }
  console.log(
    `no-pop-in invariant holds to ${SPEED.MAX * 2 + 40} m/s ` +
    `(worst-case materialize transmittance ${worst.toExponential(2)} at y=${OBSTACLE_MAX_Y}m)`,
  );

  // The far field must out-reach the largest speed-scaled view distance.
  assert.ok(
    CAMERA_FAR > LOOKAHEAD.MAX + 200,
    `camera far plane ${CAMERA_FAR} clips the max view distance ${LOOKAHEAD.MAX}`,
  );
  assert.ok(
    TERRAIN_DEPTH >= LOOKAHEAD.MAX + 100,
    `terrain depth ${TERRAIN_DEPTH} ends inside the max view distance`,
  );
  assert.ok(
    OCEAN_DEPTH >= LOOKAHEAD.MAX + 100,
    `ocean depth ${OCEAN_DEPTH} ends inside the max view distance`,
  );
  assert.ok(
    SKYDOME_RADIUS > LOOKAHEAD.MAX && SKYDOME_RADIUS < CAMERA_FAR,
    "sky dome must wrap the view distance and stay inside the far plane",
  );
  console.log("far-field depth budget consistent with LOOKAHEAD.");
}

// The wake must describe the same flight at 30, 60 and 144 Hz, and freezing
// simulation time must preserve it rather than draining its history.
{
  const snapshots = [30, 60, 144].map((fps) => {
    const trail = new TrailRibbon();
    for (let frame = 0; frame <= fps * 2; frame++) {
      const time = frame / fps;
      trail.update(time * 4, 1 + time * 0.2, time * 100, time);
    }
    trail.write(200, 0.1, 2);
    const snapshot = trail.positions.slice();
    for (let frame = 0; frame < 120; frame++) {
      trail.update(8, 1.4, 200, 2);
      trail.write(200, 0.1, 2);
    }
    assert.deepEqual(trail.positions, snapshot, "paused trails must retain their shape");

    // Seeking/restarting cannot connect unrelated points across the level.
    trail.update(-5, 1, 5000, 10);
    trail.write(5000, 0.1, 10);
    for (let i = 2; i < trail.positions.length; i += 3) {
      assert.equal(trail.positions[i], 0, "a discontinuity must clear the old wake");
    }
    trail.reset();
    trail.write(0, 0.1, 0);
    assert.ok(trail.positions.every(Number.isFinite), "empty trails must have finite geometry");
    trail.geometry.dispose();
    return snapshot;
  });
  for (const snapshot of snapshots.slice(1)) {
    assert.equal(snapshot.length, snapshots[0].length);
    for (let index = 0; index < snapshot.length; index++) {
      assert.ok(
        Math.abs(snapshot[index] - snapshots[0][index]) < 0.0002,
        `trail vertex ${index} changed with refresh rate`,
      );
    }
  }
  console.log("Wake is refresh-rate independent; pause and restart preserve valid geometry.");
}

// Authored panels must remain watertight, correctly wound and small enough
// to keep the same hero craft available on every graphics tier.
{
  const hull = createHullGeometry();
  const positions = hull.getAttribute("position");
  let volume = 0;
  for (let index = 0; index < positions.count; index += 3) {
    const ax = positions.getX(index), ay = positions.getY(index), az = positions.getZ(index);
    const bx = positions.getX(index + 1), by = positions.getY(index + 1), bz = positions.getZ(index + 1);
    const cx = positions.getX(index + 2), cy = positions.getY(index + 2), cz = positions.getZ(index + 2);
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  assert.ok(volume > 0.1, "hull faces must point outward around a closed volume");
  assert.ok(positions.count / 3 <= 80, "hull must stay within its geometry budget");
  assert.ok(Array.from(hull.getAttribute("normal").array).every(Number.isFinite));
  hull.dispose();
  for (const sweep of [0.3, 0.5, 0.95]) {
    const wing = createWingGeometry(sweep);
    assert.ok(wing.getAttribute("position").count / 3 <= 80, "wing exceeded geometry budget");
    assert.ok(Array.from(wing.getAttribute("normal").array).every(Number.isFinite));
    wing.dispose();
  }
  console.log("Sculpted craft geometry is correctly wound and within its triangle budget.");
}

// Frame tails must include every frame and keep bounded storage. One hitch
// must not disappear just because it landed between HUD publication frames.
{
  const timings = new TimingWindow(100);
  for (let frame = 0; frame < 100; frame++) timings.add(frame < 95 ? 10 : 40);
  assert.deepEqual(timings.snapshot(), { samples: 100, mean: 11.5, p95: 10, p99: 40 });
  for (let frame = 0; frame < 100; frame++) timings.add(12);
  timings.add(NaN);
  timings.add(-1);
  assert.deepEqual(timings.snapshot(), { samples: 100, mean: 12, p95: 12, p99: 12 });
  timings.clear();
  assert.equal(timings.snapshot().samples, 0);
}

// Resolution reacts to sustained GPU pressure, recovers with headroom, and
// never mistakes focus loss, one shader stall, or a CPU-bound frame for it.
{
  for (const fps of [30, 60, 144, 240]) {
    const drs = new ResolutionController(0.75);
    for (let frame = 0; frame < fps; frame++) drs.update(1000 / fps, 30, true);
    assert.equal(drs.scale, 1, `startup warmup at ${fps} Hz`);
    for (let frame = 0; frame < fps * 12; frame++) drs.update(1000 / fps, 30, true);
    assert.equal(drs.scale, 0.75, `bounded GPU pressure at ${fps} Hz`);
    for (let frame = 0; frame < fps * 24; frame++) drs.update(1000 / fps, 8, true);
    assert.equal(drs.scale, 1, `recovery at ${fps} Hz`);
  }
  const drs = new ResolutionController(0.85);
  for (let frame = 0; frame < 600; frame++) drs.update(1000 / 30, 8, true);
  assert.equal(drs.scale, 1, "cheap GPU work on a 30 Hz display must stay crisp");
  drs.update(5000, null, true);
  drs.update(16, null, false);
  for (let frame = 0; frame < 30; frame++) drs.update(33, null, true);
  assert.equal(drs.scale, 1, "resume has a warmup, rather than an immediate downscale");
  for (let frame = 0; frame < 400; frame++) drs.update(33, null, true);
  assert.equal(drs.scale, 0.85, "unsupported GPU timers retain frame-cadence fallback");
  console.log("Frame tails and dynamic resolution are bounded, time-based, and GPU-aware.");
}

async function testGpuSampling() {
  let tracking = false;
  let resolveCount = 0;
  let complete: (ms: number | undefined) => void = () => undefined;
  const timer = new GpuFrameTimer({
    supported: true,
    setTracking: (enabled) => { tracking = enabled; },
    resolve: () => {
      assert.equal(tracking, true, "resolve begins while timestamp tracking is enabled");
      resolveCount++;
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  timer.begin(0, true);
  assert.equal(tracking, true);
  timer.end();
  assert.equal(tracking, false, "stop query allocation during asynchronous readback");
  timer.begin(1000, true);
  timer.end();
  assert.equal(resolveCount, 1, "at most one readback may be in flight");
  complete(7);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timer.latest(1000), 7);
  assert.equal(timer.latest(1600), null, "stale GPU timings cannot drive resolution");
  assert.equal(timer.status, "available");
  timer.begin(2000, false);
  assert.equal(tracking, false, "inactive scenes do not issue timestamp queries");
  timer.begin(2000, true);
  assert.equal(tracking, true, "completed readbacks allow the next sample");
  assert.equal(timer.latest(2000), null, "new queries cannot make old results fresh");
  timer.end();
  assert.equal(resolveCount, 2);
  timer.resetSamples();
  complete(10);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timer.latest(2000), null, "tier changes reject readbacks from the old pipeline");
  assert.equal(timer.timings.snapshot().samples, 0);
  timer.begin(3000, true);
  timer.end();
  timer.dispose();
  complete(10);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timer.timings.snapshot().samples, 0, "unmounted monitors ignore late readbacks");
  const unsupported = new GpuFrameTimer({
    supported: false,
    setTracking: () => undefined,
    resolve: () => { throw new Error("unsupported timer must never resolve"); },
  });
  unsupported.begin(0, true);
  unsupported.end();
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.latest(0), null);
  const failed = new GpuFrameTimer({
    supported: true,
    setTracking: () => undefined,
    resolve: async () => { throw new Error("device lost"); },
  });
  failed.begin(0, true);
  failed.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.latest(0), null);
  console.log("GPU queries are nonblocking, bounded, capability-gated, and reject stale results.");
}

void testGpuSampling().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// A shared post graph has cycles (pass textures refer back to their pass).
// Quality changes must release targets exactly once without touching scenery.
{
  const scene = new Scene();
  const scenePass = pass(scene, new PerspectiveCamera());
  const color = scenePass.getTextureNode("output");
  const glow = bloom(color);
  const texture = rtt(glow.add(color));
  const output = texture.add(texture);
  let sceneDisposals = 0;
  let textureDisposals = 0;
  scenePass.renderTarget.addEventListener("dispose", () => sceneDisposals++);
  texture.renderTarget!.addEventListener("dispose", () => textureDisposals++);
  disposePostResources(output);
  assert.equal(sceneDisposals, 1, "shared scene target must be released once");
  assert.equal(textureDisposals, 1, "implicit render-to-texture target must be released once");
  console.log("Post graph cleanup releases shared offscreen targets exactly once.");
}

// DOF constructs a Gaussian blur inside a private material only when setup
// runs. Disposing that material alone leaves both blur textures allocated.
{
  const scenePass = pass(new Scene(), new PerspectiveCamera());
  const effect = dof(scenePass.getTextureNode("output"), scenePass.getViewZNode());
  effect.setup({ getSharedContext: () => ({}) } as unknown as Parameters<typeof effect.setup>[0]);
  const privateEffect = effect as unknown as {
    _CoCBlurredMaterial: { colorNode: Node & { _horizontalRT: RenderTarget; _verticalRT: RenderTarget } };
  };
  const blur = privateEffect._CoCBlurredMaterial.colorNode;
  assert.equal(blur.type, "GaussianBlurNode", "probe uses the installed DOF ownership path");
  let horizontalDisposals = 0;
  let verticalDisposals = 0;
  blur._horizontalRT.addEventListener("dispose", () => horizontalDisposals++);
  blur._verticalRT.addEventListener("dispose", () => verticalDisposals++);
  disposePostResources(effect);
  assert.equal(horizontalDisposals, 1, "DOF's private horizontal blur target must be released once");
  assert.equal(verticalDisposals, 1, "DOF's private vertical blur target must be released once");
  console.log("Post graph cleanup releases DOF's private Gaussian blur targets.");
}

// Three can setup the same DOF more than once, replacing its material's blur
// node. Both generations own GPU textures even though only the latest remains
// reachable through the material after the second setup.
{
  const scenePass = pass(new Scene(), new PerspectiveCamera());
  const effect = createDepthOfField(scenePass.getTextureNode("output"), scenePass.getViewZNode());
  const builder = { getSharedContext: () => ({}) } as unknown as Parameters<typeof effect.setup>[0];
  const generations: Array<{ horizontal: number; vertical: number }> = [];
  const blurs: Node[] = [];
  for (let generation = 0; generation < 2; generation++) {
    effect.setup(builder);
    const blur = (effect as unknown as {
      _CoCBlurredMaterial: { colorNode: Node & { _horizontalRT: RenderTarget; _verticalRT: RenderTarget } };
    })._CoCBlurredMaterial.colorNode;
    blurs.push(blur);
    const disposals = { horizontal: 0, vertical: 0 };
    generations.push(disposals);
    blur._horizontalRT.addEventListener("dispose", () => disposals.horizontal++);
    blur._verticalRT.addEventListener("dispose", () => disposals.vertical++);
  }
  assert.notEqual(blurs[0], blurs[1], "installed DOF setup replaces its private blur node");
  disposePostResources(effect);
  assert.deepEqual(generations, [{ horizontal: 1, vertical: 1 }, { horizontal: 1, vertical: 1 }],
    "each setup's blur targets must be released once, including the overwritten generation");

  // React can replay an effect's cleanup and setup without replacing its
  // memoized post graph. Ownership must register again after the first dispose.
  const reusedDisposals: Array<{ horizontal: number; vertical: number }> = [];
  for (let generation = 0; generation < 2; generation++) {
    effect.setup(builder);
    const blur = (effect as unknown as {
      _CoCBlurredMaterial: { colorNode: Node & { _horizontalRT: RenderTarget; _verticalRT: RenderTarget } };
    })._CoCBlurredMaterial.colorNode;
    const disposals = { horizontal: 0, vertical: 0 };
    reusedDisposals.push(disposals);
    blur._horizontalRT.addEventListener("dispose", () => disposals.horizontal++);
    blur._verticalRT.addEventListener("dispose", () => disposals.vertical++);
  }
  disposePostResources(effect);
  assert.deepEqual(reusedDisposals, [{ horizontal: 1, vertical: 1 }, { horizontal: 1, vertical: 1 }],
    "a reused DOF graph retains every new setup generation after cleanup");
  assert.deepEqual(generations, [{ horizontal: 2, vertical: 2 }, { horizontal: 2, vertical: 2 }],
    "previous blur generations remain owned if a cached compiled graph reuses them");
  disposePostResources(effect);
  assert.deepEqual(generations, [{ horizontal: 3, vertical: 3 }, { horizontal: 3, vertical: 3 }],
    "cleanup without another setup still reaches the original compiled blur resources once");
  assert.deepEqual(reusedDisposals, [{ horizontal: 2, vertical: 2 }, { horizontal: 2, vertical: 2 }],
    "each retained target is disposed once per cleanup, including cached-graph reuse");
  console.log("Post graph cleanup retains and releases every DOF setup generation.");
}
