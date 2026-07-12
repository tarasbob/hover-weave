# CUBEFIELD — Neon Horizon Runner

An endless hovercraft runner for the browser. Race across a procedurally
sequenced alien landscape, thread neon geometry at speed, build Flow with
near misses, and chase the daily seeded course.

Built with **Next.js 16**, **React Three Fiber v9**, and **three.js
WebGPURenderer + TSL** — WebGPU where available, automatic WebGL2 fallback
everywhere else. Every visual and every sound is generated procedurally:
zero textures, zero models, zero audio files.

## Play

- **Steer** — ← → or A / D · touch-drag on mobile · gamepad stick
- **Boost** — hold Shift / Space (second finger on touch). Spends shard
  energy; steering authority drops while boosting.
- **Restart** — R or Enter, instantly.
- **Pause** — Esc or P.

Close, Razor, and Perfect passes build the **Flow multiplier** — tighter
clearance earns more, precision chains raise the payout, and Flow decays if
you play safe. **Shards** refill boost energy and build short collection
combos. **Shields** (increasingly scarce) forgive one collision.

**Daily Course** runs the same seed for every player each UTC day, with its
own personal best. Distance, flow streaks, lifetime totals and daily play
unlock craft designs and trail cosmetics — skill only, nothing for sale.

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
- `?gl=webgl` URL param — force the WebGL2 backend

## Architecture

The simulation is plain TypeScript stepped at a fixed 120 Hz, fully decoupled
from rendering; React/R3F is a view layer reading interpolated sim state.

- `src/game/core/` — sim world, steering physics, collision, input, events
- `src/game/track/` — 29 handcrafted pattern generators (including long
  "chaos field" free-navigation scatter sections), a post-build mutator
  pipeline (mirroring, extra scatter, rhythm jitter, mover speed-ups) that
  keeps layouts unpredictable across runs, a challenge director that rotates
  precision/rhythm/reaction peaks with short recovery beats, biome definitions, and a
  lane-reachability validator that proves every generated chunk — including
  every mutation — has a flyable path (worst-case envelopes for all moving
  obstacles) before it is accepted
- `src/game/render/` — R3F components; all materials are TSL node materials
  (terrain displacement, procedural sky, planar-reflection ocean, neon
  fresnel obstacles, pooled particles, post chain: bloom, chromatic
  aberration, vignette, grain, FXAA/SMAA)
- `src/game/audio/` — Tone.js generative music director (layered stems mixed
  by speed and flow tier) and synthesized SFX
- `src/game/state/` — Zustand stores (transient game state; persisted
  settings and progression)
- `src/ui/` — HUD and menu screens (Tailwind v4 + motion)

Quality tiers (auto-detected via `detect-gpu`, overridable in settings) gate
shadows, reflections, particle counts, AA mode and terrain density; a dynamic
resolution scaler holds frame rate on weaker GPUs.
