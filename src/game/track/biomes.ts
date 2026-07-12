import { BIOME_LENGTH, BIOME_TRANSITION } from "../core/constants";
import { clamp01 } from "../core/mathUtils";

export interface BiomePalette {
  /** Obstacle body base color. */
  body: string;
  primary: string;
  accent: string;
  warn: string;
  dim: string;
}

export interface BiomeSpec {
  name: string;
  label: string;
  palette: BiomePalette;
  fogColor: string;
  fogDensity: number;
  skyTop: string;
  skyBottom: string;
  nebula: string;
  nebulaAmount: number;
  stars: number;
  auroraA: string;
  auroraB: string;
  auroraAmount: number;
  horizonGlow: string;
  gridColor: string;
  gridIntensity: number;
  terrainA: string;
  terrainB: string;
  dispAmp: number;
  dispFreq: number;
  reflectivity: number;
  lightColor: string;
  lightIntensity: number;
  ambient: number;
  lightning: boolean;
}

export const BIOMES: BiomeSpec[] = [
  {
    name: "crystal",
    label: "Crystal Desert",
    palette: {
      body: "#160b31",
      primary: "#ff3df0",
      accent: "#43f6ff",
      warn: "#ffb547",
      dim: "#7a5cff",
    },
    fogColor: "#160d33",
    fogDensity: 0.0062,
    skyTop: "#050216",
    skyBottom: "#2c1157",
    nebula: "#8b2fd9",
    nebulaAmount: 0.85,
    stars: 0.9,
    auroraA: "#ff3df0",
    auroraB: "#43f6ff",
    auroraAmount: 0.55,
    horizonGlow: "#b03bff",
    gridColor: "#43f6ff",
    gridIntensity: 1.0,
    terrainA: "#0c0620",
    terrainB: "#251043",
    dispAmp: 14,
    dispFreq: 0.011,
    reflectivity: 0.1,
    lightColor: "#c39bff",
    lightIntensity: 1.5,
    ambient: 0.5,
    lightning: false,
  },
  {
    name: "ocean",
    label: "Digital Ocean",
    palette: {
      body: "#03202c",
      primary: "#22e0ff",
      accent: "#64ffd8",
      warn: "#ffd166",
      dim: "#1c7fa8",
    },
    fogColor: "#04141f",
    fogDensity: 0.0058,
    skyTop: "#010a16",
    skyBottom: "#0b3d55",
    nebula: "#0e7fa5",
    nebulaAmount: 0.6,
    stars: 0.7,
    auroraA: "#38f3ff",
    auroraB: "#64ffd8",
    auroraAmount: 0.75,
    horizonGlow: "#18c8e8",
    gridColor: "#38f3ff",
    gridIntensity: 1.25,
    terrainA: "#02121d",
    terrainB: "#073048",
    dispAmp: 7,
    dispFreq: 0.016,
    reflectivity: 0.62,
    lightColor: "#8fd8ff",
    lightIntensity: 1.6,
    ambient: 0.55,
    lightning: false,
  },
  {
    name: "storm",
    label: "Storm Front",
    palette: {
      body: "#131118",
      primary: "#ffb200",
      accent: "#a78bfa",
      warn: "#ff4d6d",
      dim: "#584a7a",
    },
    fogColor: "#131020",
    fogDensity: 0.009,
    skyTop: "#08070f",
    skyBottom: "#292040",
    nebula: "#4c3a80",
    nebulaAmount: 1.0,
    stars: 0.25,
    auroraA: "#a78bfa",
    auroraB: "#ffb200",
    auroraAmount: 0.3,
    horizonGlow: "#5b4a94",
    gridColor: "#a78bfa",
    gridIntensity: 0.72,
    terrainA: "#0d0c14",
    terrainB: "#1e1a2e",
    dispAmp: 18,
    dispFreq: 0.009,
    reflectivity: 0.2,
    lightColor: "#cabcff",
    lightIntensity: 1.15,
    ambient: 0.4,
    lightning: true,
  },
  {
    name: "void",
    label: "Void Tunnel",
    palette: {
      body: "#0a0512",
      primary: "#ff2d78",
      accent: "#ff9e3d",
      warn: "#f5f4ff",
      dim: "#8b1f4e",
    },
    fogColor: "#070310",
    fogDensity: 0.0045,
    skyTop: "#010004",
    skyBottom: "#12052a",
    nebula: "#3c1160",
    nebulaAmount: 0.65,
    stars: 1.6,
    auroraA: "#ff2d78",
    auroraB: "#ff9e3d",
    auroraAmount: 0.42,
    horizonGlow: "#ff2d78",
    gridColor: "#ff2d78",
    gridIntensity: 0.85,
    terrainA: "#050208",
    terrainB: "#150724",
    dispAmp: 3,
    dispFreq: 0.02,
    reflectivity: 0.4,
    lightColor: "#ff9e9e",
    lightIntensity: 1.2,
    ambient: 0.42,
    lightning: false,
  },
];

/** Which biome band a given track distance falls into. */
export function biomeIndexAt(s: number): number {
  return Math.floor(Math.max(0, s) / BIOME_LENGTH) % BIOMES.length;
}

/**
 * Blend state between the current biome and the next.
 * Returns [fromIndex, toIndex, t] where t=0 means fully `from`.
 */
export function biomeBlendAt(s: number): [number, number, number] {
  const pos = Math.max(0, s);
  const idx = Math.floor(pos / BIOME_LENGTH);
  const local = pos - idx * BIOME_LENGTH;
  const from = idx % BIOMES.length;
  const to = (idx + 1) % BIOMES.length;
  const t = clamp01((local - (BIOME_LENGTH - BIOME_TRANSITION)) / BIOME_TRANSITION);
  return [from, to, t];
}
