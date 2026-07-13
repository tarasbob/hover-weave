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

/**
 * Static render-budget guard. Runtime GPU timings are exposed through the
 * in-game FPS overlay; this keeps preset costs monotonic and prevents premium
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
