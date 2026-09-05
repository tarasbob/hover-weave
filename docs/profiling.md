# Sustained rendering and human playtest captures

The diagnostic capture is available in production at `/?profile=1` (append
`&gl=webgl` to require WebGL2). It runs only after a person or runner starts it.
No measurements or observations upload to a server. Export JSON from the small
**Performance & playtest capture** panel, or use the browser console API below.
Normal visits have no diagnostic UI, input observer or active capture.

## Reproducible automated route

Build once, then run the production browser capture. The runner starts and owns a
production server on port 3110 when `--url` is omitted. It saves JSON and exits
nonzero on incomplete duration, route divergence, runtime errors, missing biome
coverage, or a backend that does not match the request.

```sh
npm run build
npx tsx scripts/profile.ts --backend webgpu --quality high --dpr 2 --seconds 120 --output test-results/profile-webgpu-high-dpr2.json
npx tsx scripts/profile.ts --backend webgl2 --quality high --dpr 2 --seconds 120 --output test-results/profile-webgl2-high-dpr2.json
npx tsx scripts/profile.ts --backend webgpu --quality auto --seconds 600 --label "Device model; battery; room temperature" --output test-results/profile-thermal.json
```

Use `--headed` for a visible local browser, `--url http://host:port` for an
already running production build, and `--warmup 10` (default) to omit initial
active seconds from aggregate timings. The capture length is 60–900 measured
active seconds; the panel provides 2-minute and 10-minute choices. Pause and
background intervals are counted separately. The runner records each resume
from a stall/focus pause; compare elapsed and active duration before treating a
capture as an uninterrupted thermal trial. The frame that causes a long-stall
pause remains in the measured frame-tail distribution.

The versioned route is `dense-biomes-v1`, seed `render-route-v1-17`: a genuine
140-second, 7,435 m endless recording. The original pilot remained alive through
four biomes and 18 generated pattern IDs, with up to 161 active obstacle pool
entries. A longer capture repeats that complete route. There is no invulnerability,
teleporting, altered speed, removed obstacle, browser clock mocking, or online
pilot computation. Real fixed inputs are applied at 120 Hz under native RAF;
render interpolation uses the fixed-step replay pose. Time-kiss presentation
still affects how quickly the route advances in wall time. A two-minute capture
therefore reports its actual distance and biome coverage instead of assuming it
reached the fixture's end. The route resets at its natural recording boundary,
which is visible in long-run series.

The route is synthetic input, not a human performance, and its survivor line is
not claimed to be optimal. Reproduce the input fixture only when the engine or
replay version requires a new benchmark baseline:

```sh
npx tsx scripts/profile-route.ts
npx tsx tests/profiling/profile.test.ts
npm run build
npx playwright test tests/profiling/runtime.spec.ts
```

Keep old capture files with their replay version and route identity when rebaking;
a new route is a different benchmark. The unit check confirms exact full-route
state at 30/60/144/240 Hz and checks repeated-route resets. Browser checks ensure
ordinary visits remain opt-in, benchmarks cannot update saved progress, and
switching from a benchmark to human capture clears the simulated benchmark run.

## Physical devices and the hardware matrix

Use the same production build and repeat each device/quality/backend cell at
least three times. Suggested cells are an integrated/low-power desktop GPU,
an actual midrange Android phone, and an actual iPhone, with Auto and Low on
phones and High where usable. WebGPU and WebGL2 are separate results; record
unsupported backends instead of counting a fallback as a pass.

1. Record exact device model, OS/browser versions, battery/charger state, power
   mode, display refresh setting, approximate room temperature, and build/commit.
   Close unrelated heavy applications and record any remaining background load.
2. Let the device cool to the same starting condition. Open the production URL
   on the device, add `?profile=1`, select quality, enter the device label, and
   tap **Start route**. Keep the app foreground and display awake.
3. First capture 2 minutes. Then cool down again and capture 10 minutes for
   sustained behavior. Add observed heat, dimming, input interruptions and
   throttling symptoms through **Add observation**. Do not change power or
   quality partway through the comparison run.
4. Export JSON on the device using **Export JSON**. Repeat each cell. Compare
   the initial/middle/final per-second `series` frame/CPU/GPU values, DPR/DRS,
   obstacle density and biome. Compare like route segments across the repeated
   loops; a denser biome alone can explain a later slowdown.
5. Record crash/stall/fallback failures and inaccessible controls as failures,
   with the conditions. Do not hide them by excluding slow samples.

Browser APIs do not reliably expose chip temperature or power draw. The capture
supports thermal *behavior* comparisons; it does not directly measure temperature,
and one local powerful GPU does not complete this matrix. Desktop viewport/DPR
emulation changes rendering workload but never stands in for physical-phone
hardware. Until actual artifacts exist, those matrix cells remain unvalidated.

Android Chrome can also be driven through its authorized remote-debugging CDP
connection. Supply the real device's forwarded endpoint and a production URL
reachable from that device:

```sh
npx tsx scripts/profile.ts --cdp http://127.0.0.1:9222 --url https://reachable-production-host.example --backend webgl2 --quality auto --seconds 600 --label "Actual phone model; OS; battery/power" --output test-results/actual-phone-auto.json
```

The connected-device runner uses the existing context without resizing its
viewport or DPR. It opens and closes its own page. The operator must establish
and identify the actual hardware connection. A CDP endpoint alone is not proof
of physical hardware. iPhone Safari uses the on-device panel and export; this
Chromium runner does not claim to automate Safari.

## Human playtest procedure

Use the same diagnostic URL. Select **Capture human play**, then launch and play
normally. Stopping a benchmark returns to the flight deck and freezes its measured
metadata. Post-capture observations remain exportable. Human capture observes ordinary controls and progression; it does not
supply pilot inputs. Starting human capture after a benchmark returns to the
flight deck, so benchmark-earned state cannot become a saved player run. A
human capture may include several ordinary retries. Stop and export at the end.
Use an anonymous participant identifier in the device label and observations.

An observer should ask the participant to play without instruction, then record:

- When the first meaningful choice was noticed and what choices the player saw.
  The engine records explicit route-choice events, which cover only one category
  of meaningful decisions. Record other choices as timed observations.
- Each death before the participant can explain basic steering and the cause of
  their first mistake. A steering key event is not proof of understanding.
- Whether a near miss was intentional, whether the player can repeat one, and
  whether they voluntarily choose another attempt. The event log records the
  real graze/death/run-start timestamps; intent needs observation.
- What the player says they learned, perceived control delay, readability,
  discomfort, device/control method, accessibility needs, and any control they
  could not use. Test keyboard, touch and relevant accessibility settings.

Compare participants on several identical seeds only when the study calls for
it; record each ordinary launch's real seed in `playtest.events` to inspect
seed-to-seed survival spread. Do not turn synthetic pilots into satisfaction,
retention, learning or accessibility claims.

## Export contract and measurement limits

The JSON root has `format: "hover-weave-profile"`, `version: 1`, options,
metadata, route identity, measurements, coverage, a per-second series, a bounded
playtest event log and explicit discarded counts. The runner adds browser
version, native-clock checks, resume count and errors around that report.

- **Frame:** all measured rendered frames contribute to full-capture mean,
  P50/P95/P99, max, and counts above 16.67/33.33 ms. A fixed-size 0.1 ms histogram
  bounds memory; beyond 1000 ms, affected quantiles conservatively use the
  observed maximum. These are not percentiles of HUD percentiles.
- **CPU:** scene callbacks through render submission. Browser work outside that
  interval, GPU work, and the capture hook's own overhead are excluded. Profiling
  itself adds overhead, so compare with the same enabled instrumentation.
- **GPU:** fresh completed timestamp readbacks, deduplicated by timestamp.
  `gpuPassCoverage` says `individual`, `aggregate`, or `none`. WebGL2 generally
  supports a single outer elapsed query; nested pass *submission labels* are
  listed separately and must not be treated as independently timed passes.
  WebGPU individual pass timings can locate post/reflection costs. Unavailable
  timings stay null/empty, never zero. RAF cadence is not completed GPU throughput.
- **Input:** trusted gameplay key/pointer events through the next observed
  simulation tick and its render submission, using native event timestamps.
  These are CPU-side upper bounds; they do not prove the exact tick consumed an
  edge and do not measure input-to-photon latency. Gamepad snapshot timing and
  display scanout require external equipment. Touch movement/crossing events are
  not included; the observer currently measures pointer down/up edges. Automated route captures have no
  human latency samples.
- **Memory:** aggregate histograms stay fixed in size; capture length is capped
  at 900 measured seconds, series at 900 entries, event log at 2000 entries,
  pending inputs at 512, pass groups at 64 and observations at 32. Overflow is
  reported. Captures remain in memory until replaced or the page closes.

Console access for an already loaded diagnostic page:

```js
await window.__HOVER_PROFILE__.start({ kind: "benchmark", seconds: 120, warmupSeconds: 10, quality: "high", label: "Device and test conditions" });
window.__HOVER_PROFILE__.snapshot();
window.__HOVER_PROFILE__.note("Device felt warm after the second loop");
window.__HOVER_PROFILE__.stop();
window.__HOVER_PROFILE__.download();
```
