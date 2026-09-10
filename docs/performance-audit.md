# Performance and resource audit

Audit date: September 10, 2026.

The game already has a sound simulation and rendering foundation. The main waste came from work continuing when play had stopped, repeated calculations and allocations in frequently executed loops, and graphics effects doing more work than their visible result required. This change addresses those costs while preserving the course, collision rules, visual presets, and replay format.

The improvements below describe work removed from the program. They do not imply a universal FPS increase, battery saving, or reduction in watts. Those outcomes depend on the device, display refresh rate, quality preset, browser backend, and which part of a frame limits performance.

## Scope and existing strengths

The first-party source footprint at review was approximately 23,000 lines across 95 TypeScript, JavaScript, and stylesheet files. The audit covered the application entry points, game/controller lifecycle, input, simulation and entity pools, course generation and validation, replay/ghost execution, render components and shaders, audio, state subscriptions, HUD/mobile controls, and supporting profiling and verification paths. Competition and replay checks were considered when evaluating changes that could alter deterministic outcomes.

Installed Next.js client-boundary documentation and the relevant Three.js, React Three Fiber, and Tone.js implementation details were inspected where the changes depend on their actual behavior. This was a first-party performance audit, not a comprehensive audit of all dependency source code or a completed physical-device power study.

Several existing design choices are worth retaining:

- The simulation uses fixed steps with rendering interpolation and deterministic replay verification. Rendering fewer frames need not change the simulation's rules.
- Obstacles and pickups already use bounded entity pools and instanced rendering. This avoids a separate draw call and React component for every obstacle.
- The streaming horizon has a fixed maximum. High speed cannot grow the visible world indefinitely.
- Trail history already uses a bounded ring buffer and simulation-time sampling.
- Most render animation uses frame callbacks and reusable Three.js objects, rather than per-frame React state updates.
- The HUD already samples gameplay state at 12 Hz. GPU queries and diagnostic histories are bounded and asynchronous.
- Dynamic resolution, quality presets, reflection visibility gating, depth-of-field gating, and explicit post-effect/shadow disposal already exist. The new changes build on those protections.

## Findings and implemented changes

### 1. Stop rendering scenes that have stopped changing

**Finding.** The canvas previously ran continuously across title, pause, and result screens. A stationary scene still executes scene callbacks, submits geometry, and runs post-processing. On a high-refresh display, an animated menu can also request substantially more frames than its slow motion needs.

**Change.** `GameCanvas.tsx` and `FrameScheduler.tsx` now distinguish active play from idle UI:

| State | Rendering behavior |
| --- | --- |
| Running or crash presentation | Continuous rendering at the available display cadence |
| Title | Animated scene refreshed at approximately 30 Hz |
| Pause or completed result | Render on demand for changes and shortcuts |
| Hidden document | Frame loop stopped |

Settings, focus, and keyboard shortcuts can wake a frozen scene. A connected gamepad is polled at 20 Hz on frozen screens so its resume/retry buttons work without rendering speculative frames. The timers and event subscriptions are removed when their phase or visibility condition changes.

`GameScene.tsx` discards elapsed idle time when an input shortcut resumes play inside a demand frame. React Three Fiber resets its clock when the frame-loop mode changes, covering UI-driven resume. These protections prevent a long pause from turning into a large movement step or immediately triggering the long-stall pause guard.

The performance monitor also separates title and gameplay measurement windows and excludes the deliberately slower title cadence from dynamic-resolution decisions. A 30 Hz menu should not convince the game to lower gameplay resolution.

### 2. Reduce graphics work without changing the authored effects

**Sky overdraw.** The procedural sky contains multiple noise layers. It previously rendered first, including pixels that terrain and obstacles would immediately cover. The sky now renders after opaque scenery, with depth testing enabled and depth writes disabled. Existing depth can reject covered sky pixels. Transparent water, glass, and particles still render afterward; the same ordering applies in the reflection view.

**Inactive storm shading.** Storm-cloud noise previously ran even when the storm biome weight was zero. A uniform shader branch now skips those noise octaves outside storm sectors. Any nonzero transition weight retains the original calculation.

**Bloom sampling.** `efficientBloom.ts` preserves Three.js's five mip levels, Gaussian coefficients, render targets, and disposal ownership. Adjacent Gaussian samples are combined through linear texture filtering where input and output grids match. The first horizontal pass and all vertical passes use paired taps. Later horizontal passes downsample another mip, so they retain the original separate taps. The focused convolution tests include odd widths and clamped edges.

This reduces texture fetches in the applicable passes; it does not eliminate the bloom pass chain or establish a fixed GPU-time percentage. The wrapper intentionally isolates its dependency on Three.js r185's internal bloom material factory. That boundary needs revalidation on Three.js upgrades.

### 3. Upload and iterate only the instances that are alive

**Finding.** Instanced pools reserve enough capacity for demanding scenes, but the renderer marked their full buffers dirty even when only a small prefix was used. The particle loop also scanned its entire capacity on every frame.

**Change.** `instanceUpdates.ts` marks the active prefix of each rewritten matrix/data buffer. Empty pools request no upload. The helper is used for obstacles, scenery, landmarks, pickups, lightning, and particles. The installed WebGPU and WebGL2 backends both consume these update ranges.

`ParticlePool.ts` retains bounded ring-buffer replacement while maintaining a dense list of living particles. Expiration removes entries by swapping in the last live entry; the loop visits that swapped entry before advancing. The particle count, emission rates, lifetime formulas, and capacity limits remain unchanged. Additive particle blending does not require the former pool-index order.

Particles also reuse their magnetic-pickup selection array and spawn defaults. Pickup lighting updates its existing position directly instead of allocating a temporary nearest-shield record. Craft light/trail anchors now update the hull transform once without recursively updating all its children twice before the renderer does its own traversal.

### 4. Reuse deterministic scenery descriptions

**Finding.** Ground decorations, floating scenery, and horizon landmarks are deterministic functions of their track slot. They nevertheless rebuilt hashes, objects, and nested arrays on every frame.

**Change.** `SlotCache.ts` provides fixed-capacity caches for those recipes. `Decor.tsx` and `HorizonLandmarks.tsx` create a descriptor when its slot first enters the cache and reuse it across frames. Motion, bobbing, materialization, and course placement still update normally.

The capacity covers the maximum contiguous visible slot window. A retry, negative startup slot, large distance jump, or long run cannot create an ever-growing cache. Focused tests exercise these cases and confirm that repeatedly rendering the same window does not recreate descriptors.

### 5. Avoid unnecessary simulation and generator calculations

**Obstacle broad phase.** Distant obstacles no longer pay for exact yaw-projected collision extents on every fixed step. A conservative `hx + hs` bound filters candidates before the original exact calculation. Despawn checks similarly avoid motion-envelope calculations while an obstacle's center is still ahead of the recycling threshold. Nearby and unusually long/rotating/orbiting obstacles retain their exact checks.

**Pickups.** Non-seeking pickups outside the maximum interaction radius skip lateral/vertical distance work. Seeking shards continue tracking the craft after it passes them.

**Route decisions.** Route-choice resolution and cleanup no longer create a temporary Set and filtered arrays every fixed step. The replacement keeps the original sibling order and tie behavior.

**Course validation.** Each raster slice's course-center offset is calculated once per validation, and each obstacle's offset once per obstacle. This replaces repeated sampling inside every covered obstacle/slice pair. A pre-change course fingerprint checks the exact generated output, including geometry, pickups, path validation, and RNG-dependent fallback behavior.

**Hidden ghosts.** A ghost that the player has disabled no longer runs a second simulation every frame. Re-enabling it uses the existing bounded catch-up budget. Its pose and distance delta stay hidden until it has caught up, avoiding a stale ghost suddenly appearing at the wrong point. Very long catch-up remains a possible visible delay and is a follow-up candidate below.

### 6. Let the audio engine sleep and clean up fully

**Finding.** Lowering a music bus gain does not stop scheduled instruments, effects, or an audio clock. The original engine also lacked comprehensive teardown for its synthesizers, effects, sends, and transport events.

**Change.** The audio engine now owns and disposes the resources it creates. An initialization generation guard prevents an obsolete asynchronous initialization from completing after teardown. Game phase changes pause the transport, and hidden documents or loss of window focus suspend the native audio context immediately. Explicit pause and idle screens allow four seconds for reverb/UI sounds to finish before suspension.

Muted music and inaudible stems skip unnecessary note triggers. Adaptive mixing runs at 30 Hz, reuses its gain list, and avoids tiny repeated bass-envelope updates. Event-driven effects remain event-driven. Gesture-based resume, mute/unmute, pause, background, and teardown behavior require browser verification because native audio policies are outside headless simulation tests.

Tone's lightweight scheduling worker still wakes approximately 40 times per second while its native audio graph is suspended. Slowing that worker caused up to a one-second music-resume delay, and switching its clock source would create unreleased worker Blob URLs in the installed Tone version. The change therefore suspends native audio processing while retaining the existing worker cadence. Eliminating that remaining idle JavaScript wakeup needs a separately verified Tone lifecycle fix.

### 7. Narrow React subscriptions and background UI polling

The HUD's gameplay readout, performance diagnostics, and transient feedback now subscribe independently. Optional diagnostics no longer force unrelated HUD sections to rerender, and memoized feedback/mobile controls avoid being rebuilt with every gameplay snapshot. Diagnostics are also available on the title when explicitly enabled, which makes menu resource behavior inspectable.

The tilt calibration preview now runs only for the applicable mobile UI and stops polling while the document is hidden. The preview resumes on visibility changes and removes its timer/listener on cleanup.

## Headless CPU measurements

These medians compare the pre-change and optimized code on the same local machine: Apple M4 Max, Node.js 22.23.0, macOS 26.6.2.

| Workload | Before | After | Median elapsed-time reduction |
| --- | ---: | ---: | ---: |
| Full fixed-input sprint replay simulation | 345.112 ms | 297.255 ms | 13.9% |
| Generate 15,000 m of seeded course and calculate its output fingerprint | 12.612 ms | 11.494 ms | 8.9% |

The simulation benchmark warms four runs and takes the median of 15 measured runs. Generation measures ten runs and omits the first two from its median. The generator measurement includes serialization and hashing; it is not an isolated generator-only timer. The baseline is commit `28cf758`; the replay fixture contains 21,600 fixed ticks. The reproduction command is:

```sh
npx tsx scripts/coreperftest.ts --benchmark
```

These are CPU throughput measurements without a browser renderer, audio graph, DOM, or presentation timing. They support the simulation/generator changes; they do not measure whole-game FPS or GPU/power savings. Use operation-budget and deterministic-output assertions for regression checks, rather than making tests depend on these machine-specific durations.

## Production measurements and verification

The production captures used Chromium 153.0.8010.12 on the same Apple M4 Max,
1440 × 900 logical pixels, device DPR 2, High quality, and the native approximately
60 Hz browser animation cadence. Motion, flashes and standard contrast remained
enabled. Each capture warmed for five seconds and measured 60 seconds of the same
recorded route. No other browser GPU test ran concurrently with these captures.

| Backend / build | CPU submission mean | Sampled GPU mean / p95 | Frame p95 / p99 | Effective DPR range |
| --- | ---: | ---: | ---: | ---: |
| WebGPU before | 2.37 ms | 15.61 / 21.9 ms | 17.5 / 17.8 ms | 1.8–2.0 |
| WebGPU after | 2.08 ms | 10.85 / 18.3 ms | 17.4 / 17.8 ms | 2.0 |
| WebGL2 before | 2.20 ms | 17.20 / 20.5 ms | 17.5 / 17.7 ms | 1.7–1.8 |
| WebGL2 after | 2.05 ms | 17.25 / 21.0 ms | 17.5 / 17.8 ms | 1.8–2.0 |

WebGPU's summed render-pass timestamp mean was 30.5% lower while retaining full DPR 2 throughout
the optimized capture. WebGL2 used the recovered headroom for higher resolution;
its total sampled GPU time stayed approximately unchanged. These are observations
with the normal dynamic-resolution controller enabled, not comparisons at a
locked internal resolution. WebGL2 High remains a performance target: its GPU
mean is still above the 16.7 ms budget of a 60 Hz display.

The four captures took 231–233 GPU samples each, crossed Crystal Desert and
Digital Ocean, and reached approximately 2,638 m with 136 active obstacles at
peak. Both WebGPU captures consumed exactly 7,792 identical recorded ticks;
WebGL2 differed by one tick (7,791 before, 7,792 after). All completed with zero
automatic pause resumes and zero recorded runtime/render errors. WebGPU reports
individual named passes; WebGL2 reports an aggregate elapsed query. Nearly
unchanged 60 Hz callback cadence does not establish a displayed-FPS increase.
Three.js adds individual WebGPU pass durations without checking raw timestamp
intervals for overlap. This metric is useful for the comparison, but it is not a
verified exclusive GPU busy-time or energy measurement.

Raw reports and a compact comparison are retained locally under
`artifacts/performance-audit/` (ignored by Git): `before-webgpu.json`,
`after-webgpu.json`, `before-webgl2.json`, `after-webgl2.json`, and `comparison.json`.
For example, reproduce an optimized capture with:

```sh
npm run build
npm run profile -- --backend webgpu --quality high --dpr 2 --seconds 60 --warmup 5 --output artifacts/performance-audit/after-webgpu.json
```

These are single local before/after observations, not repeated thermal trials,
power measurements, or representative phone results. The measured route segment
does not establish late storm/void performance. Background host load and GPU clock
variation can affect the timings; the deterministic work-budget regressions
provide separate evidence that the changes remove operations.

Verification completed on the optimized production build:

- All headless game, frontier, graphics, session, exact world/replay fingerprint,
  core performance, mobile input, course/fairness, competition and profiling
  suites pass. Production build, TypeScript and lint pass.
- All 26 production browser scenarios were verified across real WebGPU and
  forced WebGL2. The full run passed 25; the remaining mobile sensor test exposed
  a race in its mock, where an old-orientation sample could arrive after rotating
  the simulated screen. After stopping that old sample timer before rotation,
  the focused test passed on both backends. Production steering code was unchanged.
- New checks verify the title's approximately 30 Hz rendering, frozen paused and
  result frames, keyboard resume after a long pause, and the polled gamepad resume
  path using a virtual controller.
- Native audio contexts suspend after idle tails and immediately after real
  focus loss; their audio clocks stop advancing while suspended. Focus return
  stays silent until interaction. Hidden/visible event handling is also covered
  with an explicitly simulated visibility state, since headless Chromium can
  report a blurred page as still visible. These are not physical phone tests.
- Repeated Low → High → Low → High → Low switches returned tracked texture
  counts to **19 → 39 → 19 → 39 → 19** on both backends at device DPR 1 and 2.
  The two additional DPR 2 resource checks both pass, for 28 verified browser cases.
  High retains its crash depth-of-field passes, and retry disables those passes.
- Inspected screenshots show intact sky/terrain occlusion, reflections, neon
  edges, ship trails and crash fragments on both backends. This visual check
  covers the opening biome; later biome visuals remain part of broader device QA.

The full browser report and corrected sensor rerun are retained as
`artifacts/performance-audit/browser-suite.json` and `mobile-rerun.json`;
the higher-density checks are in `dpr2-browser.json` alongside them.

## Ranked follow-up work

The next experiments should follow production profiles, especially sustained captures across the four biomes. The ordering below balances likely resource impact, implementation cost, and risk to responsiveness or visuals.

| Priority | Experiment | Expected benefit and tradeoff | Required validation |
| --- | --- | --- | --- |
| 1 | Offer a 60 FPS resource-saving cap, with high-refresh rendering as an explicit option | Avoid submitting 120–240 complete frames each second when the player prefers lower resource use. A cap changes presentation latency and motion smoothness, so it should be a clear preference rather than a silent quality downgrade. | Keep simulation at its fixed tick rate; verify short input taps, replay identity, controller resume, frame pacing, and input feel at 60/120/144/240 Hz. Measure power or sustained thermal behavior on actual hardware. |
| 2 | Profile terrain height/normal evaluation and prototype vertex-computed normals | The terrain's finite-difference normal uses an expensive height function in fragment shading. Moving appropriate work to vertices or a sampled field could reduce a large screen-area cost. It may soften ridge detail, affect specular lighting, or reveal mesh resolution. | Attribute GPU cost first. Compare road boundaries, bends, mountains, ocean transitions, and lighting at all presets, viewing angles, and representative DPRs. Keep the course/collision alignment exact. |
| 3 | Add a cheaper bloom implementation for resource-saving presets if bloom remains expensive | A smaller mip pyramid or a different blur scheme can reduce pass count beyond paired taps. It changes the glow footprint and possibly high-intensity stability. | Compare small distant hazards, bright rings, lightning, crash effects, and transitions. Check both backends, render-target counts over repeated tier switches, and measured GPU savings at matched main-scene resolution. |
| 4 | Bake ghost poses in a worker or retain a bounded pose track | Avoid running a second full simulation on the main thread and reduce catch-up delay after enabling a ghost. Adds worker startup, transfer/storage cost, replay-version invalidation, and ownership complexity. | Verify exact replay compatibility, interpolation and end-of-run markers, cancellation on retries, memory limits, and main-thread frame tails while baking. Keep production scoring isolated from the worker result. |
| 5 | Maintain stable live obstacle/pickup lists | Avoid scanning unused entity-pool capacity in simulation and rendering. Current conservative bounds reduce calculations but do not eliminate every pool scan. Updating lists during spawn/recycle adds bookkeeping. | Preserve order wherever event ordering or ties affect results. Verify exact course/replay fingerprints, moving-obstacle recycling, collision outcomes, and bounded list membership under long runs and retries. |
| 6 | Share the terrain/ocean course sample grid | Both components sample the same 1,700 m course span at the same row spacing. A shared buffer could avoid duplicate course queries when reflections are enabled. The expected gain is smaller than reducing fragment work. | Define one update owner; test seeded-course changes, trial flat tracks, ambient/title motion, quality switches, and mismatched future geometry dimensions. |
| 7 | Cache slowly changing sky layers | Render nebula/aurora layers to a smaller texture or update them less often while retaining sharper stars and the sun separately. Could reduce repeated multi-octave noise work, particularly on lower presets. | Check temporal stepping, parallax, seams, color transitions, flash response, extra texture memory, and reflection consistency. Compare against the new depth-rejected sky before accepting the complexity. |

Additional opportunities should be justified by profiles: fixed transforms on decorative meshes, material variants with fewer lighting features, coarser distant geometry, or slower reflection updates can help particular devices, but each can change appearance. Changing many of them together would make it difficult to identify which improvement actually pays for its visual cost.

Most gameplay memory is already bounded, but section statistics and route-choice
history still grow with run length. Extremely long sessions should be included in
heap captures. Any history compaction must preserve progression, run reports and
replay evidence; applying an arbitrary cap would change those features.

The installed Three.js WebGPU backend can also retain timestamp-write descriptors
on its cached canvas pass after tracking is disabled. Offscreen descriptors reset
normally. A focused adapter regression should verify and clear that stale state
before claiming that every unsampled frame issues no GPU timestamp writes; the
current readback queue and retained application histories remain bounded.

## Measuring the next iteration

Use the production build and the existing capture workflow in `docs/profiling.md`. Compare the same route, backend, preset, DPR, display refresh setting, warm-up, and duration. Record frame tails, CPU submission time, available GPU timing, draw calls, texture counts, and dynamic-resolution scale together. A slower-looking frame average can be an intentional cap; a faster-looking average can be reduced resolution or different scene coverage.

Include visible title, paused/result, hidden-tab, active flight, ocean/reflection, storm, crash/retry, and repeated quality-change cases. Run longer captures on integrated graphics and actual phones to expose sustained behavior that a brief run on an M4 Max cannot establish. Browser emulation of a phone viewport changes the pixel workload but does not reproduce its processor, battery, or thermal limits.

Measure power separately when making energy claims. The browser's GPU/CPU timers and reduced operation counts are useful evidence about work, but they are not wattmeters.
