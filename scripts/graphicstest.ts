import assert from "node:assert/strict";
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
