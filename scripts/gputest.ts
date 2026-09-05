import assert from "node:assert/strict";
import { PerspectiveCamera, Scene, type WebGPURenderer } from "three/webgpu";
import { collectGpuPasses, createGpuTimerSource } from "../src/game/render/gpuTimerSource";
import { GpuFrameTimer, TimingWindow, type GpuFrameSample } from "../src/game/render/performance";

function sourceFixture(webgl: boolean) {
  const timestamps = new Map<string, number>();
  const state = {
    disjoint: false, resolutions: 0, inspectorCalls: 0,
    readback: async (): Promise<number | undefined> => 7,
  };
  const backend = {
    trackTimestamp: false,
    isWebGPUBackend: !webgl,
    isWebGLBackend: webgl,
    gl: { getParameter: () => state.disjoint },
    disjoint: { GPU_DISJOINT_EXT: 1 },
    timestampQueryPool: { render: { timestamps } },
  };
  const original = () => { state.inspectorCalls++; };
  const inspector = { beginRender: original };
  const renderer = {
    backend, inspector, hasFeature: () => true,
    resolveTimestampsAsync: () => {
      assert.equal(backend.trackTimestamp, true, "readback starts before disabling query tracking");
      state.resolutions++;
      return state.readback();
    },
  } as unknown as WebGPURenderer;
  const source = createGpuTimerSource(renderer);
  const draw = (uid: string, name: string) => {
    const scene = new Scene();
    scene.name = name;
    // r185 passes null for the screen target despite its narrower .d.ts.
    renderer.inspector.beginRender(uid, scene, new PerspectiveCamera(), null!);
  };
  const resolve = () => {
    const pending = source.resolve();
    source.setTracking(false);
    return pending;
  };
  return { source, state, backend, timestamps, inspector, original, draw, resolve };
}

async function main() {
  const groups = collectGpuPasses(new Map([
    ["a:f1", 2], ["b:f1", 3], ["c:f1", 1], ["d:f1", NaN], ["e:f1", -1],
  ]), new Map([["a:f1", "Bloom"], ["b:f1", "Bloom"], ["c:f1", "Reflection"]]));
  assert.deepEqual(groups, [
    { name: "Bloom", gpuMs: 5, passes: 2 }, { name: "Reflection", gpuMs: 1, passes: 1 },
  ]);
  assert.equal(collectGpuPasses(new Map([["unknown", 2]]), new Map())[0].name, "Unattributed");
  const many = Array.from({ length: 1000 }, (_, i) => [`${i}`, i + 1] as const);
  const overflow = collectGpuPasses(new Map(many), new Map(many.map(([id]) => [id, id])));
  assert.equal(overflow.length, 64);
  assert.equal(overflow.reduce((sum, group) => sum + group.gpuMs, 0), 500500,
    "the overflow bucket preserves total time rather than dropping unknown passes");
  assert.equal(overflow.reduce((sum, group) => sum + group.passes, 0), 1000);
  assert.ok(overflow.some((group) => group.name === "Other"));
  let sample: GpuFrameSample = {
    totalMs: 6, passes: groups, coverage: "individual", submittedPasses: ["Bloom", "Reflection", "Bloom"],
  };
  const timer = new GpuFrameTimer({ supported: true, setTracking() {}, resolve: async () => sample });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  timer.begin(0, true);
  timer.end();
  await flush();
  assert.equal(timer.sampleAt(0), 0);
  assert.equal(timer.passSnapshot(0)[0].gpuMs, 5);
  assert.equal(timer.passSnapshot(0)[0].samples, 1);
  assert.equal(timer.coverage(0), "individual");
  assert.deepEqual(timer.submittedPasses(0), ["Bloom", "Reflection"]);
  const submittedCopy = timer.submittedPasses(0);
  submittedCopy.length = 0;
  assert.equal(timer.submittedPasses(0).length, 2, "callers do not own stored labels");
  sample = {
    totalMs: 1, passes: [{ name: "Reflection", gpuMs: 1, passes: 1 }],
    coverage: "individual", submittedPasses: ["Reflection"],
  };
  timer.begin(250, true);
  timer.end();
  await flush();
  assert.equal(timer.passSnapshot(250).length, 1, "inactive passes do not appear in the latest frame");
  assert.equal(timer.passSnapshot(250)[0].samples, 2);
  assert.deepEqual(timer.passSnapshot(2000), [], "stale pass readbacks are not current measurements");
  assert.equal(timer.sampleAt(2000), null);
  assert.equal(timer.coverage(2000), "none");
  assert.deepEqual(timer.submittedPasses(2000), []);
  assert.equal(timer.submissionAt(2000), null);
  sample = {
    totalMs: 1, passes: [{ name: "Reflection", gpuMs: 0, passes: 1 }],
    coverage: "individual", submittedPasses: ["Reflection"],
  };
  timer.begin(500, true);
  timer.end();
  await flush();
  assert.equal(timer.passSnapshot(500)[0].samples, 3, "valid zero timings count toward pass statistics");
  assert.equal(timer.passSnapshot(500)[0].meanMs, 2 / 3);
  const frameTimes = new TimingWindow();
  frameTimes.add(0);
  assert.equal(frameTimes.snapshot().samples, 0, "frame clocks still require positive measurements");
  sample = { totalMs: undefined, passes: [], coverage: "none", submittedPasses: ["DoF [ Composite ]"] };
  timer.begin(750, true);
  timer.end();
  await flush();
  assert.equal(timer.latest(750), null, "rejected readbacks are never fresh GPU measurements");
  assert.equal(timer.sampleAt(750), null);
  assert.equal(timer.coverage(750), "none");
  assert.equal(timer.submissionAt(750), 750, "submission freshness is separate from valid query freshness");
  assert.deepEqual(timer.submittedPasses(750), ["DoF [ Composite ]"]);
  sample = {
    totalMs: 4, passes: [{ name: "Render Pipeline", gpuMs: 4, passes: 1 }],
    coverage: "aggregate", submittedPasses: ["Render Pipeline", "DoF [ Composite ]"],
  };
  timer.begin(1000, true);
  timer.end();
  await flush();
  assert.equal(timer.latest(1000), 4, "sampling recovers after a transient invalid query");
  assert.equal(timer.coverage(1000), "aggregate");
  assert.equal(timer.passSnapshot(1000).length, 1);
  assert.equal(timer.submittedPasses(1000).length, 2, "unmeasured nested submissions are still inspectable");
  timer.resetSamples();
  assert.deepEqual(timer.passSnapshot(1000), []);
  assert.deepEqual(timer.submittedPasses(1000), []);
  assert.equal(timer.coverage(1000), "none");
  timer.begin(1250, true);
  timer.end();
  timer.resetSamples();
  await flush();
  assert.deepEqual(timer.passSnapshot(1250), [], "quality/phase transitions reject an in-flight pass readback");
  assert.deepEqual(timer.submittedPasses(1250), []);
  timer.dispose();

  for (const webgl of [false, true]) {
    const f = sourceFixture(webgl);
    f.timestamps.set("historic:f0", 200);
    f.source.setTracking(true);
    assert.equal(f.timestamps.size, 0, "sampling clears any historical backend timestamp values");
    f.draw("outer:f1", "Render Pipeline");
    f.draw("child:f1", "DoF [ Composite ]");
    f.state.readback = async () => {
      f.timestamps.set("outer:f1", 3);
      if (!webgl) f.timestamps.set("child:f1", 4);
      return webgl ? 3 : 7;
    };
    const pending = f.resolve();
    f.draw("untracked:f2", "Outside sampled frame");
    const measured = await pending as GpuFrameSample;
    assert.equal(measured.coverage, webgl ? "aggregate" : "individual");
    assert.equal(measured.passes.length, webgl ? 1 : 2);
    assert.deepEqual(measured.submittedPasses, ["Render Pipeline", "DoF [ Composite ]"]);
    assert.equal(f.timestamps.size, 0, "readback always clears the backend history");
    assert.equal(f.state.inspectorCalls, 3, "the preexisting inspector is chained for every render");

    f.source.setTracking(true);
    f.draw("outer:f2", "Render Pipeline");
    f.state.readback = async () => 7;
    const cached = await f.resolve() as GpuFrameSample;
    assert.equal(cached.totalMs, undefined, "cached backend lastValue without fresh timestamps is rejected");
    assert.equal(cached.coverage, "none");
    assert.deepEqual(cached.submittedPasses, ["Render Pipeline"]);

    f.source.setTracking(true);
    f.draw("outer:f3", "Render Pipeline");
    f.state.readback = async () => { throw new Error("device lost"); };
    const failed = await f.resolve() as GpuFrameSample;
    assert.equal(failed.totalMs, undefined);
    assert.equal(failed.coverage, "none");
    assert.equal(f.timestamps.size, 0);
    f.source.dispose();
    assert.equal(f.inspector.beginRender, f.original, "cleanup restores the original inspector hook");
  }

  // The WebGL extension can invalidate query durations during the readback.
  // Three substitutes its last value; detect invalidity on either side and
  // still consume the query so the pool resets for a later successful sample.
  for (const during of [false, true]) {
    const f = sourceFixture(true);
    f.source.setTracking(true);
    f.draw("outer:f1", "Render Pipeline");
    f.state.disjoint = !during;
    f.state.readback = async () => {
      f.state.disjoint = during;
      f.timestamps.set("outer:f1", 7);
      return 7;
    };
    const result = await f.resolve() as GpuFrameSample;
    assert.equal(result.totalMs, undefined, "disjoint before or after readback invalidates all GPU timings");
    assert.equal(result.coverage, "none");
    assert.equal(f.state.resolutions, 1, "an invalid query still gets consumed");
    assert.equal(f.timestamps.size, 0);
    f.source.dispose();
  }
  console.log("GPU attribution, bounded sums, coverage, submissions, zero timings, stale/disjoint rejection and recovery passed.");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
