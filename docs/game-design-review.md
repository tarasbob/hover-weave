# Hover Weave: design and engineering review

September 5, 2026. Findings are from this repository and its automated pilots;
the proposed player-experience outcomes still need human playtesting.
Updated after the engineering implementation: the simulation split, event-time
boost/dash, rendering instrumentation and browser regression suite are complete.
High-DPI GPU optimization and broader hardware validation remain next.

## What the game already does well

This is a substantial game, with a stronger foundation than its presentation
initially suggests. Keep the deterministic 120 Hz simulation, the validator that
chains reachable ground routes, the beat-synchronized movers, and the precision
economy. Near misses replenish resources, boost changes steering authority,
and optional skyhooks introduce flight using the existing controls. Those are
interacting decisions, not just additional buttons.

The repository already includes random endless seeds, mutation and novelty
weighting, challenge/recovery pacing, multiple biomes, ghosts, daily courses,
trials, medals, cosmetics, and replay analysis. Adding another layer of features
without improving their presentation would make the experience harder to learn.

The key weaknesses were:

- **The opening underrepresented the game.** Before 500 m the director mostly
  chose the same open-field pattern, with obstacles at the edges and an empty
  center. Different seeds did not immediately feel different.
- **Visual effects competed for attention.** A bright triangulated ground grid,
  turbulent luminous sky, color fringing, and interface text all carried similar
  visual weight. The hull itself was simpler than its effects.
- **The crash screen slowed the next attempt.** Numerous statistics and replay
  tools preceded the primary retry action. Coaching used one solved path as if
  it were the uniquely correct line.
- **Some polish problems were correctness problems.** Very short steering taps
  could drain on a render frame with no physics tick. Trails depended on display
  refresh. Daily results recomputed the date instead of retaining launch identity.
- **Rating was easy to overinterpret.** Pilot Rating is a smoothed estimate of
  fixed-trial reference-distance performance, not a competitive Elo rating.

## Implemented design polish

### A more active, varied first minute

The safe initial steering lesson remains. Between 160 and 500 m, open sections
can gain seeded bumper encounters with rewards showing approachable routes.
These use the existing elastic obstacle behavior: an early mistake teaches
positioning before the later lethal fields test it.

The remix uses a separate random stream derived from the generated opening.
Every decorated section is validated again and must retain exactly the original
exit-lane set. It therefore cannot consume the later director's randomness or
strand the next section. Regression fingerprints cover eight later courses and
all eleven fixed trials. Endless restarts still select fresh seeds; daily and
trial courses remain deliberately learnable.

A first implementation with lethal central obstacles passed the solver but
failed the constrained novice model. Another version reshuffled downstream
encounters enough to worsen seed variance. Both were replaced. Solvability alone
is not a sufficient definition of fair challenge.

### A coherent visual hierarchy

The ship has a manufactured silhouette: bevelled hull sections, swept wings,
an inset canopy, restrained trim, vents, and twin engine nozzles. Its wake uses
a bounded ring buffer sampled by simulation time, so refresh rate and pause
no longer determine its length.

The floor has sparser inlays with subpixel fading. The opening sky is quieter,
the horizon carries the color, and hazards retain prominence. Bloom, grain,
fringing, and boost blur are restrained; boost keeps the center of the course
clear. Reduced-motion settings also reduce title drift and camera banking.

The flight deck separates mode selection from launch and explains why each
mode is different. New pilots can learn during flight or choose to explore all
modes. The tutorial sits beside the ship, and an on-screen pause control works
without a keyboard. Returning through settings preserves the selected mode.

### A faster, more useful replay loop

The report leads with score, distance, replay, and one coaching point. Detailed
technique analysis, the kill-cam, and export remain available in an expandable
section. Advice identifies one reachable alternative, without claiming that all
other lines were wrong. Trial mastery shows how many different courses have
earned medals; Pilot Rating is explicitly described as a local practice estimate.

Modal keyboard focus stays within visible controls. Short steering input is
buffered until a fixed tick consumes it and is recorded for exact playback.
Losing window focus pauses the game and clears held inputs. Results, ghosts,
quests, and fixed-course retries share the launch-time course identity.

Replay format advances to version 7 because the opening changes simulation
outcomes. Older recordings are rejected by the existing compatibility checks;
cosmetics and progression are retained. Existing personal-best numbers remain
historical records, rather than pretending they were all earned on identical
generation versions.

## The next creative step: an expedition with an arc

The strongest larger direction is a **three-sector expedition** alongside the
endless mode. Give a short session a beginning, escalation, spectacle, and finish.
Reuse the existing patterns, skyhooks, biome transitions, and scoring system.

1. **Departure:** a readable route with two optional precision lines and a
   clearly visible distant destination.
2. **Commitment:** a route beacon offers an explicit choice of the next sector:
   a tight refueling canyon, a rhythm-driven storm, or an exposed aerial route.
   Each choice changes geometry and resources, with a broad baseline route.
3. **Arrival:** a distinctive setpiece leads to a finish portal and a compact
   report of the player's best moment and next technique to practice.

The destination makes survival feel purposeful; the route decision makes a
replay feel different. This is preferable to adding arbitrary random damage or
raising speed everywhere. It needs an authored content pass and playtesting,
not simply another flag in the existing endless director.

## Other high-value experiments, in priority order

| Experiment | Why it could be fun | Acceptance condition |
| --- | --- | --- |
| Telegraph a changing world | A distant formation assembles, a bridge opens, or a storm sweeps across a route before arrival. Players react to an event rather than memorize a wall layout. | Commit geometry ahead of the visibility horizon; show its warning and preserve a validated route. Never materialize lethal geometry under the ship. |
| State-dependent sector choices | Low energy makes a refueling route attractive; high Flow makes a demanding precision route attractive. | No branch dominates for every resource state. Build on the existing route lattice instead of stacking flat multipliers. |
| Signature spectacle | Flying through a moving megastructure or emerging above a storm can make a run memorable. | The spectacle frames a clear maneuver and has a recognizable silhouette at low quality. |
| A personal highlight | Show the cleanest chain or strongest apex jump at the end, alongside the crash lesson. | Use recorded events to select a real moment; no fabricated “top 1%” badges or extra click barrier before replay. |
| A verified ghost league | A nearby rival's visible line creates a concrete, attainable challenge. | Identical seeds, physics and modifiers; server-verified recordings and versioned leaderboards before competitive claims. |

Keep challenge opt-in where possible. Preserve quick retries and cosmetic
rewards for skill. Avoid streak penalties, pressure to play every day, paid power,
or systems that turn an enjoyable short session into an obligation.

## Ratings: mastery first, competition when it is real

Do not label the current distance mapping “Elo.” It has no opponent, win/loss
model, uncertainty estimate, or server verification. A fixed seed removes course
luck within a trial, but dividing by a reference distance does not establish equal
skill across different trials. Repeated practice on one favorable trial can
dominate the current rating.

For the current offline game, use per-trial medals, personal ghosts, and broad
mastery coverage. Before an overall mastery score becomes a competitive claim,
calibrate it on human performances across multiple disciplines. The automated
reference distance is a useful benchmark, not proof of an optimal run or a
population percentile.

For a future ghost league, compare verified runs on the **same course**, then
fit a competition rating with uncertainty. Microsoft's
[TrueSkill research](https://www.microsoft.com/en-us/research/publication/trueskilltm-a-bayesian-skill-rating-system/)
describes skill uncertainty and support for multiple competing players. A simpler
pairwise system may be sufficient for duels. Pick the algorithm after choosing
the competition format and evaluating prediction quality; the algorithm alone
does not create fair competition.

## Engineering implementation completed

- **Simulation ownership:** `SimWorld` retains the 120 Hz fixed-step order,
  craft/reward state and public API. Typed systems now own entity pools,
  obstacle motion/contact detection, seeded event direction and bounded run
  analysis. Six pre-refactor fingerprints cover exact state, ordered events,
  pools, forensics, recordings and reused-world resets. React stays outside
  simulation code, and course streaming reuses its callback instead of
  allocating one per physics tick.
- **Action input:** keyboard and touch boost/dash transitions now retain event
  timestamps through partial physics ticks, pause and focus changes. Short
  airborne boost taps and Lab dashes are covered at 30/60/144/240 Hz; held boost
  remains a dive. Gamepads still use browser snapshots. The existing boolean
  replay representation and v7 playback remain compatible.
- **Rendering reliability and measurement:** the canvas remains the sole owner
  of renderer DPR. Bounded frame/CPU windows and asynchronous GPU queries drive
  a controller with warmup, hysteresis and the existing clarity floors. Backend
  initialization is shared per canvas, fixing a WebGPU depth-buffer sizing
  race. Superseded post effects, implicit render targets, shadow maps and all
  internally created depth-of-field blur generations are released. Per-pass
  timestamp history is cleared after readback rather than growing forever.
- **Production browser coverage:** ten scenarios cover first launch, mode
  selection through settings, pause/trusted focus loss, natural death/retry,
  both actual rendering backends and repeated quality changes. Two additional
  higher-DPR checks pass. The tests verify native animation/input clocks and
  reject rendering errors and unintended WebGPU fallback. The deeper pilot,
  generator, replay, session and graphics suites remain in place.

See [Engineering verification](engineering-verification.md) for the contracts,
commands, measured results and measurement limits.

## Engineering work still ahead

1. Profile individual High-quality post-processing and reflection passes, then
   reduce unnecessary GPU work while preserving the visual direction. The
   local DPR-2 checks still measured substantial GPU cost; animation callback
   cadence alone is not completed GPU throughput.
2. Run sustained, repeatable routes on lower-powered graphics and actual phones,
   including thermal behavior, dense sections and biome transitions. The local
   Apple M4 Max checks do not complete this hardware matrix.
3. Pair responsiveness and frame-time measurements with human playtesting before
   the proposed expedition content pass. Automated pilots cannot certify fun
   or accessibility for every player.
4. Introduce versioned seasons and authoritative replay verification before
   shared competitive leaderboards. Local saves and browser personal bests
   remain practice records.

## What would justify calling it excellent

Human playtests should answer whether a new pilot understands their first mistake,
can intentionally graze an obstacle, wants a second attempt, and can name something
they learned. Returning players should discover better lines and meaningful risk
choices, not merely endure higher speed.

Track time to first meaningful choice, deaths before basic steering is understood,
seed-to-seed survival spread, input responsiveness, and frame-time tails. Pair the
numbers with observation and player interviews. The automated tests establish
important invariants; they cannot certify fun, accessibility for every player,
or a triple-A level of finish.

## Verification completed

The design-polish checks established:

- Production build and TypeScript checks; repository ESLint; whitespace checks.
- Generator validation, fixed-trial and downstream-course fingerprints.
- Full simulation/replay suite and the synthetic skill-frontier suite, retaining
  the existing fairness, separation, and scoring tolerances.
- Graphics budgets, geometry orientation, and trail consistency at 30/60/144 Hz.
- Session date/week boundaries, exact fixed-course retry, input cleanup, and
  end-to-end short steering taps at 60/144/240 Hz; the engineering follow-up
  extends steering and boost/dash coverage to 30/60/144/240 Hz.
- Browser inspection of WebGPU and forced WebGL2, low quality and accessibility
  settings, first flight, daily launch/retry, pause, the compact report, keyboard
  analysis expansion/focus wrap, and mode preservation through settings.
- Visual layout checks at 1280×720 and 844×390. Landscape mode selection and
  launch remain visible together; longer reports and settings scroll.

The engineering follow-up also passed the full headless suites, production
build, TypeScript, ESLint, whitespace checks, six exact pre-refactor simulation
fingerprints, ten production browser scenarios and two DPR-2 quality checks.
On Chromium 153 / Apple M4 Max, both backends retained the same texture sequence
through repeated quality changes: **19 → 41 → 19 → 41 → 19**. This validates
resource cleanup without removing the High-quality effects. GPU timing was
available on both backends, but the short opening-course samples do not
establish cross-device performance or a universal 60 FPS guarantee.

The novice-model mean survival is 931 m, reactive 2,159 m, and intermediate
4,128 m on the existing frontier seeds. The rebaked mean score at 800 m changes
from 2,126 to 2,094 (−1.5%). These are synthetic measurements, not human retention
or satisfaction results. The first-pass course remix was revised until those
unchanged test thresholds passed.
