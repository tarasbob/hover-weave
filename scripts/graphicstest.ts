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
