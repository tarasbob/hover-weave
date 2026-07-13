# Skill Ceiling Roadmap

Tracking document for the "raise the skill ceiling" redesign. Update statuses,
log decisions, and append to the progress log as work lands.

**North star:** easy to learn, lifetime to master. Two verbs (steer, boost).
A player's score/distance should be limited by their skill wall, never by
patience or a systems cap. Target: p99/p50 score ratio ≥ ×30 (baseline: ~×3–5)
with the first 2 km unchanged for new players.

Statuses: `todo` · `in progress` · `done` · `cut` (with reason in Decision Log)

---

## Diagnosis (why the ceiling caps today)

1. **The game stops getting harder.** `difficultyAt` (`src/game/track/generator.ts`)
   flattens by ~8 km; `speedAt` saturates at `SPEED.MAX = 90`. Past that, runs
   end from lapses, not limits — score scales with patience, not skill.
2. **Scoring saturates at moderate skill.** Flow caps at `MAX_POINTS = 28`
   (×8 multiplier); chain bonus caps at ×1.7. God-tier play has nowhere to climb.
3. **The boost loop closes too early.** Boost is the perfect skill dial
   (×1.45 speed, 0.62 steering authority) but graze rewards don't scale with
   speed, and the shard economy caps boost uptime identically for everyone.
4. **Grazing is one-sided.** Near misses pay per obstacle; choosing the tighter
   of two gaps isn't valued. Distance score pays the same on the empty edge as
   on the dangerous center line.
5. **The gap is invisible.** Deterministic sim, but no ghosts, replays, or
   rating. Novices can't see what mastery looks like.

## Design principles (guardrails — check every PR against these)

- Keep two verbs. Depth from interactions, not new inputs.
- Extra difficulty is opt-in and paid multiplicatively. First 2 km plays
  identically to today.
- Nothing caps: asymptotes become slow unbounded growth or player-chosen
  escalation.
- No brakes. Speed is a ratchet; `STEER.RATIO` keeps geometry dodgeable at any
  speed.
- Mastery must be measurable (ghosts, medals, rating); death must teach
  (forensics, instant restart stays sacred — no added friction, ever).
- Skill-only economy. Cosmetic rewards only, extending `src/game/state/meta.ts`.

---

## Phase 1 — Risk economy (compound existing systems)

The core patch. Items 1.1–1.4 are mostly `src/game/core/constants.ts` +
`src/game/core/world.ts` and should land together as one coherent rebalance.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1.1 | **Grazes fund boost** — perfect ≈ +4 energy, razor ≈ +1.5, refund ×~1.5 while boosting. Perpetual boost becomes the emergent elite technique. | done | Shipped as perfect +12 / razor +7 / close +1.5, refund ×1.75 while boosting, drain 34→30 (tuned against the uptime gate — the roadmap's starting values couldn't outpace drain). `ENERGY.GRAZE_*`, `ENERGY.BOOST_REFUND`, `grantEnergy` in `world.ts` |
| 1.2 | **Speed-scaled precision rewards** — graze score/flow ×`(speed/SPEED.BASE)^1.5` or ×2 while `boostCharge > 0.8`. | done | Continuous variant chosen (see Decision Log). Score gets the full factor; flow-point gains use a damped linear factor capped ×2.5 so one graze can't spike multiple tiers. `speedRewardFactor` / `speedFlowFactor` in `world.ts` |
| 1.3 | **Thread bonus** — grazing both sides of a gap within a short s-window pays both + multiplicative bonus. Own stat, callout, sound. | done | Pairs opposite-side passes ≤10 m apart. Accepts "pressed" passes (hull clearance < 2.6 m) so real `narrowGates`/`combTeeth` gaps thread; true double-graze needles additionally repay both awards ×1.5. `THREAD` constants, `onPassConfirmed`/`onThread`, `stats.threads`, `thread` event, HUD toast + `audio.thread()` |
| 1.4 | **Danger-weighted scoring** — passive score rate scales with local obstacle density near the craft lane; edge-hugging pays ~nothing. | done | Reformulated as engagement vs. availability (see Decision Log): empty stretches stay neutral (×1), threading dense geometry pays up to ×1.8, dodging into an empty flank while a field rages pays down to ×0.25. `DANGER` constants, density sample in `updateObstacles` |
| 1.5 | **Flow prestige** — pick one: (a) uncap `flowPoints` with superlinear decay past 28, or (b) bank a full meter into a permanent +1 run multiplier level. | done | Option (a) shipped: no cap on points; everything above 28 bleeds continuously at `DECAY_RATE × 0.028 × over²`/s, so sustained event rate sets an equilibrium (~58 pts on the synthetic gauntlet ⇒ ×15+ multiplier). Flow speed bonus capped at tier 5 (pre-uncap max) so speed stays a boost ratchet |
| 1.6 | **Rebalance pass** — retune `FLOW`/`ENERGY` constants so novice first-session play is unchanged; verify with sim tests. | done | Conservative-bot scores drift −5.5% on average vs. pre-patch baselines (gate: ±10%), baked into `simtest.ts` as `BASELINE_800`/`BASELINE_2KM` |

**Acceptance criteria**

- [x] Autopilot (`scripts/simtest.ts`) scores within ±10% of baseline on the first 2 km. *(−5.5% avg across 800 m × 8 seeds + 2 km × 3 seeds checkpoints)*
- [x] A scripted "elite" input stream (boost + tight lines) can sustain >80% boost uptime through hard patterns; a "safe" stream cannot exceed ~30%. *(Deterministic narrowGates-style gauntlet: tight line 96% uptime / 220 threads, wide-lane line 0%; center-line bot on real seeds 20%)*
- [x] Thread bonus fires in headless tests on `narrowGates` / `combTeeth` style patterns and never fires on single-edge passes. *(Synthetic gate probes: needle ✓, pressed pair ✓, single edge ✗, same-side chain ✗, beyond window ✗, wide-open ✗)*
- [x] Determinism test still passes (same seed + inputs ⇒ same stats). *(Extended to include boost input + thread events)*

## Phase 2 — Uncap the treadmill

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2.1 | **Endless difficulty scaling** — past ~8 km: slow unbounded speed growth (log), validator min-corridor tightens toward a hard floor, mover frequencies up, runway seams shrink (18–34 → ~10), mutator aggression up. | todo | `difficultyAt`, `speedAt`, `validator.ts`, `mutators.ts` |
| 2.2 | **Speed-proportional lookahead** — `GEN_HORIZON` / materialize band / fog must scale with speed (720 m = 8 s at speed 90 but 3.6 s at 200). | todo | `TRACK` constants, `Terrain`/`env` fog, pool caps may need bumps |
| 2.3 | **Wall calibration** — tune scaling so autopilot tiers (greedy / lookahead / superhuman) die at predictably increasing walls. | todo | Extend `scripts/simtest.ts` with bot tiers |

**Acceptance criteria**

- [ ] Every autopilot tier dies at a stable, distinct distance band (its "wall").
- [ ] No visible pop-in at 2× current max speed (manual + graphics test).
- [ ] `gentest.ts` validation rates stay healthy at high difficulty inputs.

## Phase 3 — Make the gap visible

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | **Input recording + replay** — record per-fixed-step axis/boost (delta/RLE compressed, few KB/run); re-sim to replay. Foundation for everything below. | todo | Sim is already deterministic at fixed 120 Hz |
| 3.2 | **PB ghost** — race your best run's ghost on daily + endless; post-death "race your ghost from the last 500 m". | todo | Render ghost craft from replayed sim |
| 3.3 | **Death forensics** — kill-cam scrub: your line vs. the validator's solved path (`v.path`), clearance, speed, repeat-death streak notes ("3rd death to pistonCorridor"). | todo | `deathCause` + validator path already exist |
| 3.4 | **Section grades** — S/A/B/C per chunk (clearance percentile, speed vs. base, flow uptime) + end-of-run line rating. | todo | Chunks already carry `patternId`/`intensity`/`skills` |
| 3.5 | **PB pressure HUD** — subtle live delta-to-PB; on death, "you were 220 m short" beside the restart prompt. | todo | `Hud.tsx`, `Screens.tsx` |

## Phase 4 — Modes & ladder

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | **Trials mode** — single pattern (or authored 45 s course) at escalating speed until death; Bronze/Silver/Gold/Author medals; per-trial PBs. Doubles as the practice room. | todo | `PatternDef.build` + validator make this nearly free |
| 4.2 | **Sprint mode** — fixed 180 s on a weekly seed, pure score attack. | todo | |
| 4.3 | **Heat modifiers** — opt-in burdens (Scarce Shields, No Magnet, Dense Field, Fast Movers, Narrow Gaps, Tin Hull), multiplicative score stack. | todo | Pre-run config; leaderboard stratification |
| 4.4 | **Pilot Rating** — Elo-ish number from daily percentiles (offline fallback: vs. own history + autopilot baselines). | todo | |
| 4.5 | **Skill-shaped quests** — rotating challenges ("3 threads in one run", "S-grade a chunk while boosting") layered on the daily seed. | todo | Never time-shaped chores |
| 4.6 | **Cosmetic rewards for mastery** — craft/trail unlocks for trials medals, heat levels, rating milestones. | todo | Extends `meta.ts` unlock rules |

## Phase 5 — Bigger bets (prototype behind flags; default off)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.1 | **Surge windows** — perfect pass opens ~0.6 s of free boost. Overlaps 1.1; keep whichever feels better, or surge for razors + refunds for perfects. | todo | Decide after Phase 1 playtesting |
| 5.2 | **Mouse-relative steering** — highest-ceiling input option. | todo | `input.ts`; small |
| 5.3 | **Phase dash** — third verb: short lateral displacement, ~2 s cooldown, energy cost, no i-frames. Validator must never assume it (tracks stay steer-solvable). | todo | High risk of trivializing precision patterns |
| 5.4 | **Rhythm resonance** — phase-lock movers to the Tone.js transport; on-beat perfects grade "resonant". | todo | Gimmick risk; flag-gated prototype |
| 5.5 | **Async multiplayer** — daily rival ghosts near your rating; server-verified leaderboards by re-simulation. | todo | Needs backend |
| 5.6 | **Vertical layer (hops/ramps)** | cut | Dilutes the 1D purity that keeps the game readable at speed. Revisit only if all else ships. |

---

## Verification metrics (run after each phase)

- **Gap ratio:** p99/p50 score across sessions. Baseline ≈ ×3–5. Target ≥ ×30 by Phase 4.
- **Floor check:** new-player time-to-death and first-2 km experience unchanged (autopilot baseline ±10%).
- **Wall check:** each autopilot tier dies at a stable, distinct distance.
- **Determinism:** replay re-simulation reproduces recorded stats exactly.

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-12 | Roadmap created; Phase 1 = risk economy patch first. | Highest ceiling-per-effort; mostly `constants.ts` + `world.ts`. |
| 2026-07-12 | Vertical layer (5.6) cut. | Protect 1D readability at speed. |
| 2026-07-12 | 1.2 uses the continuous `(speed/BASE)^1.5` factor, not the flat ×2 boost gate. | Keeps paying as Phase 2 uncaps ambient speed; boost already dominates the factor (×1.45 speed ⇒ ~×1.75 rewards). Novice drift stays bounded because the conservative bot never boosts and early ambient speed is low. |
| 2026-07-12 | 1.3 threads pair "pressed" passes (clearance < 2.6 m), graded by tightness². | A strict double-graze rule (< 1.3 m both sides) almost never fires on authored patterns — the narrowest `narrowGates`/`combTeeth` gaps give ~2.4 m center clearance. Pressed pairing rewards picking the tighter gap (roadmap diagnosis #4) while tightness² keeps wide needles nearly worthless. |
| 2026-07-12 | 1.4 reformulated: `factor = 1 + 0.8·engagement − 0.75·availability·(1 − engagement)`. | A pure density kernel taxed breathers/seams (autopilot avg ×0.4 ⇒ −60% passive score, blowing the ±10% floor gate). Engagement-vs-availability keeps empty track neutral, pays threading, and still zeroes out edge-hugging when there is geometry to engage. |
| 2026-07-12 | 1.5 shipped option (a): uncapped flow with continuous quadratic overcap bleed. | Continuous, preserves the meter-tension loop, and needs no new UI legibility. The bleed (no grace above 28) makes the overcap regime an equilibrium of event rate — patience alone cannot hold it. Option (b) banking shelved; revisit only if playtesting finds the top-end too volatile. |
| 2026-07-12 | 1.1 graze energy shipped hotter than sketched (perfect +12 / razor +7, refund ×1.75, drain 30). | The roadmap's +4/+1.5 with ×1.5 refund cannot outpace 34/s drain at realistic graze rates (~1–2/s through hard rows). Tuned until the gauntlet's tight line sustains 96% uptime while shard-only play stays ≤20%. |
| 2026-07-12 | Uncapped `flowTier` consumers clamped at the render/audio edge (FOV ≤ tier 6, particle bursts ≤ tier 8, BPM ≤ tier 8). | Scoring must be uncapped; camera distortion and mix intensity must not be. |

## Progress log

- **2026-07-12** — Roadmap created from design brainstorm. No implementation started.
- **2026-07-12** — **Phase 1 (risk economy) complete.** Grazes now fund boost
  (with a ×1.75 refund while boosting — perpetual boost is live as the elite
  technique), precision rewards scale with `(speed/30)^1.5`, thread-the-needle
  pays both sides of a gap (new stat, HUD callout, SFX), passive score is
  danger-weighted (engagement vs. availability), and flow is uncapped with
  quadratic overcap bleed. All four acceptance gates are enforced in
  `scripts/simtest.ts` and pass: first-2km drift −5.5% (limit ±10%), gauntlet
  tight line 96% boost uptime vs. 0%/20% for safe lines, thread pair/negative
  probes green, determinism (now with boost inputs + thread events) green.
  New run stats: `threads`, `boostTime` (both shown on the death screen).
  Sprint 2 candidate: Phase 2 (uncap the treadmill — endless difficulty,
  speed-proportional lookahead, wall calibration bots).
