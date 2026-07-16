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

- Two buttons, no brakes, no vertical, no analog hardware (v1 decisions
  stand). New depth must come from the *response* to the same two buttons.
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
| 1.2 | **Carve physics (LAB "carve")** — flick (fresh-press impulse), pump (reversal at carried speed rebounds + gains), glide (pumped momentum may exceed `STEER.RATIO`, excess decays slowly), wall-kiss (timed reversal at the clamp reflects instead of absorbing), boost-carve (pump gain × while boosting). | done | `CARVE` constants + carve branch in `SimWorld.step` (flag-off path bit-identical, gated). Pump: committed reversal with ≥ 0.55 × maxLat carried and the cooldown clear rebounds ×0.9 + 0.3 maxLat (×1.3 boosting), capped at ×1.45 maxLat; perfect cadence sustains ~×1.35, one mistimed flip bleeds it all. Glide: excess above maxLat decays at 1.6/s, steering into the glide adds nothing (pumps are the only fuel). Wall-kiss: pressing away at the clamp reflects 80% of the into-wall component. `pump` event (+wall flag), `stats.pumps`, `world.glide` for FX/HUD, dev console tuner `__carve` |
| 1.3 | **Boost feathering band** — an optimal charge band (~0.7–0.9) holding the best speed/authority trade, sustained only by PWM-feathering the boost key. | todo | Needs the carve verdict first: feathering interacts with the same PWM finger skill. Prototype behind the LAB when attempted |
| 1.4 | **Launch ritual** — release boost on the third beat of the start for a perfect launch. | todo | Small; ship with a resonance polish pass |

## Pillar 2 — Read the world like music (perception depth)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2.1 | **Mainline rhythm resonance** — every mover on the 116 BPM power-of-two beat grid, transport pinned, on-beat perfects grade resonant (×1.25) for everyone. The world becomes a moving timetable. | done | Promoted from LAB 5.4: `resonatePattern` now runs unconditionally in the generator, resonant grading is unconditional in `onNearMiss`, the transport pins to `RESONANCE.BPM`, and the `LabId` is retired (stale persisted selections are dropped by `normalizeLab`). This changes every run's mover timing ⇒ bundled with the `REPLAY_VERSION` 3 bump and full recalibration |
| 2.2 | **Polyrhythm at depth** — past deep overdrive, movers introduce 3:2 / 5:4 period ratios against the grid. | todo | Perception ceiling for the 20 km+ regime; novices never see it |
| 2.3 | **Audio foreshadowing** — pattern-family leitmotifs fade in ~8 s ahead (matching the lookahead horizon), so pros pre-read half by ear. | todo | Needs a horizon-scan hook (generator emits upcoming pattern at spawn; audio already has per-family stingers to grow from) |
| 2.4 | **Light rails** — occasional glowing floor lines tracing a good (not optimal) line; hugging pays a small escalating bonus; pros deviate when they can beat the rail. | todo | The validator's solved path is already streamed per chunk (`chunk.path`) — rendering + a proximity bonus channel |

## Pillar 3 — Every meter is a decision (strategic depth)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | **Linked patterns** — bias generation so one pattern's ideal exit lane offsets the next one's ideal entry; shrink seam resets. Line choice stops being local. | todo | Corridor chaining already exists (`exitLanes`); add an exit-lane bias channel to the director |
| 3.2 | **Forks** — literal track splits with visible risk pricing (safe canyon left, needle corridor at ×3 right). | todo | `splitDecision` pattern is the seed; needs a fork-aware validator pass |
| 3.3 | **Deep gates** — in-run gates that permanently jump the overdrive channel +1 octave (harder now, paid multiplicatively). Kills the warm-up patience tax for elites. | todo | Rating needs difficulty-adjusted distance to stay honest — design that first |

## Pillar 4 — The pursuit of perfect (practice platform)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | **Reference lines** — TAS rollout pilot flown offline over every trial's fixed seed; per-trial reference distance baked; death screen + trials overlay show "% of the reference line". | done | `scripts/refcal.ts` (superhuman pilot per trial, capped) → `reference` field in `track/trials.ts`. Trial death screen shows `REFERENCE LINE n%` beside the medal ladder; the TRIALS overlay shows each PB as a % of reference. Structural gate in simtest: reference > author medal for every trial. Endless/daily reference lines are cut (see Decision Log) — the rating anchors already serve that role there |
| 4.2 | **Technique telemetry** — detect and name technique per run (pump efficiency, flick cadence, on-beat %, wall-kisses, boost-band residency, thread rate); post-run technique sheet + 5-axis radar. | todo | `stats.pumps` / `resonantPasses` / `threads` / `boostTime` already exist; needs the sheet UI + the remaining counters |
| 4.3 | **Witness reels** — auto-capture the best 20 s of each run as a seed+inputs blob; one-click export/import of `.flight` files that re-simulate in-client. | todo | Recordings are already ~KB and bit-exact; needs a highlight picker + file IO |

## Pillar 5 — Magic (mastery made audible and visible)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.1 | **Grazes play music** — clearance/grade/chain map to pitched notes in the generative D-minor field; chains walk up the pentatonic, threads ring a chord. An elite run literally sounds like a solo. | done | `AudioEngine.nearMiss` re-voiced: chain index walks the pentatonic (perfects +1 octave, brightness by precision), threads play a chord of the *current* pad harmony, resonant perfects keep the on-beat bell. Whoosh layer retained for physicality |
| 5.2 | **Time kisses** — a ~90 ms sim-timescale dip on perfect passes and threads only (wall-clock boundary, deterministic like death slow-mo). Flow made mechanical: grazing well makes the next graze reachable. | done | `GameScene` scales the wall dt fed to `world.update` (0.55× floor, eased recovery). Replays/ghosts unaffected (sim-step indexed). Disabled by `reduceMotion` |
| 5.3 | **Trail calligraphy** — trail width/glow encode carve state and smoothness; glides read as wide brush strokes, jitter as scratch. | done | `Craft.tsx` trail width/boost pick up `world.glide` + a bank-smoothness EMA; pumps flash the trail like perfects |
| 5.4 | **Gamepad haptics** — graze ticks by grade, thread double-tap, pump thump, wall-kiss knock, death drop, boost floor. The craft in the hands. | done | `core/haptics.ts` (`GamepadHaptics`), wired beside audio in `GameController`; boost floor re-fires as a weak rumble bed; `haptics` settings toggle (default on, only fires when a gamepad is connected) |
| 5.5 | **Mythic depths** — visual/musical zones at 20/40/80 km that almost nobody reaches. Cheap content, enormous aura. | todo | Biome system already cycles; needs authored deep-zone palettes + one-time callouts |

## The ladder this buys (elo narrative)

- ~500: survives by steering, holds keys, dies to the first fast pattern.
- ~900: deliberate grazes, basic boost windows.
- ~1300: threads, >50% boost uptime via refunds, sub-tick micro-taps.
- ~1700: pumps into carves, wall-kisses, beat-arrival planning, flow equilibrium.
- ~2100: sustained glide crossings, boosted pump chains, >90% of reference on trials.
- ~2500+: full stack under deep overdrive, polyrhythm reading, 97%+ of the
  reference line, discovering and naming new tech.

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

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-15 | Roadmap v2 created; Tier 1 = sub-tick input, carve LAB, resonance mainline, trial reference lines, magic layer (graze music / kisses / calligraphy / haptics). | Highest fun-per-effort with the v1 infrastructure already in place; everything else layers on these. |
| 2026-07-15 | Sub-tick input does not violate the "two buttons" identity. | The hardware is still two buttons; cadence is *technique*, exactly like Trackmania keyboard PWM. The sim surface is untouched — it already consumes a quantized fractional axis (bot streams always exercised it). |
| 2026-07-15 | Resonance mainlined ⇒ `REPLAY_VERSION` 2 → 3; all v2 recordings/ghosts invalidated; walls, trial medals, rating anchors, and novice baselines re-baked in the same commit. | Mover timing is sim behavior: old streams would desync. One bundled bump is the v2 principle ("never piecemeal"). The replays store already drops mismatched versions on rehydrate. |
| 2026-07-15 | The audio transport pins to 116 BPM permanently; the adaptive speed/flow BPM drift is retired. | The beat grid must be the one truth the movers, the grading window, and the music share. Musical intensity now comes from stem mixing and the graze melody, not tempo. |
| 2026-07-15 | Carve physics ship as a LAB flag (unranked), not mainline. | It changes the movement economy (the one thing v1 froze). The LAB is exactly the vehicle for feel verdicts; promotion (or cut) happens after human playtesting, as with surge/dash. |
| 2026-07-15 | Glide sustains only through pumps: while above the lateral cap, steering into the glide direction adds nothing. | Otherwise holding a direction would sustain super-cap speed and glide would be a stat boost, not a technique. Pumps as the only fuel makes cadence the skill. |
| 2026-07-15 | Time kisses are applied at the wall-clock boundary (`GameScene` dt scaling), never inside the sim step. | `resimulate` maps one `update(FIXED_DT)` to exactly one step; an in-sim timescale would break that 1:1 contract. Wall-dt scaling is precisely how death slow-mo already works, so determinism and ghost lockstep hold by construction. |
| 2026-07-15 | Reference lines ship for trials only; endless/daily are cut for now. | Trials have fixed seeds — the TAS reference is precomputable offline and exact. Daily seeds change every UTC day; running the rollout searcher client-side would take minutes of compute per device. The rating anchors (log-distance through the bot walls) already express "% of optimal" for the endless ladder. Revisit if a build-time daily precompute service ever exists. |
| 2026-07-15 | Trial reference = max(TAS wall, lookahead wall, 1.2 × author) per seed, baked as a plain number with a structural gate (reference > author), not a drift gate. | The TAS is boost-free and its 2.4 s rollout horizon under-times long piston/pendulum cycles — on `pistonCorridor` it dies at 2.8 km while the lookahead DP reaches 5.3 km and the author medal (human-calibrated) sits at 6 km. "Deepest proven line" is the honest composite; the 1.2 × author floor covers mover trials where every bot under-times humans (the same asymmetry medal calibration corrects). TAS runs on all 10 trials are too slow for every simtest invocation; the numbers are deterministic and only move when tuning moves. |
| 2026-07-15 | Greedy→lookahead wall separation gate relaxed 1.5× → 1.35×. | The mainline beat grid made movers *more readable for the reactive greedy tier* (its wall moved 1 644 m → 2 129 m, +29%) — that is the mechanic working as designed, not a difficulty regression. The tiers remain distinct (1.48×) and the superhuman tier still clears lookahead by >10×. |
| 2026-07-15 | Haptics only ever fire when a gamepad is connected; no Vibration API fallback on phones. | `navigator.vibrate` is coarse, permission-fussy on iOS (unsupported), and fights the touch steering fingers. Gamepad dual-rumble is the one channel with real texture. |

## Progress log

- **2026-07-15** — Roadmap v2 created from the fun-frontier brainstorm.
  Implementation started on Tier 1.
- **2026-07-15** — **Tier 1 shipped: 1.1 sub-tick input, 1.2 carve LAB, 2.1
  resonance mainline, 4.1 trial reference lines, 5.1–5.4 magic layer.**
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
  baselines). **Trial reference lines** (`scripts/refcal.ts`) are baked for
  all 10 trials (composite of TAS/lookahead walls with a 1.2 × author
  floor); the trial death screen and the TRIALS overlay report every run as
  "% of the reference line", with a structural gate (reference > author).
  **The magic layer**: graze chains climb the pentatonic (perfects an
  octave up), threads strum the current pad chord, time kisses dip the
  wall-clock rate ~90 ms on perfects/threads (dt-boundary only — replays
  and ghosts untouched by construction; disabled under reduce-motion),
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
  pass needs a real browser — the embedded browser cannot reach localhost
  in this environment, so runtime wiring beyond the headless suites (LAB
  panel, reference-line panel, kiss feel, haptics) awaits a human session.
