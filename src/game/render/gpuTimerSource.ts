import type { WebGPURenderer } from "three/webgpu";
import type { GpuFrameSample, GpuPassSample, GpuTimerSource } from "./performance";

/** r185 inspector UIDs match the backend query pool on both rendering backends. */
export function collectGpuPasses(
  timestamps: ReadonlyMap<string, number>,
  labels: ReadonlyMap<string, string>,
): GpuPassSample[] {
  const groups = new Map<string, GpuPassSample>();
  for (const [uid, gpuMs] of timestamps) {
    if (!Number.isFinite(gpuMs) || gpuMs < 0) continue;
    let name = labels.get(uid) ?? "Unattributed";
    // Reserve one bounded bucket rather than dropping GPU time when a future
    // graph exceeds the named-pass budget. Existing names continue to accrue.
    if (!groups.has(name) && groups.size >= 63) name = "Other";
    const group = groups.get(name);
    if (group) {
      group.gpuMs += gpuMs;
      group.passes++;
    } else {
      groups.set(name, { name, gpuMs, passes: 1 });
    }
  }
  return [...groups.values()].sort((a, b) => b.gpuMs - a.gpuMs);
}

/**
 * Keep three's version-specific query history and inspector boundary here.
 * Labels are captured only for the sampled frame, then cleared with readback.
 * Chaining/restoring the existing inspector hook permits a developer inspector.
 */
export function createGpuTimerSource(renderer: WebGPURenderer): GpuTimerSource & { dispose(): void } {
  const backend = renderer.backend as typeof renderer.backend & {
    trackTimestamp: boolean;
    timestampQueryPool: { render: { timestamps: Map<string, number> } | null };
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
    gl?: Pick<WebGL2RenderingContext, "getParameter">;
    disjoint?: { GPU_DISJOINT_EXT: number } | null;
  };
  const inspector = renderer.inspector;
  const previous = inspector.beginRender;
  const labels = new Map<string, string>();
  const isDisjoint = () => Boolean(backend.isWebGLBackend && backend.gl && backend.disjoint &&
    backend.gl.getParameter(backend.disjoint.GPU_DISJOINT_EXT));
  const beginRender: typeof previous = function (uid, scene, camera, target) {
    if (backend.trackTimestamp && labels.size < 256) {
      labels.set(uid, (scene.name || target?.texture.name || (target ? "Scene" : "Output")).slice(0, 120));
    }
    previous.call(inspector, uid, scene, camera, target);
  };
  inspector.beginRender = beginRender;
  return {
    supported: renderer.hasFeature("timestamp-query"),
    setTracking(enabled) {
      if (enabled) {
        labels.clear();
        backend.timestampQueryPool.render?.timestamps.clear();
      }
      backend.trackTimestamp = enabled;
    },
    async resolve(): Promise<GpuFrameSample> {
      const submittedPasses = [...new Set(labels.values())];
      const missing = (): GpuFrameSample => ({
        totalMs: undefined, passes: [], coverage: "none", submittedPasses,
      });
      try {
        // Even invalid queries must be consumed so the backend pool can reset.
        const disjointBefore = isDisjoint();
        const totalMs = await renderer.resolveTimestampsAsync();
        const timestamps = backend.timestampQueryPool.render?.timestamps;
        if (disjointBefore || isDisjoint() || totalMs === undefined || !Number.isFinite(totalMs) ||
            totalMs <= 0 || !timestamps?.size ||
            ![...timestamps].some(([uid, ms]) => labels.has(uid) && Number.isFinite(ms) && ms >= 0)) {
          // r185 returns cached lastValue when no fresh query result exists.
          // Never present that historical total as a newly measured frame.
          return missing();
        }
        return {
          totalMs,
          passes: collectGpuPasses(timestamps, labels),
          // WebGL TIME_ELAPSED cannot nest: the outer pipeline query includes
          // its children. WebGPU timestampWrites measure each submitted pass.
          coverage: backend.isWebGPUBackend ? "individual" : "aggregate",
          submittedPasses,
        };
      } catch {
        return missing();
      } finally {
        backend.timestampQueryPool.render?.timestamps.clear();
        labels.clear();
      }
    },
    dispose() {
      if (inspector.beginRender === beginRender) inspector.beginRender = previous;
      backend.trackTimestamp = false;
      labels.clear();
    },
  };
}
