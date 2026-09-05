"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { WebGPURenderer } from "three/webgpu";
import { useGameBundle } from "../GameController";
import { useGame } from "../state/game";
import { QUALITY_CONFIGS, useSettings, type QualityTier } from "../state/settings";
import { GpuFrameTimer, ResolutionController, TimingWindow } from "./performance";

/** Runs around all scene callbacks and the complete post pipeline. */
export function PerformanceMonitor({ tier }: { tier: QualityTier }) {
  const renderer = useThree((s) => s.gl) as unknown as WebGPURenderer;
  const { env } = useGameBundle();
  const monitor = useRef<{
    frames: TimingWindow;
    cpu: TimingWindow;
    gpu: GpuFrameTimer;
    resolution: ResolutionController;
    started: number;
    publishAt: number;
    renderedFrames: number;
    wasActive: boolean;
  } | null>(null);

  useEffect(() => {
    // trackTimestamp exists in three r185 but is missing from @types/three's
    // base Backend. Keep that version-specific boundary out of the controller.
    const backend = renderer.backend as typeof renderer.backend & {
      trackTimestamp: boolean;
      timestampQueryPool: { render: { timestamps: Map<string, number> } | null };
    };
    const gpu = new GpuFrameTimer({
      supported: renderer.hasFeature("timestamp-query"),
      setTracking: (enabled) => { backend.trackTimestamp = enabled; },
      resolve: async () => {
        try {
          return await renderer.resolveTimestampsAsync();
        } finally {
          // three retains per-pass entries keyed by ever-increasing frame IDs.
          // We retain bounded aggregate samples, not inspector history. Clear
          // that unused history after readback so long sessions stay bounded.
          backend.timestampQueryPool.render?.timestamps.clear();
        }
      },
    });
    monitor.current = {
      frames: new TimingWindow(), cpu: new TimingWindow(), gpu,
      resolution: new ResolutionController(1),
      started: 0, publishAt: 0, renderedFrames: 0, wasActive: false,
    };
    const autoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;
    env.uDrsScale.value = 1;
    useGame.getState().setGraphics({ drsScale: 1, gpuStatus: gpu.status, gpuMs: null });
    return () => {
      gpu.dispose();
      monitor.current = null;
      renderer.info.autoReset = autoReset;
    };
  }, [env, renderer]);

  useEffect(() => {
    const m = monitor.current;
    if (!m) return;
    // Keep one sampler per renderer even across tier changes: an in-flight
    // readback must finish before another query can use the same backend pool.
    m.resolution = new ResolutionController(QUALITY_CONFIGS[tier].minDprScale);
    m.frames.clear();
    m.cpu.clear();
    m.gpu.resetSamples();
    env.uDrsScale.value = 1;
    useGame.getState().setGraphics({
      drsScale: 1, frameSamples: 0, frameMs: 0, frameP95Ms: 0, frameP99Ms: 0,
      cpuMs: 0, gpuMs: null, gpuP95Ms: null, gpuStatus: m.gpu.status,
    });
  }, [env, tier]);

  useFrame(() => {
    const m = monitor.current;
    if (!m) return;
    m.started = performance.now();
    renderer.info.reset();
    const phase = useGame.getState().phase;
    m.gpu.begin(m.started, !document.hidden && (phase === "running" || phase === "title"));
  }, -100);

  // PostFX owns rendering at priority 1; this callback only measures it.
  useFrame((_, dt) => {
    const m = monitor.current;
    if (!m) return;
    const now = performance.now();
    const cpuMs = now - m.started;
    m.gpu.end();
    m.renderedFrames++;
    const g = useGame.getState();
    const active = !document.hidden && (g.phase === "running" || g.phase === "title");
    const frameMs = dt * 1000;
    if (active) {
      if (!m.wasActive || frameMs > 250) {
        // Preserve the last snapshot while paused, then start a fresh window
        // on resume. Startup/focus stalls are not gameplay samples.
        m.frames.clear();
        m.cpu.clear();
      }
      if (frameMs > 0 && frameMs <= 250) {
        m.frames.add(frameMs);
        m.cpu.add(cpuMs);
      }
    }
    m.wasActive = active;
    const gpuMs = m.gpu.latest(now);
    const scale = m.resolution.update(frameMs, gpuMs, active);
    if (scale !== env.uDrsScale.value) {
      env.uDrsScale.value = scale;
      g.setGraphics({ drsScale: scale });
    }
    if (now < m.publishAt) return;
    m.publishAt = now + 250;
    const frames = m.frames.snapshot();
    const cpu = m.cpu.snapshot();
    const gpu = m.gpu.timings.snapshot();
    let textureCounts: Record<string, number> | null = null;
    if (useSettings.getState().showFps) {
      // r185 exposes tracked memory objects; names make quality-switch leaks
      // inspectable in profiler captures without exposing the mutable renderer.
      const info = renderer.info as typeof renderer.info & {
        memoryMap: Map<{ isTexture?: boolean; name?: string }, unknown>;
      };
      textureCounts = {};
      for (const object of info.memoryMap.keys()) {
        if (!object.isTexture) continue;
        const name = object.name || "unnamed";
        textureCounts[name] = (textureCounts[name] ?? 0) + 1;
      }
    }
    g.setFps(frames.mean > 0 ? Math.round(1000 / frames.mean) : 0);
    g.setGraphics({
      dpr: renderer.getPixelRatio(), drsScale: scale,
      renderedFrames: m.renderedFrames, frameSamples: frames.samples,
      frameMs: frames.mean, frameP95Ms: frames.p95, frameP99Ms: frames.p99,
      cpuMs: cpu.mean, gpuMs, gpuP95Ms: gpuMs === null ? null : gpu.p95,
      gpuStatus: m.gpu.status === "available" && gpuMs === null ? "pending" : m.gpu.status,
      drawCalls: renderer.info.render.drawCalls,
      triangles: Math.round(renderer.info.render.triangles),
      textures: renderer.info.memory.textures,
      textureCounts,
    });
  }, 2);

  return null;
}
