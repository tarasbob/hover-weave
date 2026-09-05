# Hover Weave — Thread the Impossible

An endless hovercraft runner for the browser. Race across a procedurally
sequenced alien landscape, weave through impossible gaps at speed, build Flow with
near misses, and chase the daily seeded course.

Built with **Next.js 16**, **React Three Fiber v9**, and **three.js
WebGPURenderer + TSL** — WebGPU where available, automatic WebGL2 fallback
everywhere else. Environments, craft and audio are generated procedurally;
the game requires no authored texture, model or audio asset files.

## Play

- **Steer** — ← → or A / D · left/right screen halves on touch · gamepad
  d-pad / stick. Keyboard and touch hold times are integrated between frames,
  so short steering taps survive render frames with no physics tick.
- **Boost** — hold Shift / Space (second finger on touch). Spends shard
  energy; speed and steering authority follow the same continuous thrust
  charge, so releasing before a bend is a real line-planning decision.
- **Phase Dash Lab** — S / ↓ or a third touch; active only when that unranked
  Lab prototype is enabled.
- **Restart** — R or Enter, instantly.
- **Pause** — Esc or P.

Keyboard and touch boost/dash transitions are also timestamped and consumed at
120 Hz. A sub-tick tap gets a press tick followed by a release tick, preserving
airborne double-jumps and Lab dashes in exact replays. Gamepad controls use the
browser's polled snapshots.

Close, Razor, and Perfect passes build the **Flow multiplier** — tighter
clearance earns more, precision chains raise the payout (and climb a
melody), and Flow decays if you play safe. **Shards** refill boost energy
and build short collection combos. **Shields** (increasingly scarce) forgive
one collision.

A fresh profile launches into a progressive first flight: steering, grazing,
boost, and beat reading are taught one at a time inside the real endless game.
The advanced mode grid appears only after that opening has been flown.
Pilots can also choose **Explore all flight modes** from the flight deck. The
opening now introduces seeded bumper-and-reward choices after the clear launch:
learn to read a route, with forgiving contact before the lethal fields begin.

**The world runs on the beat.** Every mover — crushers, pendulums, rotors,
beams — is phase-locked to the soundtrack's fixed 116 BPM grid, so gaps can
be timed by ear. A Perfect pass landed exactly on the beat grades
**RESONANT** and pays ×1.25. Pattern-family leitmotifs and matching HUD cues
preview challenges several seconds ahead; beyond 20 km, selected movers form
readable 3:2 and 5:4 polyrhythms.

**The sky is track.** Glowing **skyhook ramps** arrive from the first
kilometre and keep coming (the generator guarantees one every few hundred
meters): boost into the lip to fly far, carve into it to jump diagonally,
steer (thinly) mid-air, and **hold boost to dive** — trading altitude for
speed while a live landing reticle drags across the ground. **Tap boost
mid-air to double jump**: one impulse per flight, strongest exactly at the
arc's apex — tap, *beat*, tap. One opposite flick just before touchdown
**flares** the landing: a perfect flare keeps all the dive speed as a
decaying rush and pays out (on the beat: RESONANT). Un-dived arcs always
land clean, even double-jumped ones; unflared dives slam. Every jump stays
optional — a validated ground line always exists — but the air pays:
overflying dense fields keeps the engaged score stream alive, air rings and
shard arcs line the flight paths, and apex-jump **crowns** wait above the
kicker lines.

**Daily Course** runs the same seed for every player each UTC day, with its
own personal best. Distance, flow streaks, lifetime totals and daily play
unlock craft designs and trail cosmetics — skill only, nothing for sale.

Every run is recorded (a few KB of input, replayed bit-exactly by the
deterministic sim): a **spectral PB ghost** races beside you — line-for-line
on the daily, best-run pace on endless — and death opens a scrubbable
**kill-cam** showing your flown line against the generator's proven safe
path, plus per-section S/A/B/C line grades and repeat-death notes.

**Trials** report every run as a percentage of the automated **reference
distance** on that exact seed. The compound **Weaver Circuit** links precision,
rhythm, and state-dependent refuel/flow/tempo forks into one course. Fixed-seed
trial results drive Pilot Rating; random endless seed luck does not. The
**Lab** hosts unranked physics prototypes; the current headline is
**Carve Physics**: flick taps that bite harder, pump reversals that rebound
a full carve past the steering cap into a glide, and track edges that kiss
back. Pump payout scales continuously with reversal quality. Gamepads get
skill-graded rumble.

The post-run technique sheet identifies the next weakest skill. Complete
recordings export as shareable `.flight` files with an automatically selected
witness window; importing one starts an unranked ghost race on its exact
course. Rare audiovisual zones wait at 20, 40, and 80 km.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # all headless game, frontier, graphics, session and world checks
npm run build    # production build (deploys to Vercel as-is)
```

Useful dev tools:

- `npx tsx scripts/simtest.ts` — headless autopilot runs + determinism check
- `npx tsx scripts/gentest.ts` — pattern validation rates and generation mix
- `npm run test:frontier` — constrained synthetic cohorts + anti-macro/Carve verdict
- `npm run test:graphics` — render budgets, frame/GPU timing, resolution control,
  trail/geometry invariants and post-processing resource ownership
- `npm run test:session` — UTC course identity, exact fixed-course retries,
  focus/input cleanup and steering/boost/dash playback at 30/60/144/240 Hz
- `npm run test:world` — exact pre-refactor simulation, event, entity-pool,
  analysis and replay fingerprints
- `npx playwright install chromium` — install the browser used by the smoke suite
- `npm run test:browser` — production browser smoke tests for WebGPU and forced
  WebGL2, including first launch, settings, pause/focus loss, death/retry and
  quality changes; a WebGPU fallback fails the WebGPU project explicitly
- `BROWSER_DPR=2 npx playwright test -g "bounded render resources"` — after a
  production build, repeat the quality/resource checks at higher desktop density
- `?gl=webgl` URL param — force the WebGL2 backend

See [the design and engineering review](docs/game-design-review.md) for the
current assessment, completed polish and engineering work, rating recommendations,
and the proposed three-sector expedition mode. The current Pilot Rating is a
local practice estimate, not an online competitive rank. Replay format v7 rejects older
recordings because opening encounters changed; earned cosmetics and progression
remain available.
The subsequent simulation refactor and action-input fixes preserve v7 playback;
they do not invalidate existing v7 recordings.

## Architecture

The simulation is plain TypeScript stepped at a fixed 120 Hz, fully decoupled
from rendering; React/R3F is a view layer reading interpolated sim state.

- `src/game/core/` — sim world, steering physics (including skyhook flight:
  ride/launch/double-jump/dive/flare with geometry-conditional vertical
  state), collision, input, events
- `src/game/core/simulation/` — composed entity pools, obstacle motion/contact,
  seeded event direction, and run analysis; `SimWorld` owns fixed-step ordering
  and gameplay state, with narrow typed interfaces between systems
- `src/game/track/` — 41 handcrafted generators plus a compound circuit (including long
  "chaos field" free-navigation scatter sections), a post-build mutator
  pipeline (mirroring, extra scatter, rhythm jitter, mover speed-ups) that
  keeps layouts unpredictable across runs, a challenge director that rotates
  precision/rhythm/reaction peaks with short recovery beats, state-dependent
  route lattices, biome/mythic-zone definitions, and a
  lane-reachability validator that proves every generated chunk — including
  every mutation — has a flyable path (worst-case envelopes for all moving
  obstacles) before it is accepted
- `src/game/render/` — R3F components; all materials are TSL node materials
  (biome-specific terrain circuits and skies, horizon megastructures,
  planar-reflection ocean, reactive premium materials, pooled spectacle
  particles and lightning, selective bloom, cinematic grading, depth moments,
  chromatic aberration, vignette, grain, FXAA/SMAA)
- `src/game/audio/` — Tone.js generative music director (layered stems mixed
  by speed and flow tier) and synthesized SFX
- `src/game/state/` — Zustand stores (transient game state; persisted
  settings and progression)
- `src/ui/` — HUD and menu screens (Tailwind v4 + motion)

Quality tiers (auto-detected via `detect-gpu`, overridable in settings) gate
shadows, sky detail, reflection and bloom resolution, premium post, particle
counts, AA mode and terrain density. A dynamic resolution scaler also reduces
secondary effect resolution while preserving the high-tier clarity floor.
The optional FPS overlay samples every frame into bounded windows and exposes
frame-time mean/p95/p99, CPU submission time for the complete frame, sampled GPU
render-pass time and p95 where supported, effective DPR/DRS, and render counts.
GPU queries resolve asynchronously, with only one readback in flight. Unsupported
or unavailable GPU timing is reported explicitly. The resolution controller uses
fresh GPU timing when available, frame cadence otherwise, with warmup and
hysteresis to protect clarity. Only the canvas owns renderer DPR.

See [the performance and browser verification guide](docs/engineering-verification.md)
for interpreting those measurements and running the device matrix.

## Engineering status — September 5, 2026

The simulation split, event-time boost/dash, bounded rendering telemetry and
production browser suite are implemented. Browser checks also uncovered and
verified fixes for concurrent renderer initialization and retained shadow/blur
resources. Quality changes preserve the authored effects and release superseded
targets, including blur objects replaced during repeated effect initialization.

All headless suites, production build, TypeScript and lint passed, together with
10 browser scenarios and 2 higher-DPR quality checks on WebGPU and WebGL2.
On the tested Apple M4 Max, alternating Low/High quality returned texture counts
to **19 → 41 → 19 → 41 → 19**. These are local regression results, not a claim of
60 FPS across devices.

The next engineering work is to isolate and reduce High-quality post-processing
and reflection cost at retina resolution, then profile sustained runs on
lower-powered graphics and actual phones. Human playtests and the proposed
three-sector expedition remain ahead; shared competitive seasons require
authoritative results before leaderboards become a competitive feature.
