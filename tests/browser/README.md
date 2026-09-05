# Browser smoke tests

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser`. This builds the production bundle, starts an isolated
server on port 3100, and runs the same scenarios on WebGPU and forced WebGL2:

- A new player's first launch and steering lesson.
- Free flight, daily, and sprint selection retained across settings.
- Keyboard pause, frozen sprint timer, settings while paused, and real tab focus loss.
- A natural collision, flight report, and daily-course retry.
- Three seconds of visible ship breakup before the flight report, and lethal
  exits from both track edges with restart shortcuts gated during the crash.
- Phone-sized portrait/landscape setup, motion permission/fallback, proportional
  tilt calibration, safe-area controls, and fullscreen/install guidance.
- Repeated low/high quality changes, live frame measurements, and bounded textures.
- High-quality crash blur runs at death and stops again on retry, verified from
  submitted render passes on both backends.
- The opt-in profiler is absent on ordinary launches; recorded benchmark runs
  cannot award progression or become human practice runs without a fresh launch.

Every test receives a fresh browser context. A Date-only proxy fixes the UTC
date for stable daily and weekly courses; the suite asserts that animation,
performance and event timestamp functions remain native. Physics advances from
that real timing. Tests
use player-facing controls and read-only renderer/phase diagnostics, without
mutating the world or relying on development console handles. Browser exceptions
and renderer validation errors fail the suite. Runs use one worker to avoid GPU
contention; these checks are functional coverage, not performance benchmarks.

The **WebGPU project requires WebGPU** and fails with a clear backend assertion
if Chromium falls back to WebGL. Run it on a machine with a working WebGPU
adapter. For a runner that supports only WebGL2, use
`npm run test:browser -- --project=webgl2`; that result covers only WebGL2 and
does not satisfy the full two-backend gate. The `--enable-unsafe-webgpu` browser
flag permits Chromium's test adapters; it does not bypass the backend assertion
or establish representative hardware performance. Use
`npm run test:browser -- --headed` to exercise a visible browser.

After an existing production build, `npx playwright test` runs without rebuilding.
`npx playwright show-report` opens the HTML report. First-flight and flight-report
screenshots are attached on successful runs; failed tests retain screenshots,
traces, and console diagnostics in `test-results/` and `playwright-report/`.
Machine-readable results and attachments are recorded in `test-results/results.json`.
The quality test attaches Chromium's reported adapter identity and 120-frame
gameplay samples for each tier. These short samples establish functioning
instrumentation and resource cleanup; they are not a representative device
performance certification or a fixed FPS gate.

To exercise resolution scaling on the same desktop GPU after building, run
`BROWSER_DPR=2 npx playwright test --grep 'low and high quality'`. The browser
uses a 1440×900 viewport at device scale 2; the game's quality caps and dynamic
resolution still apply. This is a high-DPI desktop check, not mobile hardware
emulation. Its artifacts are retained separately under `test-results/dpr-2/`
and `playwright-report/dpr-2/`, preserving the default smoke report.
High-DPI profiles omit active-flight screenshots: their readback can stall the
main thread long enough to trigger the game's intentional automatic pause.

Keep `npm test` as the deeper generator, simulation, replay, graphics-budget,
session and versioned world fingerprint gate. Browser smoke tests
complement those checks.

## Verified implementation — September 5, 2026

The production build passed **10 game scenarios**, **2 profiling scenarios**, and
both **DPR-2 quality scenarios** in Chromium 153 on an Apple M4 Max, using actual
WebGPU and forced WebGL2. Repeated Low/High quality changes returned tracked
textures to **19 → 39 → 19 → 39 → 19** on both backends and at both device
densities. The relative non-growth assertion is the regression contract; those
exact counts are observations from this renderer version and machine.

These tests uncovered the asynchronous renderer initialization race, retained
shadow resources and blur textures hidden inside repeated depth-of-field setup.
The corresponding fixes are implemented and covered by the passing suite.
The follow-up skips nine invisible crash-blur passes and limits secondary effect
pixel density while retaining the High-quality scene and AA. GPU samples include
named pass durations on WebGPU; WebGL2 reports aggregate timing and the separate
submitted-pass list. Empty, stale and disjoint readbacks are rejected.

For sustained performance, use `npm run profile -- --seconds 120 --dpr 2` after
building. The ordinary smoke suite intentionally stays short. See
[the profiling guide](../../docs/profiling.md) for the real recorded route,
machine-readable exports, physical-device connections and human-playtest panel.
Lower-powered graphics, actual phones, and sustained thermal behavior on those
devices remain validation work. See
[Engineering verification](../../docs/engineering-verification.md) for the
measurements and remaining acceptance matrix.
