# Handoff — v0.3, the engine

Read `CLAUDE.md` first: it carries what the tool is, the invariants and the quality bar.

Then read `findings.md` **in full** before writing any code — including the section at the end,
"What the corpus capture found", which corrects one of the numbers the rest of the document
quotes. It is the record of the v0.1 spike, the adversarial review that reversed three of its
conclusions, and the corpus capture that re-measured all of them. Anyone who skips it will
rebuild the wrong thing confidently.

The two previous briefs are preserved as `handoff-v0.1-spike.md` and `handoff-v0.2-corpus.md`.
They are history, not instructions.

## Where things stand

`pnpm check` passes from the repo root: `format:check`, `lint`, `typecheck`, then `test` — 140
tests across two packages after the overnight run's step 0 (114 before it). `pnpm build` passes.

**Steps 1 and 2 are built and are the subject of a review point; step 3 has not started.**
`packages/core` now holds the record types (`loaf.ts`, `profiler.ts`, `react.ts`, `signals.ts`,
`provenance.ts`), the frame partition (`frame-decomposition.ts`) and the answer's shape
(`attribution.ts`) — no heuristics. `packages/corpus/src/records.ts` parses all eight runs into
those types, and its record tests assert the partition against all 53 captured frames (56 in the
capture before the v0.3 re-capture). The list of packages below describes what existed before
that and is otherwise still accurate.

The go/no-go is answered and the evidence is in the repo. Everything the engine needs to be
tested against now exists on disk, and nothing in the steps below requires a browser.

What exists:

- **`corpus/`** — 8 captures: every fixture in both build modes, five files each, 6.8MB (6.6MB
  before the v0.3 re-capture), plus a `manifest.json`. **This is the engine's test input.** Read `corpus/README.md` before using it.
- **`packages/corpus`** — private, test-only. Reads a run directory and a `ground-truth.json` off
  disk and hands over parsed records, so `core` never needs I/O. It deliberately has no opinion
  about what the records mean — that opinion is step 1 below. 30 tests assert that each fixture's
  declared claim actually reproduces from the captured files.
- **`packages/core`** — `createScriptLineIndex`, `lineColumnAt` and `charPositionAt`, pure, 35
  tests. **Still no engine.** The three primitives translate between LoAF's `sourceCharPosition`
  and the line and column a source map is queried with, in both directions.
- **`fixtures/`** — four fixtures, each with a `ground-truth.json` and its own port pair:
  `derive-in-render` (5181/5182), `spans` (5186/5187), `innerhtml-rebuild` (5188/5189),
  `vendor-listener` (5190/5191).
- **`spike/`** — the capture, in seven modules. `collect-run.ts` serves a fixture, drives a typed
  plan from `fixtures.ts`, and writes a timestamped run directory; `capture-corpus.ts` loops
  every fixture and promotes the results. `pnpm spike:dump --list` names the fixtures.
- **`packages/agent`** — the `Transport` interface and a `BroadcastChannel` implementation. No
  collectors; the collectors live in `spike/collectors.ts` and have not moved yet.
- **`packages/react`** — the hook key and a presence check. No commit records yet.
- **`apps/viewer`** — a page that counts records arriving on the channel. Nothing to show yet.
- **`spike/archive/`** — the throwaway probes behind the claims `findings.md` makes, held outside
  the lint gate. The three fixtures it seeded have graduated; `cdp-profile.ts` and the CDP dumps
  have not, and should stay until the CDP path is picked up.

## The work

Build the engine, in `packages/core`, pure as the invariants require. Tests are the corpus:
given this dump, produce this attribution, and assert it against the fixture's declared ground
truth. That is the accuracy suite in embryo and it needs no browser.

Work the steps in order. They are ordered so that each one's output is the next one's input, and
so that the parts with the least judgement in them land first.

### 1. Record types, derived from the dumps

Not from the specifications. The specs describe fields Chrome does not ship — `sourceLine`,
`sourceColumn`, `ProfilerSample.marker` — and omit behaviour it has. Open the dumps and model
what is actually in them.

Name the domain in types, as the quality bar requires: a frame, its script attributions, a
profiler trace, a commit, a span, a candidate cause, an attribution tier, a confidence weight.
Make an invalid state hard to express — in particular, a candidate cause with no tier, and a
frame whose slices sum past its duration.

Four things in the dumps that the specs will not tell you, and that the types should make hard
to get wrong:

- **`forcedStyleAndLayoutDuration` is nested inside its script's `duration`.** Adding it as a
  sibling slice double-counts. Measured: a 111–127ms script entry containing 108–124ms of it.
  (108.8–117.7ms entries containing 94.9–103.8ms in the v0.3 re-capture, `innerhtml-rebuild`, 4x,
  both build modes.)
- **Fiber `actualDuration` is subtree time, not self time.** Self time is
  `actualDuration − Σ children.actualDuration`, which is what React itself computes. It is *not*
  `selfBaseDuration`, which is the previous render's base duration and measured 8% off. In the
  `spans` corpus `App` reads 151.2ms (151.7ms in the capture before the v0.3 re-capture) against
  six components burning ~25ms each: an engine that treats `actualDuration` as self time reports
  that frame at roughly double its length — summing the list naively gives 277.2ms (277.8ms) for a
  commit that took 151.2ms (151.7ms), and `App` at 6.0× (5.9×) its
  real contribution, which is its own 25.2ms burn. (This sentence used to say `App` "did not
  re-render at all". That is wrong: the commit comes from `App`'s own `setShowLateMount`, so `App`
  rendered. Corrected by the overnight orchestrator after the step 0 fix pass found it.) All development, 4x, in the `mount-toggle` commit. (The figure read 151.4ms
  here before step 1 checked it against the dump; the two six-component commits are 151.20 and
  152.90ms, 151.70 and 151.80ms in the capture before.)
- **React emits two kinds of `performance.measure`.** Phase markers (`Update`, `Mount`,
  `Update Blocked`) and one span per component, distinguished only by a **U+200B prefix** on the
  component ones. Nothing else separates them.
- **Every LoAF field is coarsened on a randomised 100µs grid**, so a residual below ~0.2ms is
  noise and `paintTime − styleAndLayoutStart − style − layout` can come out slightly negative.

**Done when** `packages/corpus` can parse all 8 runs into these types with no casts and no
`unknown` escaping into the engine, and a field the specs promise but Chrome withholds is
represented as absent rather than as zero.

### 2. The frame: decomposition and the denominator

LoAF's own fields give an exact, unsampled partition of a frame — where script dominates. Build
it, with the honest recipe in `findings.md` under "Decomposing the frame", and an explicit
**unattributed** remainder.

Two denominators, and the engine must be able to name which it used: `duration` ends at
`paintTime`, while `presentationTime` sits 23.8–42.5ms beyond it in every frame measured (all 51
painted frames of the v0.3 re-capture, 4x, both build modes; 26–43ms when this brief was
written). ~70% of `duration` is ~45% of keypress-to-pixels.

**Done when** every frame in the corpus decomposes with slices that never sum past `duration`;
`innerhtml-rebuild`'s unforced frames report 70%+ unattributed; its forced frames attribute
95–104ms to forced style and layout charged to the script that forced it, without
double-counting; and `vendor-listener`'s frames come out as three slices, not one.

### 3. Components: the React tier

The **DevTools hook plus fiber `actualDuration`** is the primary component signal in development.
It saw every component in every scenario tested. React's spans are **corroboration only**,
because the props-identity gate makes them blind to the `setState` owner, context consumers and
every first mount.

Two traps the corpus makes concrete:

- **A commit is evidence even when there is no frame.** `spans`' `state-owner-self` interaction
  renders for ~25ms, gets no span, and produces **no long animation frame either** — it is under
  the 50ms threshold. The engine must not assume a commit it is handed has a frame around it.
- **`run.json` carries one record per interaction**, with the page-clock window it occupied. That
  is how a commit, a frame and a sample are tied to the interaction that caused them. Several
  fixtures make a claim *per interaction* rather than per frame.

**Done when** every interaction in the `spans` corpus names the components that actually rendered
with self times that sum to the commit's own total; `state-owner-self` names `StateOwner` from a
commit with no frame; and the production run degrades to the profiler tier and says so, rather
than reporting nothing because `actualDuration` is null and the names are `b`, `m`, `h`, `g`, `v`.

### 4. Lines: the profiler tier

The profiler plus the shipped source map is the whole production story — no hook, no development
build, no build-time plugin — and the only source of third-party attribution, since LoAF
attributes a script to the line that *registered* the listener.

Resolving a source map is pure, so it belongs in `core`. `@jridgewell/trace-mapping` is already
in the lockfile and takes a parsed map object; reading the map out of a dump is the caller's job.

Conventions, because this is where it will silently be wrong: `ProfilerFrame.line` and `.column`
are **both 1-based**, a source map's column is 0-based, and `core`'s `LineColumn` is 1-based line
with 0-based column. The minus one belongs in exactly one place. The profiler's column *minus
one*, resolved, lands on the enclosing call's token — `OrderTable.tsx:36:6` is `.sort` — because
esbuild and rolldown emit no segment for an arrow function's opening paren.

What the claim may say: `OrderTable.tsx:36, in the callback passed to .sort` is defensible.
"Line 36 is slow" is not — from inside the page the profiler reports the line a function was
*defined* on, so this is function-level attribution with a line attached, and statement-level
attribution is unavailable at any sample count.

**Done when** `derive-in-render` resolves to `OrderTable.tsx` line 36 as the top-ranked line in
both build modes, with 60%+ of in-frame `OrderTable` samples inside the declared range 34–36
(measured 76% development, 83% production).
*Orchestrator's note, 2026-11-15 overnight run:* the v0.3 re-capture left production with long
frames on only 2 of 24 presses, so in-frame production `OrderTable` samples number 3, and this
criterion cannot be met as written. The step 4 suite therefore asserts the 60% floor over the
replay, meaning every sample inside the drive's steps: 70.7% of 92 samples in development and 83.6%
of 67 in production, 4×. It reports the in-frame share beside that without asserting it. The
reason is the settled rule that the aggregate line histogram is the stable quantity and long-frame
counts are not. See Questions for the morning; and `vendor-listener` attributes its vendor slice to
`vendor.js` from the profiler while reporting that LoAF named `app.js` for the same slice.

### 5. The confidence model

Its job is now concrete rather than theoretical. The shape is `frame → ranked candidate causes
with weights`, and a single obvious cause is the degenerate case where one candidate holds all
the weight.

- The **component** is known, at high confidence, in development.
- The **function** is a distribution over replayed frames, not a per-frame percentage — ±20
  points at five samples. 24 presses is what makes it stable.
- The **statement** is unavailable from inside the page at all.
- The **unattributed remainder** is cross-checked against the share of in-frame profiler samples
  with an empty stack. Measured, the two move together: 88.9–90.3% residual with 88.9–91.7% empty
  stacks unforced, 14.3–16.9% residual with 10–22% empty stacks forced (per frame, v0.3
  re-capture, 4x, both build modes; 89–92% with 90–93%, and 15% with 9–20%, in the capture
  before). The forced empty-stack share depends on the frame window: 10–22% counts samples inside
  `[startTime, startTime + duration]`, and it is 10–30% inside the engine's `isWithinFrame`, whose
  ±0.2ms tolerance admits one stackless sample at 4324.9ms against a production frame starting at
  4325.0. Two independent signals agreeing that nothing was attributable is a far better
  unattributed tier than subtraction alone.

Degrade in tiers and **name the tier**: profiler header absent → infer from overlap at lower
confidence; React hook absent → source-level attribution; source map absent → minified name with
a warning. Always produce something; always state what it was working from.

**Done when** every fixture in the corpus is attributed to its declared culprit at its declared
tier, the confidence degrades rather than guesses where the evidence is thin, and
`innerhtml-rebuild` reports a large unattributed share rather than a confident wrong answer.

### 6. The accuracy suite

`packages/corpus/src/corpus.test.ts` contains local readers — a stack walk, a frame partition, a
component-span filter — that are **deliberately throwaway**, and its module comment says so.
They exist only so the corpus could be checked before the engine's shape was decided. Delete
them and rewrite those tests against the engine.

**Done when** no test walks a stack or partitions a frame by hand, and `pnpm test` attributes
every fixture to its declared culprit at its declared tier.

A natural review point is the end of step 2: the type model and the frame arithmetic are the
parts a human can check cheaply, and every heuristic after them is built on top.

## Do not build these yet

Each is deferred for a reason that got *stronger* with the corpus, not weaker:

- **The viewer.** Nothing to show until the engine emits something real.
- **The CDP-driven CLI**, despite three findings pointing at it — true per-statement attribution
  via `positionTicks`, a trigger that can see tasks under the 50ms threshold, and now the
  threshold instability in step 2's notes. It is a second collection path, and one should work
  end to end first.
- **The Vite annotation plugin.** The production result made this *less* urgent: the profiler
  plus a shipped source map recovers the component name from the map's `names` field, with no
  hook and no build step.
- **Moving the collectors out of `spike/` into `packages/agent`.** They work, they are the thing
  that produced the corpus, and moving them is a refactor that changes nothing a test can see.
  Do it when the agent has a second consumer.

Everything else is in `later.md`, each item with the reasoning that deferred it. Read it before
proposing a feature.

## Practical notes

- **Node is installed via fnm under `~/.local`**, with PATH set in `~/.zshenv`. If a shell says
  `node: command not found`, source that file.
- **The corpus is the test input. Do not re-capture it casually** — but when you do, re-capture
  **all eight runs in one pass**. The corpus's value is that its entries are comparable to each
  other, and the v0.2 session broke that by changing the collector partway through and
  re-capturing only the two fixtures whose tests read the new field. Six runs were then missing a
  key the writer always emits, which is exactly the inconsistency that makes step 1 produce a
  wrong type. Re-capture when the collector changes or a fixture's code changes — never to get a
  nicer number.
- **Ground truths record claims, not transcriptions.** Their measured blocks hold ranges and run
  ids computed from the corpus by script, not hand-typed arrays. Per-frame values live in
  `corpus/`. This is deliberate: transcribing forty numbers by hand is how a fabricated
  measurement gets in, and five comments in those files were found contradicting the values
  beside them after one round of hand-editing. If you add a measured figure, derive it.
- **Never run two captures at once**, in two terminals or two agents. Each fixture binds a fixed
  port and they will fight over it; and even on different ports, two browsers sharing a CPU make
  every millisecond figure in both runs meaningless. `pnpm spike:corpus` is strictly serial on
  purpose and has no concurrency switch.
- **Nothing in steps 1 to 6 needs a browser.** If you find yourself launching one, check why.
- **Every millisecond figure carries its build mode and CPU throttle rate.** This is an
  invariant, not a style preference. Note that it does not scale every fixture equally:
  `derive-in-render`'s cost is real computation and scales with the rate, while the vanilla
  fixtures busy-wait on `performance.now()` and burn the same wall-clock time at any rate. Each
  ground truth says which it is.

## Already decided — do not reopen

- **Long-frame counts are not a quantity anything may assert on.** Settled 2026-11-15 by
  measurement. `findings.md` declared 14–15 development and 6 production over 24 presses; the
  corpus capture gave 14, 14, 14, 23 and 14, on the same machine and browser, because the frame
  durations sit either side of a fixed 50ms threshold and move with thermal state. The aggregate
  line histogram is the stable quantity — 73%, 76%, 83% on line 36 — and is what the suite
  asserts. This is finding 6 made sharper, not a new problem.
- **Four fixtures is the harness.** The full corpus stays deferred in `later.md`. These four
  cover the four claims that shape the engine's design, and that is their job.
- **The corpus lives in the repo.** 6.8MB of captured signal (6.6MB before the v0.3 re-capture),
  kept rather than regenerated, because the v0.1 spike's most interesting run was overwritten and
  `findings.md` still carries it as a dangling citation. Size is not a reason to delete evidence.
- **`learning/` stays.** It is a teaching workspace that lives in this repo, excluded from the
  lint and format gate on purpose. Leave it alone; it is not part of the tool and nothing in the
  tool may depend on it.

## One loose end, and it is not blocking

~~`spike/out/` still holds `loaf.json`, `profile.json` and `react-commits.json` from the last v0.1
flat capture, beside the timestamped run directories.~~ **Decided: archived, not deleted.** They
are in `spike/archive/v0.1-flat-capture/`, with a row in that directory's README saying what they
are — one keystroke on `derive-in-render`, development, 4×, 2026-11-14T23:05, whose clock note
still asks the question `findings.md` went on to answer. Archived rather than deleted because they
are the only copy and `spike/out/` is both gitignored and periodically cleared, and moved rather
than left because the mixture of flat files and timestamped run directories in one output
directory is what made them look disposable. `spike/out/` now holds only run directories.

The other loose end is recorded in `findings.md`'s open items: the forced scenario's
style-versus-layout split cannot have come from the LoAF entry, and its instrument is unknown.
Reproducing it needs a Chrome trace, which is out of scope for the engine.

Nothing is waiting on the human. Work the steps in order.

## Overnight run log (2026-11-15)

Run by an orchestrator session following `overnight-run.md`. Each step ran in its own fresh
subagent, followed by a refactor, review and fix cycle in further fresh subagents. The orchestrator
decided which review findings to accept; those decisions and their reasons are recorded per step
below. Baseline before the night: `pnpm check` green at 114 tests (57 core, 57 corpus).

Progress (updated before each next step starts):

- [x] Step 0.1 — cleanup refactor
- [x] Step 0.2 — collector change (fiber parent id, forced style/layout on scripts)
- [x] Step 0.3 — re-capture all eight runs in one pass
- [x] Step 0.4 — re-derive moved figures
- [x] Step 0 cycle (refactor, review, fix) and commit
- [ ] Step 3 — components, the React tier
- [ ] Step 4 — lines, the profiler tier
- [ ] Step 5 — the confidence model
- [ ] Step 6 — the accuracy suite

### Step 0.1 — cleanup refactor

- `BuildMode` now has one definition, in `packages/core/src/provenance.ts`. `packages/corpus/src/corpus.ts`
  re-exports it, and `BUILD_MODES` (a runtime list) stays in corpus.
- The `spike/` duplication was the run-summary console line. It is now one function,
  `describeRunSummary` in `spike/collect-run.ts`, used by `capture-corpus.ts` and `dump-raw-streams.ts`.
  The one visible change is that `pnpm spike:dump` now also prints the unresolved-position count.
- `records.ts` is split along the three signals, into `loaf-records.ts`, `profiler-records.ts` and
  `react-records.ts`. `records.ts` keeps provenance, interactions and `loadSignals`, and is 120 lines
  instead of 558. The subagent checked by diff that every comment line from the original survives.
  The readers that step 0.2 changes are therefore `readFiber` in `react-records.ts` and `readScript`
  in `loaf-records.ts`, not `records.ts` as the brief says.
- Left alone on purpose: a third `BuildMode` in `spike/fixtures.ts`. The spike is the root package,
  which does not declare `@frameblame/core` as a dependency, and importing it there would be an
  undeclared dependency. Fixing it means a root devDependency and a lockfile change. That is out of
  proportion for a cleanup, so it is under Questions for the morning.
- `pnpm check` is green at 114 tests and `pnpm build` passes. No test file changed.

### Step 0.2 — collector change

- `forcedStyleDuration` and `forcedLayoutDuration` were checked against the W3C LoAF IDL
  (https://w3c.github.io/long-animation-frames/). The spec defines `forcedStyleAndLayoutDuration` as
  their sum. The collector serialises each one as `null` when Chrome omits it, never as 0.
- Each component fiber in `describeCommit` now carries `id`, its position in that commit's list, and
  `parentId`, the nearest *component* ancestor. Host elements are not recorded, so their time is
  charged to the component that rendered them. Core models this as
  `CommitComponents = recorded | unrecorded`, so a commit is linked throughout or not at all.
- **Added at the orchestrator's request before the capture:** per-fiber render evidence (`flags`,
  `hasAlternate`, `carriedOver`) and a per-commit `truncated` flag. The reason is that a subtree React
  skips entirely keeps its previous commit's fiber objects. That leaves both a stale `actualDuration`
  and a stale `PerformedWork` bit, so `flags & 1` alone would count it as rendered. `carriedOver` uses
  React's own test (`alternate.child === child`, in `bubbleProperties`). This was verified in the
  React 19.3.1 development build, `react-dom-client.development.js`: `createWorkInProgress` at :5105,
  with `actualDuration` reset at :5128 and flags masked at :5130; `bubbleProperties` at :12823-12842.
  Step 3 must skip `carriedOver` fibers, both as candidates and as children subtracted from a parent.
- The old corpus reads as `unrecorded` with `truncated: null`. (Since the step 0 fix round an
  `unrecorded` commit has no `truncated` at all: the flag lives in the `recorded` variant of
  `CommitComponents`, and its presence on the commit record is what makes a commit `recorded`.)
  New synthetic tests are in `packages/corpus/src/collector-fields.test.ts`. The gate is green at
  123 tests.

### Step 0.3 — re-capture

- `pnpm spike:corpus` captured all eight runs serially in one invocation, with a warm-up, in 288s,
  exit 0, under `caffeinate -dims`, and with nothing else running. The new corpus is 6.8MB.
- Against the new corpus, four tests fail. Step 0.4 diagnoses them:
  - `derive-in-render` production: only 3 samples resolve into `OrderTable.tsx`, where the
    assertion expects more than 10.
  - The forced split's residual is 0.20000000000000284, against a bound of `<= 0.2`.
  - The spans test expects `StateOwner` among the commit names and gets `[null, 'App', 'App']`.
  - `innerhtml-rebuild` development frame 5 does not partition cleanly.

### Step 0.4 — diagnose the four failures, verify the new fields, re-derive moved figures

No re-capture is needed: none of the four was a collector bug. `pnpm check` green at 130 tests (59
core, 71 corpus); `pnpm build` passes. Not committed.

- **derive-in-render production, "3 samples" — (b), the threshold.** LoAF reported a frame after 2 of
  24 production presses (5 of 24 before), so only 4 stacked samples fell inside long frames. The
  bundle (`index-FhbDr_RJ.js`), its captured source map and the profiler start (before the drive)
  were unchanged, and 67 of the replay's 69 stacked samples still resolve into `OrderTable.tsx`,
  83.6% in range, line 36 first. The in-frame floor was a long-frame count by another name. The test
  now counts every sample inside the drive's steps: 70.7% of 92 (development), 83.6% of 67
  (production). Same 60% floor, same top-line-36 assertion.
- **Forced split 0.20000000000000284 and frame 5's note — (b), float at the boundary.** One forced
  entry is 23.2 + 71.5 against 94.9, exactly two grid steps, which is the tolerance itself. The new
  `exceedsCoarsenedTolerance` in `core/loaf.ts` is inclusive at 0.2ms plus a 1e-6ms float slack,
  used by `decomposeFrame` and the record test; two new core tests pin two steps as quiet and three
  as a note. The spec defines the combined figure as exactly the sum, so the drift is Chrome's; the
  comments that said the spec coarsens the halves independently are corrected.
- **No `StateOwner` originator — (b), an intermittent span.** React emits `Update` only when render
  starts strictly after the update on the coarsened clock (`react-dom-client.development.js:18619`).
  The re-capture has two `Update` spans naming `App` and none for `StateOwner`. The test now asserts
  that every named originator lacks a component span, plus the label-parsed `root.render()` row.
- **New fields, verified and asserted** (new `records.test.ts` block): all 58 commits in `spans` and
  `derive-in-render` are `recorded` with `truncated: false`; `carriedOver` is false on all 150
  fibers; the 3 fibers at 0ms actual have bit 0 clear; all 12 mounting fibers have it set; the
  projection's forced split equals `toJSON`'s and is numeric on all 77 scripts. `App` in
  `state-owner-self` has flags 0, which settles the spans ground truth's open question: its 25.2ms
  is `StateOwner`'s.
- **Moved, and worth the morning's attention.** The profiler's median cadence went from 12.2ms to
  14.5ms in all eight runs alike, request unchanged, so fewer samples everywhere. Several figures
  quoted before were already wrong against the old corpus and are corrected with a note: "36 of 80"
  anonymous scripts was 54, "6 of 20" one-step drifts was 11, "50 of 54" frames with zero
  style/layout was 51.
- **Left for the orchestrator.** Step 4's done-when below still says "60%+ of in-frame `OrderTable`
  samples" in both modes; in-frame production now holds 3 samples, so that criterion cannot be met
  as written. The collector's `run.json` sampling note still says "~12ms median cadence" (spike
  text, not edited). Findings has a new closing section, "What the v0.3 re-capture found".

### Step 0 cycle — review findings and the orchestrator's decisions

The refactor is committed as `415ec1e`. A cold review of `9aecc23..HEAD` checked every changed
ground-truth figure, every `findings.md` change, the README, and the changed comment figures with
scripts against the new corpus and the `9aecc23` one. **No figure was fabricated.** It confirmed the
React 19.3.1 line citations and the LoAF spec reading. Its ten findings, and what was done with each:

1. **Accepted.** The forced empty-stack share of 10–22% holds only under a strict frame window. The
   engine's ±0.2ms `isWithinFrame` gives 10–30%, because a stackless sample at 4324.9 sits against a
   frame start of 4325.0. Both are now quoted, each with its convention.
2. **Accepted.** `spike/collect-run.ts` and `spike/browser-apis.d.ts` still said the first sample
   lands 0.1–1.3ms after start, which is stale. They now give 0.1–0.9ms for the v0.3 re-capture and
   0.0–0.7ms for the capture before, both at 4×.
3. **Accepted.** The figures in `handoff.md` that the re-capture moved are annotated as `findings.md`
   does: the test count, the frame count, the corpus size, the spans `App` arithmetic, the
   presentation gap, and step 5's cross-check bounds. Step 5's agent reads those bounds as its
   targets, so they had to be current.
4. **Partly accepted.** The derive-in-render replay floor of 0.6 sits only 0.17 standard errors
   below the previous capture's 60.8% of 102. The current capture's 70.7% is 2.25 standard errors
   above it. (An earlier version of this note said "about two standard errors" for the first gap;
   the fix pass corrected the arithmetic.) The review proposed swapping it for a plurality test or
   a 0.5 floor. **Rejected:** 60% is step 4's declared done-when, and moving a declared criterion is
   a design decision, not a fix. What was accepted is a comment beside the floor giving the binomial
   standard error, so that a future flap is read as noise. Also carried forward: step 4's brief
   states the replay-population decision explicitly, because so far it lives only in a throwaway
   `corpus.test.ts` reader.
5. **Accepted.** The rewritten spans originator test was close to vacuous, because `App` has no
   props and so can never get a component span. It now asserts per interaction that each `Update`
   originator names the component whose `setState` that interaction called. Its comment says the
   `Update` span itself is intermittent.
6. **Accepted.** One float-safe, one-sided tolerance helper is used for every coarsened comparison
   in `frame-decomposition.ts`, not just the forced split. The `isWithinFrame` comment's "one
   coarsening step" is corrected to two. This is a condition of acceptance: no note may change on
   any corpus frame.
7. **Accepted.** `truncated` moves into the `recorded` variant of `CommitComponents`, and linkage is
   now keyed on the commit, not inferred from its fibers.
8. **Accepted.** `readLinkedFiber`'s error paths are made consistent.
9. **Accepted.** "(4x, both build modes)" is appended to the cadence and clock figures that lacked a
   throttle.
10. **Accepted.** The derive-in-render ground truth no longer asserts the order and modes of the
    pre-corpus 0.73, 0.76 and 0.83. It cites `findings.md` for them.

**Deferred:** the review's remark that the derive-in-render histogram story is now told in six
places, which is a drift risk. Consolidating it means rewriting measurement prose in the README,
two ground-truth comments and `handoff.md`, and the rule tonight is that such prose may be moved
but not cut. Left for the morning; see Questions.

## Questions for the morning

- **Should the derive-in-render histogram narrative live only in `findings.md`, with the README,
  the ground truth and the tests citing it?** It is currently told in six places. Not consolidated
  tonight, because doing so means cutting measurement prose in an unattended run.
- **Should the replay floor of 0.6 stay at step 4's declared 60%?** One capture measured 60.8% of 102, only
  0.17 standard errors above it, so a future re-capture may flap. Kept at 0.6, with the
  standard error noted beside it.
- **Step 4's "60%+ of in-frame `OrderTable` samples" is now measured over the replay, every sample
  inside the drive's steps, instead of inside long frames.** In-frame production holds 3 samples
  after the re-capture, because LoAF fired on only 2 of 24 presses, against 5 of 24 before.
  Orchestrator's decision: accept the replay population. It is the same function work, a frame
  under the 50ms threshold is still a slow keypress, and it follows the settled rule that long-frame
  counts are not assertable. The in-frame share is still reported. If you want the claim limited
  strictly to long frames, production needs more presses per run, which means a fixture plan change
  and a re-capture.
- **Should the root package depend on `@frameblame/core` so that `spike/fixtures.ts` can drop its own
  `BuildMode`?** Chosen for tonight: leave the duplicate, because it avoids a lockfile change in an
  unattended run.
