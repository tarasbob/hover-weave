# The Fun Frontier (roadmap v2)

Tracking document for the "make the game ridiculously fun" redesign — the
successor to `skill-ceiling-roadmap.md` (v1, complete). Update statuses, log
decisions, and append to the progress log as work lands.

**North star:** the *hands* are the game. v1 built the ladder (economy,
treadmill, replays, modes, rating); what stays thin is **execution depth** —
given a chosen line there is essentially one way to fly it. v2 turns the
craft's response into an instrument (layered, compounding, discoverable
technique with unbounded precision payoff), makes the world readable like
music, measures play against theoretical perfection, and makes mastery
audible and visible. Novice ≈ 500 elo, lifetime pro ≈ 2500+, same starting
conditions, no ceiling.

Statuses: `todo` · `in progress` · `done` · `cut` (with reason in Decision Log)

---

## Diagnosis (what still caps the ceiling after v1)

1. **One way to fly a line.** The steer model (`STEER` in `constants.ts`,
   `SimWorld.step`) is digital axis → acceleration → strong drag. Two players
   choosing the same gaps produce nearly identical trajectories; technique
   cannot compound the way it does in Trackmania or StarCraft.
2. **Input is sampled, not integrated.** A tap fully inside one render frame
   is lost; cadence carries no information. Two buttons produce three axis
   values, so finger skill saturates within a session.
3. **The world is read only with the eyes.** Mover phases are arbitrary; audio
   is reactive, never predictive. There is no perception channel to master
   for years.
4. **"Perfect" is invisible.** The TAS pilot proves what lines are possible,
   but the player never sees the number. Nothing says "you flew 61% of what
   this track allows" — the single most addictive number in mastery gaming.
5. **Skill is silent.** An elite run and a decent run sound and look nearly
   identical from the outside. Mastery has no aura.

## Design principles (v1 guardrails still bind, plus)

- Two buttons, no brakes, no vertical *input*, no analog hardware (v1
  decisions stand). New depth must come from the *response* to the same two
  buttons. (Amended 2026-07-16: authored geometry may loft the craft — see
  Pillar 6. The input surface is untouched; verticality is a track feature
  you read, never a verb you press.)
- Novice holds must behave exactly as today: every new dynamic is
  event-conditional on timing (fresh press, reversal at speed, edge contact).
  Enforced by the conservative-bot drift gate.
- Determinism is sacred: sub-tick input quantizes into the recorded axis;
  time kisses live at the wall-clock boundary (like death slow-mo); the beat
  grid is sim-time-locked.
- Physics changes ship as one bundle under a single `REPLAY_VERSION` bump,
  followed by full recalibration (walls, trial medals, rating anchors,
  novice baselines) — never piecemeal.
- Feel prototypes go through the LAB first (unranked) and are promoted only
  after human playtesting.

---

## Pillar 1 — The ship is an instrument (execution depth)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1.1 | **Sub-tick input** — integrate per-poll hold fractions (event timestamps) into the axis; taps become a true analog channel (120 Hz × 1/127), lost taps impossible, average latency halved. Keyboard + touch hold-zones; gamepad stays digital. | done | `SubTickAxis` integrator in `core/input.ts` (pure, unit-gated in simtest): signed hold-time integral over each poll window, exact ±1 for holds, exact 0 for cancels. Keyboard keys + touch hold-zone transitions feed it with event timestamps; wheel/gamepad unchanged. The sim already consumes a 1/127-quantized axis, so recordings replay bit-exactly — no sim change at all |
| 1.2 | **Carve physics (LAB "carve")** — flick (fresh-press impulse), pump (reversal at carried speed rebounds + gains), glide (pumped momentum may exceed `STEER.RATIO`, excess decays slowly), wall-kiss (timed reversal at the clamp reflects instead of absorbing), boost-carve (pump gain × while boosting). | done | Pump payout now scales continuously from reversal quality and feeds technique telemetry. Automated A/B verdict remains **LAB ONLY**: modeled novice mean/median retention ×0.90/×0.79 and intermediate performance ×0.46 versus plain physics, below promotion gates |
| 1.3 | **Boost modulation** — speed and steering cost share one continuous thrust charge; release before curvature, hold through straights, and pulse only when the future line justifies it. | done | The fixed 0.7–0.9 band was rejected as rote PWM. `steeringAuthorityAt(boostCharge)` closes the old release loophole (residual speed with instant full authority), while leaving the optimum state-dependent |
| 1.4 | **Launch ritual** — release boost on the third beat of the start for a perfect launch. | todo | Small; ship with a resonance polish pass |

## Pillar 2 — Read the world like music (perception depth)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2.1 | **Mainline rhythm resonance** — every mover on the 116 BPM power-of-two beat grid, transport pinned, on-beat perfects grade resonant (×1.25) for everyone. The world becomes a moving timetable. | done | Promoted from LAB 5.4: `resonatePattern` now runs unconditionally in the generator, resonant grading is unconditional in `onNearMiss`, the transport pins to `RESONANCE.BPM`, and the `LabId` is retired (stale persisted selections are dropped by `normalizeLab`). This changes every run's mover timing ⇒ bundled with the `REPLAY_VERSION` 3 bump and full recalibration |
| 2.2 | **Polyrhythm at depth** — past deep overdrive, movers introduce 3:2 / 5:4 period ratios against the grid. | done | A deterministic subset blends in from ~20 km; trials retain the single grid. Geometry and validation stay unchanged; `gentest.ts` proves exact rational ratios |
| 2.3 | **Audio foreshadowing** — pattern-family leitmotifs fade in ~8 s ahead (matching the lookahead horizon), so pros pre-read half by ear. | done | `SimWorld` emits the next challenge 3–8 s out; skill-family two-note motifs have a matching accessible HUD chip, rate-limited to avoid cue spam |
| 2.4 | **Light rails** — occasional glowing floor lines tracing a good (not optimal) line; hugging pays a small escalating bonus; pros deviate when they can beat the rail. | todo | The validator's solved path is already streamed per chunk (`chunk.path`) — rendering + a proximity bonus channel |

## Pillar 3 — Every meter is a decision (strategic depth)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | **Linked patterns** — compound phrases carry entry position and resources across multiple disciplines. | done | `weaverCircuit` composes slalom, photon timing, route lattice, and needles into one validated fixed-seed course; no seam resets inside the phrase |
| 3.2 | **State-dependent forks** — literal refuel / flow / tempo branches whose value depends on current run state. | done | `routeLattice` rotates three branch types across three decisions. Rewards live in geometry and pickups rather than a dominant flat multiplier; route choices are recorded and surfaced in the technique sheet |
| 3.3 | **Deep gates** — in-run gates that permanently jump the overdrive channel +1 octave (harder now, paid multiplicatively). Kills the warm-up patience tax for elites. | todo | Rating needs difficulty-adjusted distance to stay honest — design that first |

## Pillar 4 — The pursuit of perfect (practice platform)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | **Reference distances** — TAS rollout pilot flown offline over every trial's fixed seed; per-trial automated distance baked; death screen + trials overlay show "% of reference". | done | `scripts/refcal.ts` (superhuman pilot per trial, capped) → `reference` field in `track/trials.ts`. Trial UI says `REFERENCE DISTANCE` rather than claiming an optimal line. Structural gate in simtest: reference > author medal for every trial |
| 4.2 | **Technique telemetry** — detect and name technique per run (pump quality, on-beat %, thrust residency, thread/route play); post-run technique sheet. | done | Run stats now carry pump-quality sum, glide time, continuous thrust integral, and route choices. The death screen scores precision/resonance/thrust/flow plus conditional carve/routes and names one next focus |
| 4.3 | **Witness reels** — auto-capture the best 20 s of each run as a seed+inputs blob; one-click export/import of `.flight` files that re-simulate in-client. | done | Strict versioned `.flight` serialization validates RLE integrity, selects a 20 s high-input-density witness window, exports after ranked runs, and imports directly into an unranked exact-seed ghost race |

## Pillar 5 — Magic (mastery made audible and visible)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.1 | **Grazes play music** — clearance/grade/chain map to pitched notes in the generative D-minor field; chains walk up the pentatonic, threads ring a chord. An elite run literally sounds like a solo. | done | `AudioEngine.nearMiss` re-voiced: chain index walks the pentatonic (perfects +1 octave, brightness by precision), threads play a chord of the *current* pad harmony, resonant perfects keep the on-beat bell. Whoosh layer retained for physicality |
| 5.2 | **Time kisses** — a ~90 ms sim-timescale dip on perfect passes and threads only (wall-clock boundary, deterministic like death slow-mo). Flow made mechanical: grazing well makes the next graze reachable. | done | `GameScene` scales the wall dt fed to `world.update` (0.55× floor, eased recovery). Replays/ghosts unaffected (sim-step indexed). Disabled by `reduceMotion` |
| 5.3 | **Trail calligraphy** — trail width/glow encode carve state and smoothness; glides read as wide brush strokes, jitter as scratch. | done | `Craft.tsx` trail width/boost pick up `world.glide` + a bank-smoothness EMA; pumps flash the trail like perfects |
| 5.4 | **Gamepad haptics** — graze ticks by grade, thread double-tap, pump thump, wall-kiss knock, death drop, boost floor. The craft in the hands. | done | `core/haptics.ts` (`GamepadHaptics`), wired beside audio in `GameController`; boost floor re-fires as a weak rumble bed; `haptics` settings toggle (default on, only fires when a gamepad is connected) |
| 5.5 | **Mythic depths** — visual/musical zones at 20/40/80 km that almost nobody reaches. Cheap content, enormous aura. | done | Astral Verge, Crown of Static, and Event Horizon tint the live procedural palette, replace the HUD biome label, fire one-time callouts, and resolve with unique musical signatures |

## Pillar 6 — The sky is track (authored verticality)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6.1 | **Skyhook ramps** — authored wedges loft the craft into ballistic flight on the same two buttons + boost: approach speed sets the launch (vy = slope × speed, capped), lateral carry jumps diagonally, air steering is thin (×0.25 authority), holding boost dives (altitude → forward speed, reticle-steered), and one committed flick inside 140 ms of touchdown flares the landing — perfect flares keep the dive speed as a decaying rush and pay flow/score/energy (RESONANT ×1.25 on the beat). Un-dived arcs land clean by construction (`SOFT_VY` exceeds the capped launch falling the tallest authored lip, √(VY_MAX² + 2·G·lip) — gentest bounds every wedge); unflared dives land hard (−10% speed, 0.35 s numb). PWM chatter voids the flare, so cadence macros can't farm landings. | done | Mainline under `REPLAY_VERSION` 5. Every jump is optional: decks block their own lanes, so the lane DP still proves a pure ground line, and a structural gate (gentest + probe crossings in simtest) proves the landing tube clear at worst-case (full-boost, floaty) flight for every wedge, every mutation, every depth. Mutators skip sky layouts (they carry `routes`); the drama director keeps meteors out of flight windows. Air rings/arc shards make airtime scoring-alive (`airGrazes`); the FLIGHT technique metric + a one-shot HUD callout teach the verb set. New sim state (`y`/`vy`/airborne) is geometry-conditional: no wedge ⇒ bit-identical grounded physics (enforced by an exact-hover identity gate). Sky patterns retire above 160 m/s ambient (`maxSpeed`) — a looped-wedge trial diluted into an endless safe corridor (bots rode it past 300,000 km), so there is deliberately no skyhook trial. |
| 6.2 | **The double jump + ramps everywhere** — jumping graduates from set-piece garnish to a core verb. A boost **tap** that begins and ends airborne within 140 ms fires one upward impulse per flight (UT-style), priced at 20 energy and continuous in timing quality: full `JUMP_VY` exactly at the apex, decaying to a 55% floor — tap, *beat*, tap is the skill. Same button as the dive (tap = jump, hold = dive), so the input surface is untouched. The generator now **guarantees** wedges: first lip inside the first-flight jump-lesson window (~500–900 m), then one sky pattern every ~650–1100 m at every depth (gentest cadence gate) — never seed luck. New `kickerLine` pattern chains two low wedges with a **double-jump crown** (non-magnetic apex shard, 1.6× risk payout); `skyGateRun` gains a third ring on the apex-jump arc; `canyonVault` a crown over the field. **Overflight credit**: an airborne craft samples danger in the ground band, so vaulting dense geometry keeps the engaged score stream (up to ×1.8) alive — flying over the thickest line pays like threading it. `SOFT_VY` raised to 19 so a jumped-but-un-dived arc still lands clean by construction (bound: √(JUMP_VY² + 2·G·(lip + VY_MAX²/2G)) per wedge); PERFECT decoupled onto `PERFECT_MIN_IMPACT` so flared full arcs and dives both grade perfect while feather-falls stay clean. | done | Mainline under `REPLAY_VERSION` 6. Sky patterns spawn *only* via the cadence metronome (sky set-pieces also rotate with the set-piece cadence), so the classic ground rotation keeps its exact competitive mix. Trials never draw the sky cadence — their fixed-seed rng streams, medals, and references stay byte-identical. First flight teaches a fifth lesson (`jump`, 600 m → first touchdown). Simtest gates: tap fires / hold dives / lip-carried press never arms / once per flight / energy-gated / exact impulse formula / apex-vs-early quality / flight extension / grounded-tap identity / overflight engaged-vs-neutral / bit-exact replay with a double jump in the stream. Re-baked: conservative baselines, walls (greedy 1 674 m — the denser early rotation reads worse reactively; lookahead 4 810 m — the planner exploits guaranteed-open tubes; TAS 29 507 m), rating anchors. |
| 6.3 | **Wedge choreography** — beat-locked lip arrivals (launch ritual synergy), moving air furniture, biome-specific deck circuits. | todo | Layer on 6.1/6.2 once human playtesting settles the feel numbers (`__ramp` tuner). |

## The ladder this buys (elo narrative)

- ~500: survives by steering, holds keys, dies to the first fast pattern.
- ~900: deliberate grazes, basic boost windows.
- ~1300: threads, >50% boost uptime via refunds, sub-tick micro-taps.
- ~1700: pumps into carves, wall-kisses, beat-arrival planning, flow equilibrium.
- ~2100: sustained glide crossings, boosted pump chains, >90% of reference on trials.
- ~2500+: full stack under deep overdrive, polyrhythm reading, 97%+ of the
  automated reference distance, discovering and naming new tech.

## Verification metrics (run after each phase)

- **Novice floor:** conservative-bot first-2 km score within ±10% of the
  (re-baked) baselines; opening survival unchanged.
- **Walls:** every autopilot tier still dies at a stable, distinct band;
  medians re-baked after any physics/track change.
- **Determinism:** replay re-simulation reproduces recorded stats exactly
  (extended to pump events and carve runs).
- **Carve ceiling:** scripted pump cadence sustains > ×1.25 of the plain
  lateral cap; a mistimed cadence must not (enforced in simtest).
- **Identity:** empty lab stack ≡ plain run, bit for bit; a held-but-flagless
  input stream records byte-identically.
- **Synthetic frontier:** constrained novice → reactive → intermediate
  cohorts must improve monotonically across fixed seeds; periodic macros stay
  below adaptive play, every modeled novice clears the 600 m first-flight
  curriculum, and seed spread remains bounded (`test:frontier`).
- **Input fairness:** a timestamped intent integrates identically under
  60/90/144 Hz poll partitions; timing techniques span multiple 60 Hz polls.
- **Strategic diversity:** authored route choices are recorded, and refuel /
  flow / tempo value comes from distinct resources and geometry rather than a
  universal score multiplier.

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-15 | Roadmap v2 created; Tier 1 = sub-tick input, carve LAB, resonance mainline, trial reference lines, magic layer (graze music / kisses / calligraphy / haptics). | Highest fun-per-effort with the v1 infrastructure already in place; everything else layers on these. |
| 2026-07-15 | Sub-tick input does not violate the "two buttons" identity. | The hardware is still two buttons; cadence is *technique*, exactly like Trackmania keyboard PWM. The sim surface is untouched — it already consumes a quantized fractional axis (bot streams always exercised it). |
| 2026-07-15 | Resonance mainlined ⇒ `REPLAY_VERSION` 2 → 3; all v2 recordings/ghosts invalidated; walls, trial medals, rating anchors, and novice baselines re-baked in the same commit. | Mover timing is sim behavior: old streams would desync. One bundled bump is the v2 principle ("never piecemeal"). The replays store already drops mismatched versions on rehydrate. |
| 2026-07-15 | The audio transport pins to 116 BPM permanently; the adaptive speed/flow BPM drift is retired. | The beat grid must be the one truth the movers, the grading window, and the music share. Musical intensity now comes from stem mixing and the graze melody, not tempo. |
| 2026-07-15 | Carve physics ship as a LAB flag (unranked), not mainline. | It changes the movement economy (the one thing v1 froze). The LAB is exactly the vehicle for an automated frontier/exploit verdict before promotion or cut. |
| 2026-07-15 | Glide sustains only through pumps: while above the lateral cap, steering into the glide direction adds nothing. | Otherwise holding a direction would sustain super-cap speed and glide would be a stat boost, not a technique. Pumps as the only fuel makes cadence the skill. |
| 2026-07-15 | Time kisses are applied at the wall-clock boundary (`GameScene` dt scaling), never inside the sim step. | `resimulate` maps one `update(FIXED_DT)` to exactly one step; an in-sim timescale would break that 1:1 contract. Wall-dt scaling is precisely how death slow-mo already works, so determinism and ghost lockstep hold by construction. |
| 2026-07-15 | Reference distances ship for trials only; endless/daily are cut. | Trials have fixed seeds, so automated distances are precomputable offline. Daily seeds change every UTC day; running the rollout searcher client-side would take minutes per device. |
| 2026-07-15 | Trial reference = max(TAS wall, lookahead wall, 1.2 × author) per seed, baked as a plain number with a structural gate (reference > author), not a drift gate. | The TAS is boost-free and its 2.4 s rollout horizon under-times long mover cycles. The composite means “deepest automated distance,” not optimality; numbers are deterministic and only move when tuning moves. |
| 2026-07-15 | Greedy→lookahead wall separation gate relaxed 1.5× → 1.35×. | The mainline beat grid made movers *more readable for the reactive greedy tier* (its wall moved 1 644 m → 2 129 m, +29%) — that is the mechanic working as designed, not a difficulty regression. The tiers remain distinct (1.48×) and the superhuman tier still clears lookahead by >10×. |
| 2026-07-15 | Haptics only ever fire when a gamepad is connected; no Vibration API fallback on phones. | `navigator.vibrate` is coarse, permission-fussy on iOS (unsupported), and fights the touch steering fingers. Gamepad dual-rumble is the one channel with real texture. |
| 2026-07-16 | Human baselines are replaced by explicit synthetic stress models and restricted-observation learners. | Automation can prove deterministic fairness, skill-frontier separation, anti-macro behavior, and modeled floor stability; it cannot certify subjective fun. Claims are labeled automatically validated, never human-validated. |
| 2026-07-16 | The proposed fixed boost band is replaced by continuous shared thrust state; `REPLAY_VERSION` 3 → 4. | Residual speed previously kept an instantaneous full-authority release loophole. Speed and steering cost now decay together, so the useful duty cycle depends on future curvature instead of camping one PWM band. |
| 2026-07-16 | Time kisses apply identically when Reduce Motion is enabled. | The setting may suppress presentation motion, but it cannot remove a gameplay-relevant reaction-time benefit from ranked play. |
| 2026-07-16 | Pilot Rating moves only on fixed-seed trials, normalized by automated reference distance. | Unique endless seeds and changing daily seeds inject course luck. Fixed trials make the offline signal comparable without a backend. |
| 2026-07-16 | “Reference line” is renamed “reference distance” unless an actual trajectory/input stream exists. | The baked number is the deepest automated run, not a proof of optimality and not a geometric line. |
| 2026-07-16 | Strategic forks pay through state-dependent geometry and resources, never a flat risk-lane multiplier. | Refuel, flow, and tempo routes are optimal under different energy, multiplier, timing, and next-position states; a permanent ×3 lane would collapse choice into execution. |
| 2026-07-16 | Refined Carve remains LAB-only after the synthetic A/B gate. | Against identical seeds/noise, constrained novice retention was ×0.90 mean / ×0.79 median and intermediate performance ×0.46. It increases theoretical control but currently destabilizes policies that have not learned its phase response. |
| 2026-07-16 | Skyhook ramps ship mainline (not LAB-first), as one `REPLAY_VERSION` 4 → 5 bundle with full recalibration. | The LAB-first principle exists because physics-economy changes destabilize every policy; skyhooks are geometry-conditional — outside a wedge the sim executes bit-identical code (proven by an exact-hover identity gate), and every jump is an optional route above a validator-proven ground line. A LAB flag would also fork generation, which recordings would then have to carry forever. |
| 2026-07-16 | The "no vertical" principle is amended to "no vertical *input*". | The hardware stays two buttons + boost. Verticality enters as readable track geometry: approach, lip carve, dive, and flare are all responses on the existing verbs — exactly the v2 depth thesis. |
| 2026-07-16 | Jumps are strictly optional; landing tubes are guaranteed clear but the deck is never the *scoring* line. | Decks block their own lanes so the lane DP's ground-path proof survives untouched. Airtime pays through arc shards, air grazes, and perfect-flare landings — not a flat multiplier — so ground threading (graze economy) remains the income backbone. |
| 2026-07-16 | The flare is one committed fresh press, quality-graded by timing, voided by chatter. | Continuous quality mirrors Carve pump grading; the CHATTER_GAP void keeps sub-tick PWM cadence (a legitimate steering technique) from accidentally farming perfect landings — anti-macro by construction, verified in simtest. |
| 2026-07-16 | Un-dived arcs must land clean by construction: `SOFT_VY` > √(VY_MAX² + 2·GRAVITY·lip) for every authored lip (gentest-bounded). | The novice contract: a held key or empty hands over any wedge is a safe, pleasant hop. Risk enters only with the dive (boost held airborne), and the dive is exactly what the flare redeems — ambition prices itself. |
| 2026-07-16 | No skyhook trial; sky patterns carry `maxSpeed: 160` and retire from any unbounded escalation. | A looped wedge cannot build a wall: its guaranteed-clear tube scales linearly with speed, so the trial escalation diluted into free track (calibration bots exceeded 300,000 km before the cap). Skyhooks are endless-course texture; fixed-seed rating stays on ground disciplines. |
| 2026-07-16 | The double jump maps to a mid-air boost **tap** (release inside 140 ms), not a new button. | Every device already has the button (keyboard/touch/gamepad feed one boolean), the recorded stream already carries it, and tap-vs-hold is response depth on an existing verb — the v2 thesis. A dedicated jump key would break touch (steer taps are sub-tick steering technique) and the two-buttons-plus-boost identity. |
| 2026-07-16 | Jump timing quality is continuous (full impulse exactly at the apex, 55% floor), and the impulse *sets* vy rather than adding. | Setting vy makes jumping out of a committed dive expensive (the dive's downward speed is forfeit, quality-clamped to the floor) instead of a free escape, and the apex peak recreates the UT double-jump rhythm as a learnable timing skill with unbounded refinement. |
| 2026-07-16 | Sky patterns spawn only through a generator cadence guarantee (first lip ~500–900 m, then every ~650–1100 m), never through the everyday rotation. | Frequency must be a design constant, not seed luck — but adding sky entries to the shared weighted pool starved low-weight classics (`pulseWeave`, `splitDecision` vanished from the mix survey). The metronome guarantees presence while the classic rotation keeps its exact competitive composition. Trials draw `nextSkyAt = ∞`, preserving their baked rng streams. |
| 2026-07-16 | Overflight credit: an airborne craft samples the danger economy in the ground band. | Without it, vaulting a dense field scored *neutral* (the lifted band sees nothing) while threading it paid ×1.8 — the economy punished the new verb. Sampling the ground band makes "fly over the thickest line" a real scoring read; empty overflights stay neutral, and grounded sampling is untouched. |
| 2026-07-16 | `SOFT_VY` 16.6 → 19 (jump-inclusive clean bound) and PERFECT moves to `PERFECT_MIN_IMPACT` 14.5. | The novice contract must survive the new verb: a first-timer's apex tap with no dive lands from higher, so the clean ceiling absorbs √(JUMP_VY² + 2·G·apex). Perfect stays "a real committed descent redeemed by the flare" — now including flared full jumped arcs — while feather-fall flares grade merely clean. |

## Progress log

- **2026-07-16** — **Double jump + ramps everywhere shipped (Pillar 6.2,
  `REPLAY_VERSION` 6).** Jumping is now a core verb, not a rare set-piece:
  a generator cadence guarantees the first wedge inside the first-flight
  jump-lesson window (worst first lip 771 m across the gate's seed sweep)
  and one sky pattern every ~650–1100 m at every depth, with sky patterns
  spawning *only* via the metronome so the classic rotation keeps its exact
  mix (trials draw none — their baked streams/medals/references are
  untouched). The **double jump**: a mid-air boost tap (press + release
  airborne within 140 ms) fires one impulse per flight at 20 energy,
  quality-continuous around the apex (sets vy to `JUMP_VY × (0.55 + 0.45q)`,
  q = 1 − |vy|/VY_MAX) — tap-to-jump, hold-to-dive on the same button, no
  new input. Content: `kickerLine` (two chained low wedges, everyday pool
  via cadence) with a non-magnetic **double-jump crown** at the apex-tap
  altitude (1.6× risk payout), a third `skyGateRun` ring on the jump arc, a
  `canyonVault` crown. **Overflight credit** samples danger in the ground
  band while airborne, so vaulting dense geometry holds the engaged score
  stream. Landing algebra: `SOFT_VY` 19 (jumped un-dived arcs clean by
  construction, gentest-bounded per wedge), PERFECT gated on
  `PERFECT_MIN_IMPACT` 14.5 (flared dives *and* flared full arcs redeem;
  feather-falls stay clean). First flight gains the `jump` lesson (600 m →
  first touchdown, distance fallback 1400 m); the skyhook callout teaches
  tap/hold; FX: quality-scaled chirp + pressure ring + haptics + trail
  flash + camera kick, APEX JUMP skill moment at q ≥ 0.85; the FLIGHT
  technique metric folds in air-jump count and quality. Envelope helpers
  now include one full apex jump (`rampMaxAirTime`), widening every audited
  landing tube. Re-baked in-bundle: conservative baselines, tier walls
  (greedy 1 674 m / lookahead 4 810 m / TAS 29 507 m — separation widened to
  ×2.87, the guaranteed-open tubes reward planning), rating anchors. New
  gates: sky cadence (gentest), jump-inclusive clean bound, eleven
  double-jump/overflight simtest assertions, and the flight replay probe
  now records a double jump in its bit-exact stream. All suites green.

- **2026-07-15** — Roadmap v2 created from the fun-frontier brainstorm.
  Implementation started on Tier 1.
- **2026-07-15** — **Tier 1 shipped: 1.1 sub-tick input, 1.2 carve LAB, 2.1
  resonance mainline, 4.1 trial reference distances, 5.1–5.4 magic layer.**
  Input is now integrated, not sampled (`SubTickAxis`): holds read exactly
  ±1, taps read their true fraction of the frame, intra-frame taps can't be
  lost — keyboard and touch both feed it, the sim surface is untouched.
  **Carve Physics** is live behind the LAB flag: flick (×1.6 accel for the
  first 90 ms of a fresh press), pump (a committed reversal carrying ≥ 0.55
  × maxLat rebounds ×0.9 + 0.3 maxLat, ×1.3 boosting), glide (excess above
  the steering cap decays at 1.6/s, capped ×1.45, pump-fueled only —
  steering into the slide adds nothing), and wall-kiss (pressing away at
  clamp contact reflects 80% of the impact); `pump` events, `stats.pumps`,
  `world.glide`, trail/audio/haptic feedback, and a dev tuner (`__carve`).
  **Resonance went mainline**: every mover on the 116 BPM grid on every
  run, on-beat perfects grade RESONANT ×1.25 for everyone, the transport is
  pinned, the lab flag retired. That changed sim behavior ⇒
  `REPLAY_VERSION` 2 → 3 and a full re-bake: bot walls (greedy 1 644 →
  2 129 m — the grid is *more readable* for the reactive tier, by design;
  lookahead 3 147 m; superhuman TAS 33 791 m), rating anchors, and the
  greedy/lookahead separation gate (1.5× → 1.35×, see Decision Log); the
  novice first-2 km line was untouched (drift −0.1% against unchanged
  baselines). **Trial reference distances** (`scripts/refcal.ts`) are baked for
  all trials (composite of TAS/lookahead walls with a 1.2 × author
  floor); the trial death screen and the TRIALS overlay report every run as
  "% of the reference distance", with a structural gate (reference > author).
  **The magic layer**: graze chains climb the pentatonic (perfects an
  octave up), threads strum the current pad chord, time kisses dip the
  wall-clock rate ~90 ms on perfects/threads (dt-boundary only — replays
  and ghosts untouched by construction; accessibility settings keep the same
  gameplay timescale),
  trail calligraphy (glide widens the stroke, twitch thins the ink, pumps
  flash it), and gamepad haptics (skill-graded pulses + a boost rumble
  floor, settings toggle). New simtest gates: sub-tick integrator algebra,
  flick bite + convergence, pump-cadence envelope (breaks ×1.2, holds
  ≤ ×1.45, decays back; a coasted cadence never pumps), boost-carve depth,
  wall-kiss reflect-vs-absorb, resonant award formula exactness on the
  mainline, full-lab-stack (carve+dash+surge) bit-exact replay with pumps
  in the stream, and trial reference structure. All suites green: gentest
  (incl. the re-written mainline beat-grid survey), simtest (23 gates),
  graphicstest, eslint, tsc. Persistence: meta store v7 drops the retired
  "resonance" lab id from saved selections; v2 recordings are dropped by
  the existing version guard. Standing caveat (as in v1): the in-app visual
  pass needs browser automation that can drive the local render loop; runtime
  wiring beyond the headless suites remains an automated visual-verification
  task rather than a human baseline.
- **2026-07-16** — **Skyhook ramps shipped mainline (Pillar 6.1,
  `REPLAY_VERSION` 5).** The craft gained vertical state that only authored
  wedges can excite: ride (surface-tracked, `SNAP_UP` side entries), launch
  (`vy = slope × speed × EFFICIENCY` capped at `VY_MAX`, lateral velocity
  carried ballistically), airborne steering (×0.25 authority, thin drag —
  carried carve glides), boost-dive (`DIVE_ACCEL` down + sink-rate → forward
  speed), and flare-graded touchdowns (one committed fresh press within
  140 ms, quality-continuous, chatter-voided; perfect = no scrub + the dive
  transient held as a 2.5 s decaying rush + flow/score/energy, resonant on
  the beat; hard = −10% speed + 0.35 s numb; un-dived arcs clean by
  construction, with the gentest bound `√(VY_MAX² + 2·G·lip) < SOFT_VY`
  enforced per authored wedge). Four patterns ship — `skyRamp` (teaching,
  normal pool), `skyGateRun` / `canyonVault` / `doubleSky` (set-pieces) —
  all carrying
  jump/ground `routes` (telemetry + automatic mutator protection), arc
  shards, and air rings above the grounded band. Safety is layered: decks
  block their own lanes (the ground-path proof is untouched), a structural
  envelope gate audits every landing tube against worst-case flight at
  every depth (600 decks/run), meteors avoid flight windows, and probe
  crossings assert the no-input arc never kills. Rendering gained the
  wedge pool, craft pitch/renderY, soft camera lift, a hull shadow + live
  ballistic landing reticle (beat-flash when the resonant window aligns),
  launch/land particles, graded audio (perfect landings strum the pad
  chord) and haptics, a FLIGHT technique metric, and perfect-landing time
  kisses. Recalibrated in-bundle: conservative baselines, tier walls
  (greedy 2 370 m / lookahead 3 449 m / TAS 30 306 m), rating anchors.
  New simtest gates: grounded-identity (exact hover constant), launch
  algebra, `VY_MAX` cap, dive trade monotonicity, flare quality/chatter
  envelopes, landing rush, side-slip, and bit-exact replay of a recorded
  flight (deck-seeking pilot on a live seed). Existing trials are
  untouched (trial generation never draws sky patterns), and there is
  deliberately no skyhook trial (see decision log). Suites green: gentest
  (incl. the 600-deck envelope audit), simtest, frontier, graphics,
  eslint, tsc.
- **2026-07-16** — **Automated mastery pass shipped.** A progressive first
  flight now teaches steer → graze → boost → beat inside the real endless
  run, while the title progressively discloses advanced modes. The control
  model gained continuous boost/authority coupling and continuous
  reversal-quality Carve pumps with post-run telemetry; accessibility
  settings no longer change time-kiss advantage. Strategic play gained the
  three-way `routeLattice` (refuel / flow / tempo) and the linked,
  fixed-seed `weaverCircuit`; route choices are recorded and fed into an
  actionable technique sheet. Trial UI now says **reference distance**
  honestly, Pilot Rating is fixed-trial normalized, and versioned `.flight`
  files export a selected witness window and import into exact-seed
  unranked ghost races. Perception depth now includes matching visual/audio
  challenge foreshadowing, deep 3:2 / 5:4 polyrhythms, and mythic palette +
  musical zones at 20/40/80 km. Replay version is 4; meta store is v9 (old
  open-track current ratings reset because the fixed-trial scale is different).
  Generation gates include the compound circuit and prove route patterns
  remain 100% standalone-valid with healthy chained fallback rates.
