# Simulation boundaries

Implemented and verified September 5, 2026. This is the current architecture,
not a proposed split. Replay v8 adds broad curves and lethal track edges.

`SimWorld` remains the public entry point. It owns run identity, craft and reward
state, the input recorder, and fixed-step orchestration. The systems here receive
narrow typed views of that state and keep their own bookkeeping private. They
have no React, renderer, DOM or wall-clock dependency.

- `EntityPools` owns stable obstacle/pickup arrays, free slots and live ramp
  counts. A slot is initialized completely before use and returned exactly once.
- `ObstacleSystem` evaluates motion, collisions, closest approaches and danger.
  Contact callbacks let the world apply rewards or end the run synchronously.
- `EventDirector` owns a dedicated seeded random stream. It reads already
  generated safe paths and ramp windows before placing telegraphed events.
- `RunAnalysis` owns bounded chunk history, section metrics, craft traces and
  recycled obstacle envelopes. It produces course-local crash analysis.
- `runStats` contains the shared result contracts and fresh statistics factory.

The order in `SimWorld.step` is a gameplay and replay contract:

1. Consume/record quantized input; advance speed and craft motion. Stop immediately if the craft leaves an edge.
2. Stream course geometry; resolve route choices and previews.
3. Advance the event director using the streamed safe paths.
4. Attribute the current step to its section.
5. Evaluate obstacle motion and contacts. Stop this live step immediately on death.
6. Collect pickups; advance resource timers, score and statistics.
7. Sample the trace, then check the time-limited finish gate.

The impact/finish handlers capture a final trace and partial section at their
existing positions in this order. Never move those calls to a later reporting
pass. The systems reuse their context and entity storage; no context object or
callback is allocated per physics tick.

The live-input boundary remains outside these systems. `core/input.ts` captures
keyboard/touch events, and the pure `core/actionInput.ts` scheduler maps boost
and dash transitions onto fixed ticks in `SimWorld.update`. Already-sampled
replay and pilot inputs retain the original path. A sub-tick action receives a
press tick and a release tick; gamepad buttons remain polled browser snapshots.

`npm run test:world` locks exact v8 state, ordered events, pool contents,
forensics and recording output across reused runs. It excludes only the recording
export's wall-clock timestamp. The deeper simulation and frontier suites cover
contacts, ramps, movement techniques, fairness and replay invariants.
Session checks also cover event-time input and exact playback at
30/60/144/240 Hz. The full set of headless suites passed after this extraction;
see [Engineering verification](../../../../docs/engineering-verification.md)
for the browser results and remaining performance work.
