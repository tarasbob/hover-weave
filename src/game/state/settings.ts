"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type QualityPreset = "auto" | "low" | "medium" | "high";
/** Resolved tier: 0 = low, 1 = medium, 2 = high. */
export type QualityTier = 0 | 1 | 2;

export interface QualityConfig {
  shadows: boolean;
  shadowMapSize: number;
  reflections: boolean;
  terrainSegments: [number, number];
  maxParticles: number;
  bloomQuality: number;
  aa: "none" | "fxaa" | "smaa";
  maxDpr: number;
}

export const QUALITY_CONFIGS: Record<QualityTier, QualityConfig> = {
  0: {
    shadows: false,
    shadowMapSize: 512,
    reflections: false,
    terrainSegments: [96, 72],
    maxParticles: 384,
    bloomQuality: 0.5,
    aa: "none",
    maxDpr: 1.25,
  },
  1: {
    shadows: true,
    shadowMapSize: 1024,
    reflections: true,
    terrainSegments: [160, 120],
    maxParticles: 768,
    bloomQuality: 0.75,
    aa: "fxaa",
    maxDpr: 1.75,
  },
  2: {
    shadows: true,
    shadowMapSize: 2048,
    reflections: true,
    terrainSegments: [224, 168],
    maxParticles: 1280,
    bloomQuality: 1,
    aa: "smaa",
    maxDpr: 2,
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
  showFps: boolean;
  setQuality(q: QualityPreset): void;
  setAutoTier(t: QualityTier): void;
  setMusicVolume(v: number): void;
  setSfxVolume(v: number): void;
  setSensitivity(v: number): void;
  setReduceMotion(v: boolean): void;
  setReduceFlash(v: boolean): void;
  setShowFps(v: boolean): void;
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
      showFps: false,
      setQuality: (quality) => set({ quality }),
      setAutoTier: (autoTier) => set({ autoTier }),
      setMusicVolume: (musicVolume) => set({ musicVolume }),
      setSfxVolume: (sfxVolume) => set({ sfxVolume }),
      setSensitivity: (sensitivity) => set({ sensitivity }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setReduceFlash: (reduceFlash) => set({ reduceFlash }),
      setShowFps: (showFps) => set({ showFps }),
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
