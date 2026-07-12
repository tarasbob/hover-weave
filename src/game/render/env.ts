"use client";

import { Color } from "three/webgpu";
import { uniform } from "three/tsl";
import { BIOMES, biomeBlendAt, type BiomeSpec } from "../track/biomes";
import type { SimWorld } from "../core/world";
import { clamp01, damp, lerp } from "../core/mathUtils";
import type { Rng } from "../core/rng";
import { createRng } from "../core/rng";

/** Terrain scroll wrap period — all periodic terrain features divide this. */
export const SCROLL_PERIOD = 1024;

interface BiomeColorSet {
  body: Color; primary: Color; accent: Color; warn: Color; dim: Color;
  fog: Color; skyTop: Color; skyBottom: Color; nebula: Color;
  auroraA: Color; auroraB: Color; horizon: Color; grid: Color;
  terrainA: Color; terrainB: Color; light: Color;
}

const biomeColors: BiomeColorSet[] = BIOMES.map((b: BiomeSpec) => ({
  body: new Color(b.palette.body),
  primary: new Color(b.palette.primary),
  accent: new Color(b.palette.accent),
  warn: new Color(b.palette.warn),
  dim: new Color(b.palette.dim),
  fog: new Color(b.fogColor),
  skyTop: new Color(b.skyTop),
  skyBottom: new Color(b.skyBottom),
  nebula: new Color(b.nebula),
  auroraA: new Color(b.auroraA),
  auroraB: new Color(b.auroraB),
  horizon: new Color(b.horizonGlow),
  grid: new Color(b.gridColor),
  terrainA: new Color(b.terrainA),
  terrainB: new Color(b.terrainB),
  light: new Color(b.lightColor),
}));

/**
 * All shared shader uniforms + the biome blender.
 * One instance lives for the app's lifetime; every material references these.
 */
export class EnvState {
  // Palette.
  uBody = uniform(new Color());
  uPrimary = uniform(new Color());
  uAccent = uniform(new Color());
  uWarn = uniform(new Color());
  uDim = uniform(new Color());

  // Atmosphere.
  uFogColor = uniform(new Color());
  uFogDensity = uniform(0.006);
  uSkyTop = uniform(new Color());
  uSkyBottom = uniform(new Color());
  uNebula = uniform(new Color());
  uNebulaAmt = uniform(0.8);
  uStars = uniform(0.8);
  uAuroraA = uniform(new Color());
  uAuroraB = uniform(new Color());
  uAuroraAmt = uniform(0.5);
  uHorizon = uniform(new Color());
  uFlash = uniform(0);

  // Terrain.
  uGridColor = uniform(new Color());
  uGridIntensity = uniform(1);
  uTerrainA = uniform(new Color());
  uTerrainB = uniform(new Color());
  uDispAmp = uniform(12);
  uDispFreq = uniform(0.01);
  uReflectivity = uniform(0.1);
  uSparkle = uniform(0);

  // Motion / gameplay.
  uScroll = uniform(0);
  uTime = uniform(0);
  uCraftX = uniform(0);
  uSpeedNorm = uniform(0);
  uBoost = uniform(0);
  uFlow = uniform(0);
  uDeath = uniform(0);

  // Light (read on CPU too).
  lightColor = new Color();
  lightIntensity = 1.4;
  ambient = 0.5;
  lightningActive = false;

  /** Smoothed values for CPU consumers. */
  private flowSmooth = 0;
  private flashV = 0;
  private nextStrike = 4;
  private rng: Rng = createRng("env-lightning");
  private strikeListeners: ((i: number) => void)[] = [];

  reduceFlash = false;

  onStrike(fn: (i: number) => void): () => void {
    this.strikeListeners.push(fn);
    return () => {
      this.strikeListeners = this.strikeListeners.filter((f) => f !== fn);
    };
  }

  update(world: SimWorld, dt: number, ambientScroll: number): void {
    const dist = world.status === "idle" ? ambientScroll : world.renderDistance;
    const [ai, bi, t] = biomeBlendAt(dist);
    const A = BIOMES[ai], B = BIOMES[bi];
    const CA = biomeColors[ai], CB = biomeColors[bi];

    lerpColor(this.uBody.value, CA.body, CB.body, t);
    lerpColor(this.uPrimary.value, CA.primary, CB.primary, t);
    lerpColor(this.uAccent.value, CA.accent, CB.accent, t);
    lerpColor(this.uWarn.value, CA.warn, CB.warn, t);
    lerpColor(this.uDim.value, CA.dim, CB.dim, t);
    lerpColor(this.uFogColor.value, CA.fog, CB.fog, t);
    lerpColor(this.uSkyTop.value, CA.skyTop, CB.skyTop, t);
    lerpColor(this.uSkyBottom.value, CA.skyBottom, CB.skyBottom, t);
    lerpColor(this.uNebula.value, CA.nebula, CB.nebula, t);
    lerpColor(this.uAuroraA.value, CA.auroraA, CB.auroraA, t);
    lerpColor(this.uAuroraB.value, CA.auroraB, CB.auroraB, t);
    lerpColor(this.uHorizon.value, CA.horizon, CB.horizon, t);
    lerpColor(this.uGridColor.value, CA.grid, CB.grid, t);
    lerpColor(this.uTerrainA.value, CA.terrainA, CB.terrainA, t);
    lerpColor(this.uTerrainB.value, CA.terrainB, CB.terrainB, t);
    lerpColor(this.lightColor, CA.light, CB.light, t);

    this.uFogDensity.value = lerp(A.fogDensity, B.fogDensity, t);
    this.uNebulaAmt.value = lerp(A.nebulaAmount, B.nebulaAmount, t);
    this.uStars.value = lerp(A.stars, B.stars, t);
    this.uAuroraAmt.value = lerp(A.auroraAmount, B.auroraAmount, t);
    this.uGridIntensity.value = lerp(A.gridIntensity, B.gridIntensity, t);
    this.uDispAmp.value = lerp(A.dispAmp, B.dispAmp, t);
    this.uDispFreq.value = lerp(A.dispFreq, B.dispFreq, t);
    this.uReflectivity.value = lerp(A.reflectivity, B.reflectivity, t);
    this.uSparkle.value = lerp(A.name === "crystal" ? 1 : 0, B.name === "crystal" ? 1 : 0, t);
    this.lightIntensity = lerp(A.lightIntensity, B.lightIntensity, t);
    this.ambient = lerp(A.ambient, B.ambient, t);

    // Motion uniforms. Scroll wraps at SCROLL_PERIOD (terrain features are
    // periodic in it, so the wrap is seamless).
    this.uScroll.value = dist % SCROLL_PERIOD;
    this.uTime.value = world.status === "idle" ? ambientScroll * 0.08 : world.time;
    this.uCraftX.value = world.status === "idle" ? 0 : world.renderX;
    this.uSpeedNorm.value = world.speedNorm;
    this.uBoost.value = world.boostCharge;
    this.flowSmooth = damp(this.flowSmooth, Math.min(world.flowTier / 4, 1.25), 3, dt);
    this.uFlow.value = this.flowSmooth;
    this.uDeath.value = world.status === "dead" ? clamp01(world.deathTimer * 1.6) : 0;

    // Lightning in stormy stretches.
    const stormW = lerp(A.lightning ? 1 : 0, B.lightning ? 1 : 0, t);
    this.lightningActive = stormW > 0.4;
    if (this.lightningActive && world.status === "running") {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        const intensity = this.rng.range(0.5, 1);
        this.flashV = Math.max(this.flashV, intensity);
        this.nextStrike = this.rng.range(2.5, 8);
        for (const fn of this.strikeListeners) fn(intensity);
      }
    }
    this.flashV = Math.max(0, this.flashV - dt * 2.6);
    // Double-pulse shape reads as real lightning.
    const pulse = this.flashV > 0.01
      ? this.flashV * (0.72 + 0.28 * Math.sin(this.flashV * 34))
      : 0;
    this.uFlash.value = this.reduceFlash ? Math.min(pulse, 0.22) : pulse;
  }

  biomeLabelAt(dist: number): string {
    const [ai, , t] = biomeBlendAt(dist);
    return t > 0.6 ? BIOMES[(ai + 1) % BIOMES.length].label : BIOMES[ai].label;
  }
}

const lerpColor = (out: Color, a: Color, b: Color, t: number) => {
  out.copy(a).lerp(b, t);
};
