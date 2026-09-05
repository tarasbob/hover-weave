# Engineering verification

## Completed engineering work

The design review's implementation priorities are now in place: deterministic
simulation is composed into typed systems; short action inputs are consumed at
fixed ticks; rendering has bounded CPU/GPU instrumentation and resolution control;
and the production game has repeatable tests for both rendering backends. The
browser suite also verified fixes for renderer initialization and retained shadow
and post-processing resources. The existing visual direction and quality-tier
clarity floors remain intact. Broader device validation is still outstanding.

Shared competitive seasons remain deferred until shared, authoritative results
exist. A season identifier alone would not make local recordings trustworthy.
The expedition proposal remains the next content project after performance
measurements and human playtests can support its scope.

## Simulation and input contracts

`SimWorld` orchestrates each 120 Hz step. The composed systems own entity-pool
allocation/recycling, obstacle motion and contacts, seeded event direction,
and bounded run analysis. Their state views describe only the data each system
needs; they do not depend on React. `scripts/worldtest.ts` contains fingerprints
captured from the original implementation, including event ordering, recordings,
entity pools, trace/forensics, and reused-world resets. Export wall-clock metadata
is excluded from those deterministic fingerprints.

Keyboard and touch boost/dash transitions retain event timestamps. The input
clock maps each render interval onto the simulation interval, including partial
ticks and time dilation. A button changes at most once per physics tick: a tap
shorter than one tick gets a press followed by a release on the next tick. This
retains short actions using the existing replay boolean representation. Already
sampled replay/pilot input follows the original path; replay format stays v7.
Gamepad buttons are sampled because the browser gamepad API provides snapshots,
rather than button transition events. Focus/visibility changes clear pending
input; skipped polls during pause invalidate stale action transitions.

## Automated checks

Run `npm test`, `npx tsc --noEmit`, and `npm run lint` for the deterministic,
generator, pilot, session, graphics and static checks. Graphics tests include
frame-tail accounting, resolution hysteresis across refresh rates, bounded GPU
readback, unsupported/stale timer handling, and offscreen-target disposal.

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser`. It builds production code and starts its own server on
port 3100. Tests use actual controls and a fixed UTC date; they do not expose or
mutate the simulation. They check the initialized backend, real scene submission,
browser exceptions and renderer validation errors. Screenshots, diagnostics and
short timing snapshots are attached to the Playwright report.

A WebGPU-capable runner is required for the full matrix. On a machine that only
supports WebGL2, run `npm run build` and `npx playwright test --project=webgl2`.
That verifies only the fallback backend; it is not a successful WebGPU check.
No software adapter or emulated phone viewport should be labeled as a real phone
or integrated-GPU performance result.

For the same desktop viewport at higher pixel density, run
`BROWSER_DPR=2 npx playwright test -g "bounded render resources"` after building.
This exercises both backends at twice the device pixel ratio; its reports are
kept separately in `playwright-report/dpr-2` and `test-results/dpr-2`.

## Reading performance measurements

Enable **Show FPS** in settings. Frame mean/p95/p99 come from active title/flight
animation callbacks in the most recent 240-frame window, rather than occasional
HUD updates. These measure callback cadence, not completed GPU presentation. Paused
snapshots remain inspectable; resuming starts a fresh window. Frames over 250 ms
are discontinuities that trigger the game's existing pause/startup handling,
and are excluded from the rolling window. Capture a browser performance trace
as well to diagnose startup compilation and long stalls; they are not represented
by the overlay's gameplay percentiles.

CPU time spans the simulation, render updates and complete post-pipeline
submission. GPU time sums the sampled frame's render passes using three's
timestamp queries, including offscreen work. It excludes browser compositing,
presentation waits and CPU work, so it is not the same as displayed frame time.
One sample is requested every 250 ms at most; GPU p95 uses the last 120 valid
samples. Queries never block the animation loop. Unsupported timers display
`unsupported`, failed timers `unavailable`, and absent/stale results remain null.
The adapter clears three's otherwise accumulating per-pass timestamp history
after each readback; aggregate samples remain in bounded application buffers.

Fresh GPU work drives dynamic resolution when available, so a CPU-limited frame
or a low-refresh display does not unnecessarily soften the scene. Without GPU
timestamps the controller uses sustained frame cadence. It waits through startup
and resume, lowers scale in 0.05 steps under sustained pressure, and restores it
more slowly with headroom. The existing per-tier floors remain enforced.

Post-pipeline changes explicitly release scene, bloom, AA, depth-of-field and
implicit render-to-texture targets. three r185 only disposes the final pipeline
material by default; the isolated compatibility helper also releases its implicit
RTT quad materials and every Gaussian blur created by repeated depth-of-field
setup, including objects replaced in its private material. A WeakMap retains
ownership for the effect's lifetime so cleanup also works when a disposed,
compiled graph is reused. Recheck that adapter when updating three. Profiling snapshots include
texture counts by name, making retained render targets distinguishable from
intentional one-time initialization.

Renderer initialization is shared per canvas. R3F can request configuration
again before an asynchronous renderer factory resolves; constructing a second
renderer in that interval leaves its internal depth buffer at the original
canvas dimensions. Backend identity is now published after R3F registers the
renderer. This fixes the WebGPU attachment-size validation errors detected by
the browser suite. Quality-dependent lights also explicitly dispose their
shadow resources because R3F does not own objects supplied as primitives.

## Verification results and remaining device checks

### Local verification on September 5, 2026

All headless suites passed, including exact pre-refactor fingerprints. The final
production build passed all ten browser scenarios on real WebGPU and forced
WebGL2 in Chromium 153 on an Apple M4 Max (Metal 3, non-fallback adapter), at
1440 × 900 and device DPR 1. Native animation, performance and event clocks are
asserted by the harness; only the UTC date is fixed for course identity.

Both backends returned to the same 19 tracked textures on every low-quality
visit in the sequence **19 → 41 → 19 → 41 → 19**. High-quality effects remain
enabled. These short opening-course samples showed frame p95 of 16.8–17.5 ms
on WebGPU and 17.5–17.6 ms on WebGL2. GPU timestamps were available on both;
their small sample counts and variation are insufficient for a device benchmark.
The reports retain raw measurements, hardware details and visual captures.

The two additional DPR-2 quality checks also passed on both backends with the
same stable texture sequence. Low quality capped effective DPR at 1.25; High
adapted to DPR 1.9 / scale 0.95 during the short observations. High-quality GPU
samples were approximately 23 ms on WebGPU and 24.5–33.7 ms on WebGL2, with
sampled p95 around 27–30 ms and 37–38 ms respectively. Those costs warrant
further GPU profiling before promising 60 Hz at retina resolution. Animation
callback cadence near 16.7 ms is not proof that the GPU finishes frames at that
rate. The next performance pass should isolate the high-tier post effects and
reflection costs against a repeatable route, preserving the authored appearance
while reducing unnecessary work.

High-resolution active screenshots can themselves stall the page long enough
to trigger the existing 250 ms auto-pause safeguard. The higher-DPR profiling
path omits those active captures; the default suite retains visual QA images.

### Broader hardware matrix

Collect a production run on each actual target below, recording browser/version,
GPU identity, viewport, device DPR, quality, effective DPR/DRS, backend and thermal
state. Use the same daily course and input route for comparisons. Warm shaders,
then observe at least 60 seconds of active play with shadows/reflections visible,
boost, a dense section and a biome transition. Repeat after sustained play on
phones. Keep desktop and phone results separate.

| Target | Backends | Quality checks |
| --- | --- | --- |
| Desktop GPU | WebGPU and forced WebGL2 | High and low; repeated quality changes |
| Integrated graphics | Each available backend | Auto and low; sustained frame tails |
| Android phone | Each available backend | Auto and low; touch and thermal behavior |
| iPhone | Each available backend | Auto and low; touch and orientation behavior |

A 60 Hz target gives 16.7 ms for each presented frame. Assess tails and visible
hitches as well as averages; do not turn the static graphics cost estimate or a
short browser smoke snapshot into an FPS claim. This repository cannot establish
cross-device performance or visual excellence without that hardware matrix and
human observation.
