"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type QualityPreset = "auto" | "low" | "medium" | "high";
/** Resolved tier: 0 = low, 1 = medium, 2 = high. */
export type QualityTier = 0 | 1 | 2;

export interface QualityConfig {
  shadows: boolean;
  shadowMapSize: number;
  shadowRadius: number;
  shadowNormalBias: number;
  reflections: boolean;
  reflectionScale: number;
  terrainSegments: [number, number];
  skyDetail: 0 | 1 | 2;
  maxParticles: number;
  bloomQuality: number;
  bloomResolutionScale: number;
  premiumPost: boolean;
  aa: "none" | "fxaa" | "smaa";
  msaaSamples: 0 | 4;
  maxDpr: number;
  minDprScale: number;
}

export const QUALITY_CONFIGS: Record<QualityTier, QualityConfig> = {
  0: {
    shadows: false,
    shadowMapSize: 512,
    shadowRadius: 0,
    shadowNormalBias: 0.02,
    reflections: false,
    reflectionScale: 0,
    terrainSegments: [96, 122],
    skyDetail: 0,
    maxParticles: 384,
    bloomQuality: 0.5,
    bloomResolutionScale: 0.3,
    premiumPost: false,
    aa: "fxaa",
    msaaSamples: 0,
    maxDpr: 1.25,
    minDprScale: 0.7,
  },
  1: {
    shadows: true,
    shadowMapSize: 1024,
    shadowRadius: 2,
    shadowNormalBias: 0.015,
    reflections: true,
    reflectionScale: 0.42,
    terrainSegments: [160, 204],
    skyDetail: 1,
    maxParticles: 768,
    bloomQuality: 0.75,
    bloomResolutionScale: 0.42,
    premiumPost: false,
    aa: "fxaa",
    msaaSamples: 0,
    maxDpr: 1.75,
    minDprScale: 0.75,
  },
  2: {
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 3,
    shadowNormalBias: 0.012,
    reflections: true,
    reflectionScale: 0.65,
    terrainSegments: [224, 286],
    skyDetail: 2,
    maxParticles: 1280,
    bloomQuality: 1,
    bloomResolutionScale: 0.55,
    premiumPost: true,
    aa: "smaa",
    msaaSamples: 4,
    maxDpr: 2,
    minDprScale: 0.85,
  },
};

interface SettingsState {
  quality: QualityPreset;
  /** From detect-gpu, used when quality === 'auto'. */
  autoTier: QualityTier;
  musicVolume: number;
  sfxVolume: number;
  sensitivity: number;
  reduceMotion: boolean;
  reduceFlash: boolean;
  highContrast: boolean;
  showFps: boolean;
  /** Race a spectral ghost of your best run (roadmap 3.2). */
  showGhost: boolean;
  /** Gamepad rumble on grazes/threads/boost (fun-frontier 5.4). */
  haptics: boolean;
  setQuality(q: QualityPreset): void;
  setAutoTier(t: QualityTier): void;
  setMusicVolume(v: number): void;
  setSfxVolume(v: number): void;
  setSensitivity(v: number): void;
  setReduceMotion(v: boolean): void;
  setReduceFlash(v: boolean): void;
  setHighContrast(v: boolean): void;
  setShowFps(v: boolean): void;
  setShowGhost(v: boolean): void;
  setHaptics(v: boolean): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      quality: "auto",
      autoTier: 1,
      musicVolume: 0.8,
      sfxVolume: 0.9,
      sensitivity: 1,
      reduceMotion: false,
      reduceFlash: false,
      highContrast: false,
      showFps: false,
      showGhost: true,
      haptics: true,
      setQuality: (quality) => set({ quality }),
      setAutoTier: (autoTier) => set({ autoTier }),
      setMusicVolume: (musicVolume) => set({ musicVolume }),
      setSfxVolume: (sfxVolume) => set({ sfxVolume }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setReduceFlash: (reduceFlash) => set({ reduceFlash }),
      setHighContrast: (highContrast) => set({ highContrast }),
      setShowFps: (showFps) => set({ showFps }),
      setShowGhost: (showGhost) => set({ showGhost }),
      setHaptics: (haptics) => set({ haptics }),
    }),
    { name: "cubefield:settings" },
  ),
);

export function resolveTier(s: Pick<SettingsState, "quality" | "autoTier">): QualityTier {
  if (s.quality === "low") return 0;
  if (s.quality === "medium") return 1;
  if (s.quality === "high") return 2;
  return s.autoTier;
}
