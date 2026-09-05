# Competitive replay verification

The repository now provides the engineering prerequisite for a future ghost
league: a versioned, server-owned season/course policy and an isolated Node
verifier that recomputes a submitted `.flight` using the real simulation. This is
a verification preview, not a deployed competition. The offline game, replay
format v7, saved cosmetics, practice rating and existing personal best keys are
unchanged.

## Use the verifier

Install this checkout's locked dependencies with `npm ci` (the verifier uses
the included `tsx` runtime), then list the accepted policies:

```sh
npm run verify:flight -- --list
```

Export a completed Slalom run from the game's expanded flight report, then run:

```sh
npm run verify:flight -- 2026-preview trial-slalomGates /path/to/run.flight
npm run test:competition
```

Equivalent direct commands are `npx tsx scripts/verify-flight.ts` and
`npx tsx scripts/competitiontest.ts`. The preview includes all eleven current
fixed trials, the September 5, 2026 daily, the ISO week 36 sprint, and two fixed
engineering reference courses (plain and heated). The reference courses are
test fixtures, not extra flight-deck modes. Arbitrary random endless seeds are
not admitted to these course comparisons.

Successful output contains the computed score, distance, terminal state,
120 Hz step count, duration, trusted receipt time, replay/simulation versions,
season/course revisions, `courseKey` and `runId`. Rejection exits nonzero with a
structured error. Never accept a result JSON supplied by a player: the trusted
operator must run the verifier against the submitted input recording itself.

## What is enforced

- The host selects an allowlisted season and course. Uploaded mode, seed,
  trial and canonical modifier stack must match that policy exactly. Lab
  physics and development `skipTo` fields are rejected. Unsupported replay
  versions require an archived simulation build; they are never reinterpreted
  using the current rules.
- The preview accepts server receipt times from January 1, 2026 inclusive to
  January 1, 2027 exclusive. A file's editable `at` timestamp cannot move a
  result into an earlier season. The CLI uses its host clock. The trusted
  integration may supply the time it received the submission; this must not be
  copied from a request field. These checks prove receipt eligibility, not
  when somebody actually played the recording.
- Parsing is separate from the forgiving browser importer. The complete
  envelope is checked before a simulation world is created. The maximum
  payload is 2 MiB, at most 240,000 RLE numbers, and at most 144,000 fixed ticks
  (20 simulated minutes); the sprint cap is exactly 21,600 ticks (180 seconds).
  A course may tighten those limits. Recordings exceeding a course cap are
  ineligible, even if valid for offline practice.
- Every packed axis must be an actual quantized input, with a valid boost bit
  and no dash bit. RLE lengths must be positive bounded integers and exactly
  match the declared steps; repeated adjacent pairs, invalid axis encodings,
  unknown fields, malformed arrays and nonfinite result numbers are rejected.
- The server constructs `RunConfig` from its manifest. It consumes every
  recorded input at exactly 1/120 second, starting from the normal launch.
  The final input must be the first death or sprint-finish tick: surviving
  prefixes and inputs after the terminal tick are rejected. The declared score
  and distance must exactly equal simulation results. Output uses those
  recomputed results.
- `courseKey` hashes a fixed canonical identity containing season and course
  identifiers/revisions, replay and simulation versions, mode, seed, trial,
  modifiers and step cap. Future rankings must partition by this key.
  `runId` hashes that course key and canonical input stream. Changing only
  the editable export timestamp or highlight cannot evade input deduplication.

## Trusted execution boundary

Use `verifyFlightInWorker` from `src/game/competition/server.ts` in a trusted Node
job worker. It launches a fixed local entry point, without a shell or any
uploaded executable code. The child has a 20-second wall-clock budget, a
256 MiB V8 heap limit and bounded output. An over-budget child is killed. At
most two children run per host process; extra submissions fail closed as busy.
The same runtime checks remain inside the child, and its simulation loop checks
its deadline every 120 steps. Run size is bounded without expanding the RLE
stream into an input array.

The V8 heap limit is not an operating-system RSS limit. Production operators
should set container/process memory and CPU limits, supply a bounded queue,
enforce upload-size limits while receiving requests, and apply authentication
and rate limits before scheduling work. Keep the source worker, locked
dependencies and supported Node runtime together in the verifier deployment.
Do not import this Node-only module into the Next client graph or expose the
synchronous verification core directly on an HTTP request event loop. There is
intentionally no unauthenticated public route in the game application.

## Versioning and future league work

The preview manifest is immutable in memory and must remain append-only in
source after use. New rules need a new simulation identity and season/course
revision, preserving the old manifest and executable simulation for historical
verification. A changed seed, modifiers, course cap or version produces a
different course key. Existing exact simulation fingerprints and competition
tests must accompany any such change; renaming a season does not substitute
for retaining its matching implementation. Pin and validate the Node/runtime
build used for a real competition as well as the source revision.

Replay verification establishes that an input stream produces a result under
the agreed physics. It does not establish human play, real-time play, account
ownership, control-device identity, or absence of assisted/tool-generated
inputs. A future league still needs its chosen competition format, identity
and abuse policies, deployed queue/verifier, persistent verified results and
version-partitioned rankings. Store only verdicts produced inside that trusted
boundary, and deduplicate accepted inputs using `runId`. None of those
operational services or competitive claims is enabled by this preview.

The test suite covers authoritative results, all admitted mode families and a
heated course, malformed and oversized uploads, forged scores/configuration,
truncated and trailing streams, unavailable seasons/courses, season receipt
boundaries, version-key isolation, equivalent-export deduplication, and actual
child-process success, rejection and forced timeout.
A stored synthetic sprint fixture reaches the real 180-second finish, pins
its exact v7 result, and verifies that a recording ending one tick earlier is
rejected. It is a simulation regression fixture, not a claimed human run.
