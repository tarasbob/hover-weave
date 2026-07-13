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
| 2.1 | **Endless difficulty scaling** — past ~8 km: slow unbounded speed growth (log), validator min-corridor tightens toward a hard floor, mover frequencies up, runway seams shrink (18–34 → ~10), mutator aggression up. | done | New unbounded channel `overdriveAt(s) = log2(1 + (s−8km)/8km)` (`constants.ts`) — `difficultyAt` stays 0..1 (see Decision Log). `speedAt` += 7 m/s per octave (exactly 0 below 8 km); seams ÷(1+0.35·od) with a 10–14 m floor; validator slack 0.42 → 0.24 floor (`marginSlackAt`, min gap ≈ 2.5 m); mutator jitter/mover/scatter chances +od (capped ≤ 0.9), magnitudes log-scaled |
| 2.2 | **Speed-proportional lookahead** — `GEN_HORIZON` / materialize band / fog must scale with speed (720 m = 8 s at speed 90 but 3.6 s at 200). | done | `lookaheadFor(speed) = clamp(speed × 8 s, 720, 1560)`; sim streams to it (`world.genHorizon`); render reads damped `env.viewDistance` — materialize band = 0.94/0.75 × view (ObstacleField, Pickups, Decor, HorizonLandmarks), fog density × (720/view) keeps density×depth invariant. Far field re-budgeted: camera far 2400, terrain/ocean depth 1700, sky dome R 2000; pools ×~1.7–2.2 (sim 2600/420); headroom asserted at max horizon in `simtest.ts` |
| 2.3 | **Wall calibration** — tune scaling so autopilot tiers (greedy / lookahead / superhuman) die at predictably increasing walls. | done | Three tiers in `simtest.ts`: greedy band-scan; lookahead = live lane×slice reachability DP (~2.4 s ahead); superhuman = TAS-style rollout search over exact steering dynamics (35 two-phase candidates × 1.9 s horizon). Walls (6 deterministic seeds, medians): 1 133 m / 2 686 m / 18 360 m — every tier dies pre-cap, ≥1.5× separation, baselines baked with ×0.55–1.8 drift gates |

**Acceptance criteria**

- [x] Every autopilot tier dies at a stable, distinct distance band (its "wall"). *(1.1 km / 2.7 km / 18.4 km medians; superhuman must die past 8 km so overdrive itself is exercised; deterministic seeds make the bands exactly reproducible)*
- [x] No visible pop-in at 2× current max speed (manual + graphics test). *(Static invariant enforced in `graphicstest.ts`: worst-case materialize-start transmittance ≤ 1.3e-3 across 30–220 m/s at obstacle heights, plus far-plane/terrain/ocean/sky-dome ≥ LOOKAHEAD.MAX checks. In-app spot-check still pending — Cursor's embedded browser throttles rAF for hidden tabs so the render loop never ran; use `?start=25000` (dev-only skip param, added this sprint) to eyeball it in a real browser)*
- [x] `gentest.ts` validation rates stay healthy at high difficulty inputs. *(New 60 km chained run: fallbacks 1.3% (gate < 4%), seams 26.8 m → 14.1 m with a hard 10 m floor, generator never stalls; standalone per-pattern rates unchanged ≥ 95%)*

## Phase 3 — Make the gap visible

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | **Input recording + replay** — record per-fixed-step axis/boost (delta/RLE compressed, few KB/run); re-sim to replay. Foundation for everything below. | done | The sim now consumes a 1/127-quantized axis, so recordings replay **bit-exactly** (stats/events deep-equal, enforced in `simtest.ts`). RLE over packed (axis, boost): keyboard-style 3-min run ≈ 0.4 KB, worst-case continuous analog ≈ 6 KB per 2.3 km; an over-cap stream marks itself `complete: false` and is never used as a ghost. `src/game/core/replay.ts` (`InputRecorder`, `ReplayCursor`, `resimulate`), `SimWorld.getRecording()` |
| 3.2 | **PB ghost** — race your best run's ghost on daily + endless; post-death "race your ghost from the last 500 m". | done | `GhostDriver` steps a second `SimWorld` in lockstep with the live sim clock (lazy — allocated only when a ghost exists; lockstep exactness gated in `simtest.ts`). Daily = same-seed true spatial ghost; endless = cross-seed pace ghost (see Decision Log). Additive hologram in `Ghost.tsx`, live "±n m GHOST" in the HUD, settings toggle. Recordings persist per mode in `state/replays.ts` (version-guarded, last 3 daily keys). "Race from the last 500 m" folded into ghost + shortfall pressure (Decision Log) |
| 3.3 | **Death forensics** — kill-cam scrub: your line vs. the validator's solved path (`v.path`), clearance, speed, repeat-death streak notes ("3rd death to pistonCorridor"). | done | Death screen kill-cam (`ui/DeathForensics.tsx`): scrubbable top-down map of the last ~320 m — your 30 Hz traced line vs. the validator's dashed safe line, obstacle envelopes as they stood at impact (a recycled-envelope log keeps the field behind the craft), impact marker, and a per-moment speed / clearance / flow readout on the scrub. Streak note ("3rd run in a row ended by …") from persisted `meta.deathStreak`. 2D scrub instead of a 3D rewind (Decision Log) |
| 3.4 | **Section grades** — S/A/B/C per chunk (clearance percentile, speed vs. base, flow uptime) + end-of-run line rating. | done | Graded on chunk exit: composite = 0.45·precision (events per 100 m vs. authored intensity) + 0.30·flow uptime + 0.25·pace (avg speed vs. `speedAt`); intensity < 2 chunks are transit, never graded. `sectionGrade` event → transient HUD chip; death screen shows the intensity-weighted **line rating** + weakest section. Calibration gates in `simtest.ts` (elite line S, edge-hug C, monotone, intensity raises the bar) |
| 3.5 | **PB pressure HUD** — subtle live delta-to-PB; on death, "you were 220 m short" beside the restart prompt. | done | Quiet "PB IN n" under the live score (flips to the existing NEW PERSONAL BEST once ahead); death readout adds "n m short of your farthest flight" / "FARTHEST FLIGHT YET" beside the PB score delta |

**Acceptance criteria**

- [x] Replay re-simulation reproduces recorded stats exactly (roadmap verification metric). *(Bot run with boost + continuous axis → record → re-sim: `stats` deep-equal, score/distance/x exact, event streams identical)*
- [x] Recording size stays a few KB for human-style input. *(0.4 KB for a 3-min held-keys run; continuous analog worst case bounded and gated)*
- [x] Ghost lockstep matches the straight re-sim exactly under ragged frame slices. *(Uneven 60 Hz-ish sync → same death step, distance, score)*
- [x] Section grades calibrate: elite line S, edge-hugging C, harder chunks grade lower for the same play. *(Unit gates + bot-run integration: ordered sections, one event per graded chunk, line rating present)*
- [x] Forensics snapshot is complete at death: chronological trace ending at the impact, killing geometry present, validator path segments included. *(Gated in `simtest.ts`)*

## Phase 4 — Modes & ladder

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | **Trials mode** — single pattern (or authored 45 s course) at escalating speed until death; Bronze/Silver/Gold/Author medals; per-trial PBs. Doubles as the practice room. | done | 10-trial roster (`src/game/track/trials.ts`), every skill tag covered. Generator loops the forced pattern on trial-owned curves: difficulty ramps pattern-floor → 1 over 1.4 km, speed climbs linearly without bound (+26 m/s per km — the wall is guaranteed), a synthetic pressure channel shrinks seams / heats mutators long before the endless 8 km overdrive. Fixed seed per trial ⇒ comparable PBs + a true spatial PB ghost (the practice room). Medals on distance, calibrated per-trial against the greedy/lookahead bot walls (`scripts/trialcal.ts`, drift-gated in simtest). `meta.trialBest`, TRIALS overlay, death-screen medal ladder + "next medal was n m further", live medal callouts, and a **DRILL** button on endless deaths whose killer pattern has a trial |
| 4.2 | **Sprint mode** — fixed 180 s on a weekly seed, pure score attack. | done | ISO-week shared seed (`weeklySeed`, UTC). The sim finishes on the exact step that crosses 180 s of *sim* time (pause can't stretch it) — status `finished`, `finish` event, score/distance frozen at the line; the crossing step is recorded, so replays and ghosts reproduce the finish bit-exactly (gated in simtest via the superhuman pilot). `meta.sprintBest` per week, same-seed spatial ghost, HUD countdown (red pulse in the last 10 s), "TRANSMISSION COMPLETE" results screen (no kill-cam — nothing killed you) |
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
- **Determinism:** replay re-simulation reproduces recorded stats exactly. *(Enforced in `simtest.ts` since Phase 3.)*

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
| 2026-07-12 | 2.1 keeps `difficultyAt` bounded 0..1; late pressure is a separate unbounded `overdriveAt` channel. | Every pattern is authored against the 0..1 envelope — pushing difficulty past 1 would extrapolate lerps into broken geometry. Overdrive drives speed, seams, validator slack, and mutators instead. |
| 2026-07-12 | Lookahead capped at `LOOKAHEAD.MAX = 1560 m` (8 s holds through ~195 m/s, degrades gently beyond). | "Nothing caps" applies to scoring/difficulty, not render budgets: fog floor, far plane, terrain depth are sized against this bound. Speed growth is log, so even 100 km runs sit near it. |
| 2026-07-12 | Wall bots are boost-free. | Walls must measure track scaling, not economy skill; boost uptime is already gated separately. |
| 2026-07-12 | Superhuman tier = TAS-style rollout search (simulates exact steering dynamics), not a validator-path follower. | Path followers died at 1–5 km to model mismatch (corner-cutting between 4 m slices, replan dither), under-reporting the true wall. The rollout searcher only dies when *no* input stream survives its horizon — walls at ~18 km are genuinely overdrive-made. |
| 2026-07-12 | `debugChunks` retention switched from "last 8" to distance-based pruning (craft − despawn … horizon, cap 64). | Debug-mode only. Kill-cam/forensics (Phase 3) and any path-based tooling need the chunks the craft is *inside*, which "last 8" evicts at the old horizon. |
| 2026-07-13 | Steering axis quantized to 1/127 steps *at sim consumption* (`quantizeAxis` in `step()`), not just at recording. | The only way replays are bit-exact: the recorded value **is** the executed value. 1/127 (~0.008) is far below perceptual/control resolution. Side effect: the chaotic TAS wall bot found a new equilibrium — its rollout candidates are now pre-quantized to keep its "no model mismatch" property, and its wall baseline recalibrated 18 360 m → 31 547 m (greedy/lookahead tiers and the novice ±10% floor gate were unaffected). |
| 2026-07-13 | Endless ghost = cross-seed *pace* ghost (re-flies its own recorded track); daily ghost = same-seed spatial ghost. | Endless seeds are unique per run, so a positional ghost on live geometry is impossible; racing your PB's pace still shows the gap. On the daily the seed matches, so the ghost is a true line-for-line rival. Ghosts are spectral (additive, non-colliding) by design. |
| 2026-07-13 | Kill-cam is a scrubbable 2D top-down map (your line vs. validator path + envelope field + per-moment readout), not a 3D camera rewind. | The sim cannot step backward, and a 3D replay would need a second full render world for one screen. The teaching tool is the *line comparison* — the 2D map shows it more legibly than a cinematic scrub, at ~zero runtime cost. |
| 2026-07-13 | "Race your ghost from the last 500 m" (3.2's post-death idea) folded into the PB ghost + shortfall messaging. | A mid-track spawn would need synthetic sim state (energy/flow/speed at that point) that no real run produced — it breaks the "recording = truth" invariant and the determinism story. The death screen's "n m short" + racing the full ghost covers the same motivational loop. |
| 2026-07-13 | Recordings carry `REPLAY_VERSION`; the replays store drops mismatched or incomplete recordings on rehydrate and never persists truncated streams as ghosts. | Any future physics/economy retune silently invalidates old input streams — a stale ghost desyncing mid-run is worse than no ghost. |
| 2026-07-13 | Chunk log (bounds/intensity/validator path) + recycled-obstacle envelope log are always-on sim state, pruned to craft − 380 m. | The kill-cam window reaches ~320 m behind the craft; `DESPAWN_BEHIND` is 26 m, so the field the player just died threading would otherwise already be recycled. Both logs are tiny (≤ 64 chunks / ≤ 600 envelopes) and allocation-light. |
| 2026-07-13 | Run identity unified into `RunConfig` (`core/modes.ts`): `world.start(config)`, `stats.daily` → `stats.mode` (+`trialId`), recordings carry mode/trialId, ghost keys are `endless` / `daily:<day>` / `sprint:<week>` / `trial:<id>`. | Phase 4 modes change sim/generator behavior, so one object must describe a run everywhere (sim, recording, ghost, PB storage) or the pieces drift apart. `REPLAY_VERSION` stays 1: endless/daily sim paths are bit-identical after the refactor, so pre-4A ghosts survive via a store-level migration. Any future retune of *mode* curves (trial speed ramp, sprint duration) must bump the version — stale mode recordings would desync. |
| 2026-07-13 | Sprint/trial PBs live in their own tables (`meta.sprintBest` / `meta.trialBest`); global `bestScore`/`bestDistance` stay endless+daily only; trials neither feed nor reset pattern death streaks. | A 180 s score attack and a looped single-pattern drill are different ladders — letting them write the endless PBs (or a trial's forced pattern inflate "3rd run ended by…" streaks) would corrupt the signals Phase 3 built. Lifetime aggregates (runs, shards, near misses…) still count every mode. |
| 2026-07-13 | Sprint finishes at the **end** of the fixed step that crosses the limit, not the start of the next. | The crossing step is then part of the recording, so a replay/ghost executes the same final step and reproduces the finish bit-exactly — same invariant as death exactness. Sim-time (not wall-time) limit means pausing can't stretch a sprint. |
| 2026-07-13 | Trial walls come from unbounded linear speed escalation + a trial-local pressure channel (seams/mutators), not validator tightening; medals are per-trial distances calibrated against the greedy/lookahead walls. | `STEER.RATIO` keeps validated geometry dodgeable at any speed, so speed compresses *reaction time* — the human wall — while calibration walls stay measurable. A single global medal curve was rejected: bot walls vary ×10 across patterns (`splitDecision` greedy 198 m vs `pistonCorridor` 2 689 m). Gold sits near the lookahead wall, hand-adjusted per pattern (above it where bots out-react humans on raw speed, below it where movers reward human timing). |
| 2026-07-13 | Daily/sprint period keys are captured at run **start** and carried to persistence. | A run launched at 23:59 UTC must bank against the course it was launched on, not the day it happened to end — seed and storage key stay consistent across midnight/week boundaries. |

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
- **2026-07-12** — **Phase 2 (uncap the treadmill) complete.** The game no
  longer stops getting harder: past 8 km an unbounded overdrive channel
  (log2 octaves) keeps speed growing (+7 m/s per octave), shrinks runway
  seams toward a 10 m floor, tightens the validator's guaranteed corridor to
  a 2.5 m hard floor, and heats up mutator jitter/mover/scatter. Lookahead,
  materialize band, and fog now scale together with speed
  (`lookaheadFor(speed)`, ≤ 1560 m) so warning time stays ~8 s instead of
  shrinking — fog thins by exactly the inverse factor (no pop-in, enforced as
  a static invariant in `graphicstest.ts`), far field re-budgeted (camera far
  2400 m, terrain 1700 m, sky dome 2000 m), pools ×~2. Wall calibration:
  three bot tiers land at 1.1 km (greedy) / 2.7 km (lookahead DP) /
  18.4 km (TAS rollout search) medians with ≥1.5× separation and baked
  regression gates. All suites green (sim, gen incl. new 60 km deep-overdrive
  run, graphics, types, lint); first-2 km novice line untouched (drift −5.5%,
  same as Phase 1). Dev nicety: `?start=<meters>` (dev builds) spawns deep
  into a run for manual overdrive checks; an in-app visual pass in a real
  browser is the one outstanding nice-to-have (Cursor's embedded browser
  suspends rAF for hidden tabs, so the render loop cannot be driven from
  automation here). Sprint 3 candidate: Phase 3 (make the gap visible —
  input recording/replay first; `debugChunks` retention already fixed for
  the kill-cam).
- **2026-07-13** — **Phase 3 (make the gap visible) complete.** The mastery
  gap is now something a player can *watch*: every run records its input
  stream (RLE, ~0.4 KB for keyboard play; the sim consumes a 1/127-quantized
  axis so replays are bit-exact), and your best run comes back as a spectral
  hologram to race — same-seed line-for-line on the daily, pace ghost on
  endless — with a live "±n m GHOST" readout. Deaths teach: the death screen
  gained a scrubbable 2D kill-cam (your flown line vs. the validator's solved
  safe line over the obstacle field as it stood at impact, with per-moment
  speed/clearance/flow), a repeat-death streak note ("3rd run in a row ended
  by Piston Corridor"), an intensity-weighted S/A/B/C **line rating** with
  weakest-section callout, and "n m short of your farthest flight" beside the
  PB delta; chunks flash their grade as you exit them mid-run, and a quiet
  "PB IN n" sits under the live score until it flips to NEW PERSONAL BEST.
  Instant restart untouched (R on the death screen, zero added friction).
  New simtest gates: replay exactness (stats/events deep-equal), recording
  size, ghost lockstep, grade calibration (elite S / edge-hug C / monotone),
  forensics completeness; determinism gate extended with `sectionGrade`
  events. One knock-on recalibration: quantizing the axis moved the chaotic
  TAS wall bot's equilibrium (superhuman wall 18.4 km → 31.5 km median,
  candidates now pre-quantized; greedy/lookahead walls and the −5.5% novice
  drift unchanged). All suites green (sim, gen, graphics, types, lint,
  production build); in-app visual spot-check of the ghost hologram is
  pending (browser tooling unavailable this session — DOM/SVG panels were
  verified by SSR render against real death data instead). Sprint 4
  candidate: Phase 4 (modes & ladder — trials mode first; `PatternDef.build`
  + validator make it nearly free).
- **2026-07-13** — **Phase 4 sprint A: new modes (4.1 trials + 4.2 sprint)
  complete.** Run identity is now one `RunConfig` threaded through sim,
  recordings, ghosts, and PB storage (see Decision Log — endless/daily ghosts
  survived the refactor without a replay-version bump). **Trials**: ten
  fixed-seed single-pattern courses at escalating speed (difficulty ramps to
  1 by 1.4 km, speed climbs linearly forever, trial-local pressure shrinks
  seams and heats mutators), Bronze/Silver/Gold/Author distance medals
  calibrated per-trial against the bot tiers, per-trial PB + spatial ghost,
  a TRIALS overlay, live medal callouts, a medal ladder on the death screen,
  and a DRILL button when an endless death's killer pattern has a trial.
  **Sprint**: 180 s of sim time on a shared ISO-week seed; surviving runs
  end in a new `finished` state on the exact crossing step, so the finish
  replays and ghosts bit-exactly; weekly PB table, countdown HUD,
  "TRANSMISSION COMPLETE" results. New gates: sprint finish exactness
  (superhuman pilot survives the horizon; re-sim `deepEqual`, ghost lockstep
  to the same finish, score/distance frozen at the line), trial roster
  structure, forced-pattern purity (<15% breather fallback; 0% observed),
  per-trial wall drift bands, trial replay exactness, and 10×8 km trial
  generation health in gentest (seams 20 m → 12 m under trial pressure).
  All suites green (sim, gen, graphics, types, lint, production build);
  in-app flows (trial launch → death → medal → ghost re-arm → drill,
  sprint config, endless PB/streak intact) verified against the live dev
  server via the console handle — full visual pass in a real browser still
  pending as before (embedded browser throttles rAF). Bots extracted to
  `scripts/pilots.ts`; `scripts/trialcal.ts` is the medal calibration
  harness. Sprint 4B candidate: the ladder (4.3 heat modifiers, 4.4 pilot
  rating, 4.5 quests, 4.6 mastery cosmetics).
