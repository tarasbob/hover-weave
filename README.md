# Hover Weave — Thread the Impossible

An endless hovercraft runner for the browser. Race across a procedurally
sequenced alien landscape, weave through impossible gaps at speed, build Flow with
near misses, and chase the daily seeded course.

Built with **Next.js 16**, **React Three Fiber v9**, and **three.js
WebGPURenderer + TSL** — WebGPU where available, automatic WebGL2 fallback
everywhere else. Every visual and every sound is generated procedurally:
zero textures, zero models, zero audio files.

## Play

- **Steer** — ← → or A / D · left/right screen halves on touch · gamepad
  d-pad / stick. Steering is two buttons, but input is integrated sub-tick:
  tap cadence is a true analog channel, and a tap can never fall between
  frames.
- **Boost** — hold Shift / Space (second finger on touch). Spends shard
  energy; speed and steering authority follow the same continuous thrust
  charge, so releasing before a bend is a real line-planning decision.
- **Restart** — R or Enter, instantly.
- **Pause** — Esc or P.

Close, Razor, and Perfect passes build the **Flow multiplier** — tighter
clearance earns more, precision chains raise the payout (and climb a
melody), and Flow decays if you play safe. **Shards** refill boost energy
and build short collection combos. **Shields** (increasingly scarce) forgive
one collision.

A fresh profile launches into a progressive first flight: steering, grazing,
boost, and beat reading are taught one at a time inside the real endless game.
The advanced mode grid appears only after that opening has been flown.

**The world runs on the beat.** Every mover — crushers, pendulums, rotors,
beams — is phase-locked to the soundtrack's fixed 116 BPM grid, so gaps can
be timed by ear. A Perfect pass landed exactly on the beat grades
**RESONANT** and pays ×1.25. Pattern-family leitmotifs and matching HUD cues
preview challenges several seconds ahead; beyond 20 km, selected movers form
readable 3:2 and 5:4 polyrhythms.

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
npm test         # generation fairness + deterministic simulation assertions
npm run build    # production build (deploys to Vercel as-is)
```

Useful dev tools:

- `npx tsx scripts/simtest.ts` — headless autopilot runs + determinism check
- `npx tsx scripts/gentest.ts` — pattern validation rates and generation mix
- `npm run test:frontier` — constrained synthetic cohorts + anti-macro/Carve verdict
- `npm run test:graphics` — quality-tier render budget invariants
- `?gl=webgl` URL param — force the WebGL2 backend

## Architecture

The simulation is plain TypeScript stepped at a fixed 120 Hz, fully decoupled
from rendering; React/R3F is a view layer reading interpolated sim state.

- `src/game/core/` — sim world, steering physics, collision, input, events
- `src/game/track/` — 36 handcrafted generators plus a compound circuit (including long
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
The optional FPS overlay exposes effective DPR/DRS, draw calls, triangles and
post-processing CPU submission time for profiling.
