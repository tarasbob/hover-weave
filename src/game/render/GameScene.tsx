"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { densityFogFactor, fog, positionWorld, smoothstep } from "three/tsl";
import { useGameBundle } from "../GameController";
import { advanceProfile, isBenchmarkRun, recordProfileSimulation } from "../profiling/runtime";
import { MEDAL_RANK, medalFor, nextMedalFor, trialById } from "../track/trials";
import { useGame } from "../state/game";
import { useMeta } from "../state/meta";
import { QUALITY_CONFIGS, resolveTier, useSettings } from "../state/settings";
import { CameraRig } from "./CameraRig";
import { Craft } from "./Craft";
import { Decor } from "./Decor";
import { Ghost } from "./Ghost";
import { HorizonLandmarks } from "./HorizonLandmarks";
import { Lightning } from "./Lightning";
import { ObstacleField } from "./ObstacleField";
import { Particles } from "./Particles";
import { Pickups } from "./Pickups";
import { PostFX } from "./PostFX";
import { PerformanceMonitor } from "./PerformanceMonitor";
import { SkyAids } from "./SkyAids";
import { SkyDome } from "./SkyDome";
import { Terrain } from "./Terrain";
import { Ocean } from "./Ocean";
import { SUN_DIRECTION } from "./visualConstants";

const HUD_INTERVAL = 1 / 12;

/**
 * Time kiss (fun-frontier 5.2): a sub-100ms wall-clock slow-mo on perfect
 * passes and threads — flow state made mechanical, grazing well makes the
 * next graze reachable. Applied at the dt boundary exactly like the death
 * slow-mo, so the sim's fixed steps (and with them replays and ghosts) are
 * untouched: only the rate at which wall time feeds the sim dips.
 */
const KISS = {
  /** Seconds of full dip. */
  HOLD: 0.07,
  /** Seconds easing back to full speed. */
  RELEASE: 0.16,
  /** Timescale floor during the dip. */
  FLOOR: 0.55,
} as const;

export function GameScene() {
  const bundle = useGameBundle();
  const { world, ghost, input, env, audio, haptics, ambient } = bundle;
  const scene = useThree((s) => s.scene);

  const tier = useSettings((s) => resolveTier(s));
  const quality = QUALITY_CONFIGS[tier];
  const sensitivity = useSettings((s) => s.sensitivity);
  const showGhost = useSettings((s) => s.showGhost);

  const hudClock = useRef(0);
  /** Highest medal rank celebrated this run (trial medal callouts). */
  const medalRank = useRef(0);
  /** Time-kiss countdown (seconds left of dip + release). */
  const kiss = useRef(0);

  useEffect(() => {
    const offs = [
      world.events.on("runStart", () => {
        medalRank.current = 0;
        kiss.current = 0;
      }),
      world.events.on("nearMiss", (e) => {
        if (e.grade === "perfect") kiss.current = KISS.HOLD + KISS.RELEASE;
      }),
      world.events.on("thread", () => {
        kiss.current = KISS.HOLD + KISS.RELEASE;
      }),
      // A perfect flare-landing earns the same breath as a perfect pass.
      world.events.on("land", (e) => {
        if (e.grade === "perfect") kiss.current = KISS.HOLD + KISS.RELEASE;
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [world]);

  // Height-aware exponential fog from env uniforms (denser near the ground,
  // thinning overhead so the sky stays crisp — but never so thin that tall
  // obstacles escape the fog and pop in at the generation horizon).
  useEffect(() => {
    const heightFactor = smoothstep(64, 3, positionWorld.y).mul(0.72).add(0.28);
    const factor = densityFogFactor(env.uFogDensity.mul(heightFactor));
    const s = scene as THREE.Scene & { fogNode: unknown };
    s.fogNode = fog(env.uFogColor, factor);
    return () => {
      s.fogNode = null;
    };
  }, [scene, env]);

  const dirLight = useMemo(() => {
    const l = new THREE.DirectionalLight("#c0bfff", 1.4);
    l.position.set(38, 64, -36);
    l.castShadow = quality.shadows;
    l.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    l.shadow.camera.near = 8;
    l.shadow.camera.far = 220;
    l.shadow.camera.left = -58;
    l.shadow.camera.right = 58;
    l.shadow.camera.top = 74;
    l.shadow.camera.bottom = -38;
    l.shadow.bias = -0.0015;
    l.shadow.normalBias = quality.shadowNormalBias;
    l.shadow.radius = quality.shadowRadius;
    l.target.position.set(0, 0, -46);
    return l;
  }, [
    quality.shadowMapSize,
    quality.shadowNormalBias,
    quality.shadowRadius,
    quality.shadows,
  ]);

  const hemisphereLight = useMemo(
    () => new THREE.HemisphereLight("#8f9bff", "#160b31", 0.5),
    [],
  );
  const rimLight = useMemo(() => {
    const light = new THREE.DirectionalLight("#43f6ff", 0.35);
    light.position.set(-32, 20, 28);
    return light;
  }, []);

  // R3F does not dispose objects supplied through <primitive>. In particular,
  // replacing the key light on a tier change otherwise retains its shadow
  // targets and the renderer's shadow-node listeners.
  useEffect(() => () => dirLight.dispose(), [dirLight]);
  useEffect(() => () => {
    hemisphereLight.dispose();
    rimLight.dispose();
  }, [hemisphereLight, rimLight]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.25);
    let g = useGame.getState();

    // --- Input edges ---------------------------------------------------
    input.poll(sensitivity);
    if (input.consumeRestart()) {
      if (g.overlay === "none") {
        if (g.phase === "dead") bundle.restart();
        else if (g.phase === "title") bundle.restart();
      }
    }
    if (input.consumePause()) {
      if (g.overlay !== "none") g.setOverlay("none");
      else if (g.phase === "running" || g.phase === "paused") bundle.togglePause();
    }
    // Restart/pause edges can change the phase synchronously. Simulate the
    // resulting state so a pause never leaks a final movement frame.
    g = useGame.getState();

    // --- Simulation ------------------------------------------------------
    // A long stall auto-pauses an underway run. Before its first simulation
    // tick, discard shader/startup work without presenting a paused launch.
    // Shorter low-FPS frames are fully simulated, so dropping frames cannot
    // create a slow-motion score exploit.
    const throttled = rawDt > 0.25;
    if (throttled && g.phase === "running" && world.time > 0) {
      bundle.togglePause();
      g = useGame.getState();
    }
    if ((g.phase === "running" || g.phase === "dead") && !throttled) {
      // Time kiss: dip the wall-clock rate briefly after a perfect/thread.
      let kissScale = 1;
      // Accessibility presentation settings never change ranked reaction
      // time: every pilot receives the same gameplay-relevant kiss.
      if (kiss.current > 0 && world.status === "running") {
        const release = Math.min(1, kiss.current / KISS.RELEASE);
        kissScale = 1 - (1 - KISS.FLOOR) * release;
      }
      kiss.current = Math.max(0, kiss.current - rawDt);
      if (!advanceProfile(world, dt * kissScale)) world.update(dt * kissScale, input.state);
      recordProfileSimulation(world);
      ghost.sync(world.time);
    } else if (g.phase === "title") {
      ambient.value += dt * 9;
    }

    // --- Environment + audio ----------------------------------------------
    env.update(world, dt, ambient.value);
    audio.update(world, dt);
    haptics.update(world, dt);
    const lightX = world.status === "idle" ? 0 : world.renderX * 0.28;
    dirLight.target.position.set(lightX, 0, -46);
    dirLight.position.set(
      lightX + SUN_DIRECTION[0] * 82,
      SUN_DIRECTION[1] * 82,
      -46 + SUN_DIRECTION[2] * 82,
    );
    rimLight.position.set(lightX - SUN_DIRECTION[0] * 45, 20, 18);
    rimLight.target.position.copy(dirLight.target.position);
    dirLight.color.copy(env.lightColor);
    dirLight.intensity = env.lightIntensity + env.uFlash.value * 3.2;
    hemisphereLight.color.copy(env.uSkyTop.value);
    hemisphereLight.groundColor.copy(env.uTerrainA.value);
    hemisphereLight.intensity = env.ambient + env.uFlash.value * 0.55;
    rimLight.color.copy(env.uAccent.value);
    rimLight.intensity = 0.25 + env.uFlow.value * 0.32 + env.uFlash.value * 0.7;

    // --- HUD snapshot (throttled) -----------------------------------------
    hudClock.current += dt;
    if (hudClock.current >= HUD_INTERVAL) {
      hudClock.current = 0;
      if (g.phase === "running" || g.phase === "dead") {
        // Mode-aware pressure line: global PB for endless/daily, week best
        // for sprint, the next medal for trials (roadmap 3.5 / 4.1 / 4.2).
        const meta = useMeta.getState();
        // First flight teaches itself inside a real endless run. Demonstrated
        // actions advance immediately via world events; distance fallbacks
        // prevent one missed lesson from trapping the sequence.
        if (g.phase === "running" && g.lesson && !isBenchmarkRun(world)) {
          if (
            g.lesson === "steer" &&
            (Math.abs(world.x - world.courseOffsetAt(world.distance)) > 2.5 ||
              world.distance >= 100)
          ) {
            g.setLesson("graze");
          } else if (g.lesson === "graze" && world.distance >= 300) {
            g.setLesson("boost");
          } else if (g.lesson === "boost" && world.distance >= 480) {
            g.setLesson("rhythm");
          } else if (g.lesson === "rhythm" && world.distance >= 600) {
            // The sky cadence guarantees a wedge in the 600–1400 m window.
            g.setLesson("jump");
          } else if (g.lesson === "jump" && world.distance >= 1400) {
            // Distance fallback only — the usual graduation is the first
            // touchdown (see the "land" listener in GameController).
            meta.completeOnboarding();
            g.setLesson(null);
            g.setCallout("FLIGHT SYSTEMS ONLINE", "THE OPEN TRACK IS YOURS");
          }
        }
        const score = Math.floor(world.score);
        let objective: string | null = null;
        let objectiveHit: string | null = null;
        if (world.mode === "sprint") {
          const best = meta.sprintBest[bundle.session.periodKey ?? ""]?.score ?? 0;
          if (score > best) objectiveHit = "NEW WEEKLY BEST";
          else if (best > 0) objective = `WEEK BEST IN ${(best - score).toLocaleString()}`;
        } else if (world.mode === "trial" && world.trialId) {
          const trial = trialById(world.trialId);
          if (trial) {
            const earned = medalFor(trial, world.distance);
            const rank = earned ? MEDAL_RANK[earned] : 0;
            if (rank > medalRank.current && world.status === "running") {
              medalRank.current = rank;
              g.setCallout(`${earned!.toUpperCase()} MEDAL`, trial.name.toUpperCase());
            }
            const next = nextMedalFor(trial, world.distance);
            if (next) {
              const gap = Math.ceil(next.at - world.distance);
              objective = `${next.medal.toUpperCase()} IN ${gap.toLocaleString()} m`;
            } else {
              objectiveHit = "AUTHOR MEDAL CLEARED";
            }
          }
        } else {
          const best = meta.bestScore;
          if (score > best) objectiveHit = "NEW PERSONAL BEST";
          else if (best > 0) objective = `PB IN ${(best - score).toLocaleString()}`;
        }
        g.setHud({
          score,
          multiplier: world.flowMultiplier,
          flowTier: world.flowTier,
          flowFrac: (world.flowPoints % 5) / 5,
          flowGrace: world.flowGraceRemaining,
          flowChain: world.flowChain,
          shardCombo: world.shardCombo,
          energy: world.energy,
          boosting: world.boosting,
          shield: world.hasShield,
          speedKmh: Math.round(world.speed * 3.6),
          distance: Math.floor(world.distance),
          biome: env.biomeLabelAt(world.distance),
          objective,
          objectiveHit,
          timeLeft: world.timeLimit > 0 ? Math.max(0, world.timeLimit - world.time) : null,
          heatMult: world.heatFx.scoreMult,
          lab: world.stats.lab,
          surge: world.surgeTimer > 0,
          dash: world.labFx.dash ? world.dashCooldown : null,
          ghostDelta: showGhost ? ghost.deltaTo(world.distance) : null,
        });
      }

    }
  });

  return (
    <>
      <PerformanceMonitor tier={tier} />
      <primitive object={dirLight} />
      <primitive object={dirLight.target} />
      <primitive object={hemisphereLight} />
      <primitive object={rimLight} />
      <primitive object={rimLight.target} />
      <SkyDome detail={quality.skyDetail} />
      <Terrain segments={quality.terrainSegments} />
      {quality.reflections && <Ocean resolutionScale={quality.reflectionScale} />}
      <HorizonLandmarks />
      <Decor />
      <ObstacleField shadows={quality.shadows} />
      <Pickups />
      <Craft />
      <SkyAids />
      <Ghost />
      <Particles max={quality.maxParticles} />
      <Lightning />
      <CameraRig />
      <PostFX
        aa={quality.aa}
        bloomQuality={quality.bloomQuality}
        bloomResolutionScale={quality.bloomResolutionScale}
        msaaSamples={quality.msaaSamples}
        premiumPost={quality.premiumPost}
      />
    </>
  );
}
