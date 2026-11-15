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

`pnpm check` passes from the repo root: `format:check`, `lint`, `typecheck`, then `test` — 180
tests across two packages (89 core, 91 corpus) after the overnight run's step 3 fix pass; 140 after
step 0, 114 before it. `pnpm build` passes.

**Steps 1 and 2 are built and are the subject of a review point. Step 3 is built, reviewed and
fixed; see the run log below.**
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
(measured 76% development, 83% production; those are v0.2-era figures, from `findings.md`, and match
neither the previous corpus nor the current one).
*Orchestrator's note, 2026-11-15 overnight run:* the v0.3 re-capture left production with long
frames after only 1 of 24 presses (LoAF reported 3 frames: the page load, one in the replay, and one after the replay window closed), so in-frame production `OrderTable` samples number 3, and this
criterion cannot be met as written. The step 4 suite therefore asserts the 60% floor over the
replay, meaning every sample inside the drive's steps: 70.7% of the 92 replay samples charged to `OrderTable.tsx` in development (of 96 stacked
replay samples) and 83.6%
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
- [x] Step 3 — components, the React tier
- [x] Step 4 — lines, the profiler tier
- [x] Step 5 — the confidence model
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
4. **Partly accepted.** The derive-in-render replay floor of 0.6 sits only 0.16 standard errors
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

### Step 0 — closed

The fix pass applied every accepted finding. `pnpm check` is green at 140 tests (64 core, 76
corpus). No decomposition note changed on any of the 53 corpus frames. The fix pass also found
that `handoff.md`'s step 1 said `App` "did not re-render at all" in `mount-toggle`. That is wrong,
because the commit comes from `App`'s own `setShowLateMount`, and the orchestrator corrected the
sentence. Committed as `9007f0d` and pushed. Step 3 starts next.

### Step 3 — outcome

Built in `packages/core/src/component-attribution.ts`, using `attribution.ts`'s vocabulary.
Committed as `8e5c39b`, with the refactor as `9194216`. `pnpm check` was green at 178 tests (87 core,
91 corpus) and `pnpm build` passed; the fix pass below brings it to 180 (89 core, 91 corpus).

- **The arithmetic.** `fiberParticipation` decides whether a fiber rendered the way React DevTools
  does: carried over first, then no alternate (a mount), then `PerformedWork`. Carried-over status is
  re-inherited down the parent links rather than trusted. `commitRenderTimes` subtracts in-commit
  children only, so a carried-over fiber is skipped both as a candidate and as a child. A bailed-out
  fiber stays in the subtraction but is never a candidate. A self time more than two grid steps
  below zero becomes a `negative-self-time` note and is not clamped. A truncated walk becomes a note.
  Partial timings and unlinked captures come back `untimed` with a named `ReactTierShortfall`.
- **The answer.** `attributeCommit` and `attributeInteractionComponents` return ranked candidates
  per commit, merged by name per interaction. Each commit carries the long frame it landed in, or
  `null`. Spans are attached as `react-component-span` evidence and never move a weight. The corpus
  test checks this by removing the spans and comparing the weights.
- **Production.** The commit degrades to `profiler-unmapped`, with `shortfall: 'fiber-timings-absent'`
  and a `describeCommitBasis` sentence that says so. The hook's minified names are joined to the
  profiler's minified function names, which are the same identifiers. Each stacked sample in the
  commit's window is charged to its innermost frame named as a rendered component. No source map is
  resolved; that is step 4.
- **Vocabulary changes.** `profiler-samples` evidence now carries `ofSamplesInWindow` and a `window`
  (`frame` or `commit-render`) in place of `ofSamplesInFrame`, because a commit window is not a
  frame. A new `fiber-rendered` evidence variant records "the hook saw it render, untimed".
- **Ground truth.** `spans`' `state-owner-self` row gained `listedButBailedOut: ["App"]`. It makes the
  existing comment machine-readable: `App` has flags 0 in that commit in both build modes.

Choices made without a human, each the conservative option:

1. **Tier name for production: `profiler-unmapped`, not `profiler-mapped`.** The bundle ships a map,
   but nothing resolves it yet, so every name is reported as minified and every position as
   generated code.
2. **The commit's sample window** is `(max(previous commit, interaction start), committedAt]`. The
   hook does not report when a render began, so this is the tightest bound the records support.
   Stacked samples in it that match no component stay in the denominator, which is why some
   production weights sum to less than 1: 0.87 for `initial-mount` and 0.93 for `mount-toggle`
   (production, 4x).
3. **Negative self time.** The raw signed value is kept. The weight uses `max(self, 0)` over a
   denominator of summed positive self times. That equals the commit total whenever no fiber is
   negative, which holds on every corpus commit.
4. **Bailed-out fibers' self time** is React's reconciliation beneath components that did not render.
   It is charged to no component and is left as the unattributed remainder. It is 0ms on all 29
   timed corpus commits (development, 4x).
5. **A minified name matching more than one definition site** in a window is not charged at all, and
   a note says so. Never observed in the corpus.
6. **`nameIsMinified`** is `buildMode === 'production'`, as the field's own doc defines it.
7. **An interaction whose commits reached different tiers** gets `merged: null`, because a fiber-time
   share and a sample share are different quantities. Never observed in the corpus.

### Step 3 cycle — review findings and the orchestrator's decisions

The refactor is committed as `9194216`: the self-time arithmetic moved to `fiber-self-time.ts`. A
cold review of `6759867..HEAD` found **no fabricated figure**. Every new number was found in the
corpus or derived from it, at 4×. Its fifteen findings, and what was done with each:

1. **Accepted.** "What React itself computes (:4421)" overstated the match. React subtracts every
   direct child fiber, host fibers included. The engine subtracts only recorded component
   descendants, so host-fiber time, such as DOM creation on mount, is charged to the nearest
   component above it. The comment is reworded, and the visible consequence is recorded: `App` reads
   35.7ms in `initial-mount` against about 25ms for every other component (development, 4×).
2. **Accepted.** The commit sample window was called "the tightest bound the records support", and
   it is not. It now also starts no earlier than the last `InteractionAction.atMs` at or before the
   commit, and the label `commit-render` becomes `since-previous-commit`. No corpus figure moves,
   because no stacked sample falls in the excluded span. It matters on a page with a polling timer.
3. **Accepted.** Minified-name ambiguity is now decided once per capture, over all profile frames,
   instead of per window and over innermost matches only. That is strictly more conservative. The
   remaining assumption, that one site in the whole profile is the component, is stated.
4. **Accepted.** The production name test was near-vacuous: a candidate existed for every hook name
   even when the stack join matched nothing. The oracle now comes from the ground truth's
   `rendered`, mapped through the development fiber index, and every candidate must have a weight
   above 0.
5. **Accepted.** "Self times sum to the commit total" is an identity by telescoping. An independent
   oracle is added: every component burns `BURN_MS = 25`, so each rendered fiber's self time must be
   at least 25ms minus the coarsening tolerance.
6. **Accepted.** `CommitAttribution` carries `provenance`, and `describeComponentNote` prints its
   milliseconds with the build mode and throttle.
7. **Accepted.** The `profiler-unmapped` tier sentence no longer contradicts itself: it says
   "not resolved through a source map", not "no source map".
8. **Accepted.** The minified-name list now includes `_`, which is LateMount.
9. **Partly accepted.** The remainder below a weight of 1 is honest but implicit. Accepted now: the
   `profiler-unmapped` basis carries the unmatched sample count, and the timed basis carries the
   bailed-out milliseconds, so the reason is in the data. **Deferred to step 5:** an explicit
   `unattributed` candidate with its own reason. That belongs to the confidence model, which has to
   be designed as one coherent thing.
10–14. **Accepted** as readability fixes:
    - restructure `tallySamples` by grouping per name;
    - type evidence as a non-empty tuple;
    - replace the boolean-parameter `sumSelf` with one partitioning loop;
    - compute participation once, and throw where an unreachable fallback used to quietly relabel
      a fiber;
    - name `MergedComponents` and `AttributedInteraction`.
15. **Accepted.** Stale `handoff.md` lines are corrected, and `rankCauses`' error message no longer
    says "of the frame".

### Step 3 — closed

The fix pass applied every accepted finding. `pnpm check` is green at 180 tests (89 core, 91
corpus). A before-and-after script over all 8 captures (18 interactions, 58 commits) found every
weight, sample count, denominator, tier and note identical. Only two things changed: the evidence
order, and `re` in `derive-in-render` production now carrying its `definedAt`. Step 4 starts next.

### Orchestration change, from the user, 2026-11-15 10:40

From step 4's review onward, the review runs as two fresh subagents in parallel, each reviewing the
same diff cold:
- **Figures reviewer:** questions 2, 4 and 5 of the review brief. The completion criteria,
  millisecond figures without build mode and throttle, and every new number checked against the
  corpus.
- **Code reviewer:** questions 1, 3 and 6. The code against its comments, over- and under-claiming,
  and readability with the rewrite attached.

Steps, refactors and fixes stay one at a time.

### Step 4 — outcome

Built in `packages/core/src/source-map.ts` and `packages/core/src/line-attribution.ts`, using
`attribution.ts`'s vocabulary. `@jridgewell/trace-mapping` 0.3.31 is now a dependency of
`packages/core`; the lockfile gained four lines and nothing new was fetched. `pnpm check` is green
at 210 tests (107 core, 103 corpus), and `pnpm build` passes. Not committed.

- **Resolution.** `resolveProfile` resolves every interned frame once through the map its resource
  carried. Each frame comes back `mapped`, `unmapped` with an `UnmappedReason` (`no-source-map`,
  `source-map-unavailable`, `source-map-unreadable`, `no-mapping-at-position`), or `unlocated`.
  The only minus one is still `profiledFramePosition`'s. Measured: `27:108` points at the `(` of
  `(a, b) =>` in the served text, and it resolves to `OrderTable.tsx:36:5` (0-based), the `sort` of
  `.sort`, in both builds. That comment in `profiler.ts` used to say the resolved column landed on
  the paren and the call token sat one column further left. Both halves were wrong, and the comment
  is corrected. `enclosingCallTokenAt` reads `.sort` back out of the map's `sourcesContent`, for
  anonymous frames only.
- **The answer.** `attributeSampledFunctions` charges each stacked sample in a named population to
  a function and ranks the functions by sample share. The populations are `interactionPopulation`
  (the replay), `longFramePopulation` and `scriptSlicePopulation`. A candidate is a `source-location`
  subject with `granularity: 'function-definition'`, its served `scriptUrl`, a `FunctionName` with
  its origin, and the enclosing call token. Its tier is `profiler-mapped`, or `profiler-unmapped`
  with the reason on the location. `SourceLocation` is now a union on `throughSourceMap`, so a
  generated position must carry `whyNot`. `describeSourceLocation` produces
  `OrderTable.tsx:36, in the callback passed to .sort`.
- **LoAF against the profiler.** `attributeScriptEntries` groups every script slice in the capture
  by the registration site LoAF named, then attributes those slices from the profiler. It records a
  `ScriptDisagreement` when the profiler's top function ran in a different script.
  `describeScriptEntry` says both halves, with milliseconds qualified by build mode and throttle.
- **The tier improved where a map resolves.** Production React commits are now `profiler-mapped`,
  under the names the map gives back: `h` is `OrderTable`, and all six `spans` names are the declared
  components at their declared files and lines. A before-and-after script over the 58 commits of
  `spans` and `derive-in-render` found every weight, sample count and note identical. Only the
  names, the tier and `definedAt` changed. Step 3's production tests are updated to match, and they
  are stronger: the expected names and sites now come straight from the ground truth.

How the done-when is demonstrated, in `packages/corpus/src/lines.test.ts`:

- `derive-in-render: the profiler names the function on the declared line > {development,production}:
  the function defined on line 36 ranks first over the replay, and most samples are charged to
  functions defined in 34-36` (retitled in the step 4 fix round, C7).
  - The top candidate is `OrderTable.tsx:36`, mapped, `.sort`, function-level.
  - The replay floor holds: 65 of 92 (70.7%) in development and 56 of 67 (83.6%) in production,
    4x, the orchestrator's figures exactly.
  - The in-frame share is reported through `context.annotate` and not asserted: 40 of 56 (71.4%)
    in development and 1 of 3 (33.3%) in production.
  - The standard-error note sits beside the floor.
- `vendor-listener: … > {development,production}: the vendor slice is vendor.js by the profiler and
  app.js by LoAF`.
  - LoAF names `app.js` at offset 9268 on all six entries.
  - The profiler puts 13 of 13 stacked samples (development) and 13 of 14 (production) in
    `vendor.js:42`, `vendorTrack`, at `profiler-unmapped` with `no-source-map`, 4x.
  - Most of that is one burst (F2, re-derived in the fix round): 9 of development's 13 fall in
    1.1ms on the first click (165.8–166.9ms), and 9 of production's 14 in 181.0–182.5ms, the one
    `app.js:192` sample among them. After the first click it is 4 of 4 in development and 5 of 5
    in production, all `vendorTrack`; the sixth development click's sample, at 3757.2ms, sits on
    the boundary and goes to the next slice (4x). Burst samples are not independent evidence,
    which step 5 has to account for.
  - The disagreement names both scripts.
- Also in that file: the first-party slices agree with LoAF and name `computeTotals` and
  `thrashLayout`; `innerhtml-rebuild` stays at `profiler-unmapped` with its reason named; App is
  never the answer; and development LoAF names react-dom's dispatcher while the profiler names
  `OrderTable.tsx`.

Choices made without a human, each the conservative option:

1. **Which frame a sample is charged to.** The innermost frame that the map's own `ignoreList`
   does not name as library code, or the leaf if every frame is library code. A frame no map
   vouches for is never skipped, which is what keeps `vendor.js` charged as itself. This rule
   reproduces the throwaway test's figures exactly. The leaf alone would give 85.5% of 76 in
   development and charge line 49's JSX work to `react-jsx-dev-runtime.development.js:327`.
   - Each fold is counted in `ignore-listed-callees` evidence.
   - Known blind spot, recorded in the module: a third-party SDK bundled from `node_modules` is
     ignore-listed, so it folds into its first-party caller. No capture has that shape.
2. **The vendor is a `source-location` subject, not `third-party-script`.** Both files are
   same-origin, and nothing in the trace says which is a third party. The claim the criterion asks
   for is about the file. Naming the vendor is `later.md`'s "categorising every slice" item.
3. **Script slices are half-open.** One sample in the corpus lies on a boundary: `vendorTrack` at
   3757.2ms, the exact coarsened instant the vendor slice ends and the forced-layout slice begins
   (development, 4x). It is counted once, in the later slice.
4. **A LoAF site is everything LoAF reports about it:** URL, function name, offset, invoker and
   invoker type.
5. **A mapped file is named as the map names it**, resolved against `sourceRoot` but not against
   the map's URL. So it reads `OrderTable.tsx` in development and `../../src/OrderTable.tsx` in
   production, and the tests compare last path segments.
6. **A commit's profiler tier** is `profiler-mapped` when every rendered name with a single
   definition site resolved through a map, and at least one did. It is decided from the sites
   rather than the window's samples, so a commit whose window caught no sample does not split an
   interaction's merge. An ambiguous name keeps the commit unmapped.
7. **Dropped from the vocabulary:** a `not-resolved` unmapped reason that nothing produced.
   `CauseSubject`'s `third-party-script` variant is still unused and was left alone.

### Step 4 cycle — review findings and the orchestrator's decisions

The refactor is committed as `4810fc0`. The review ran as two parallel cold reviewers, by the user's
orchestration change. The figures reviewer checked every new number with its own scripts (raw JSON
plus `@jridgewell/trace-mapping`, no engine). Everything reproduced except three items, listed
below. **No figure was fabricated**, but one measured claim was wrong. Both reviewers found it
independently.

**From both reviewers.** The `source-map.ts` bias comment, and `findings.md` point 4 behind it,
said `GREATEST_LOWER_BOUND` and `LEAST_UPPER_BOUND` resolve to the same original position. At the
converted 0-based column they disagree on every frame: 0 of 27 in development and 0 of 19 in
production for `derive-in-render`, and 117 of 117 across `derive-in-render` and `spans`. For the
culprit, GLB gives `36:5` (`sort`) and LUB gives `36:11` (`a`). The claim holds only at the
unconverted column, so point 4 was measured with the off-by-one. **Accepted:** the comment now
says GLB is *required*, and `findings.md` gets an appended correction that keeps the original
text as history. This is the same class of error the night exists to catch: a conclusion that
lost its reason.

**Code reviewer (C), figures reviewer (F):**
- **C2, accepted.** The comment claiming a malformed `mappings` string throws is false, because
  `TraceMap` decodes leniently and resolves garbage silently. The comment is reworded. Also
  accepted is the cheap sanity check: an original line past the source's line count resolves to
  `no-mapping-at-position`. Condition: no corpus figure moves.
- **C3, accepted.** An anonymous frame takes the map's `name` only when the profiler names the
  function, so an anonymous callback can no longer inherit a neighbour's identifier. Latent: the
  corpus has no such frame.
- **C4, accepted.** `mergeTallies` refused to merge `profiler-mapped` with `profiler-unmapped`.
  Both are sample shares, so they now merge, and the merge takes the least-mapped tier.
- **C5, C6, C7, C8, accepted** as wording. "Names come from the source map" becomes conditional.
  "Third-party attribution" becomes "names the script the time was spent in". The
  `ScriptDisagreement` doc records that it is blind inside one bundle and noisy on a dev server.
  "Line 49's cost" becomes "the `.map` callback defined on line 49", and the test titles change to
  match. `describeFunctionAttribution` names only the tiers actually reached, and the local
  `window` is renamed.
- **C9, accepted as a comment only.** The half-open slice end is a tie-break, and its one measured
  case, the `vendorTrack` sample at 3757.2ms, points the other way. The comment says so. Behaviour
  is kept, because any tie-break is arbitrary and this one is at least consistent.
- **C10, C11, C12, C13, accepted.**
  - `FrameResolution` gets `generated: LineColumn` in both variants, plus `definedAt`.
  - `script-entry-attribution.ts` splits out of `line-attribution.ts`.
  - The tier is derived from `throughSourceMap`.
  - There is one `generatedSiteKey`.
- **C14, accepted** as a recorded note: `UnmappedReason` will need a "not attempted" member when
  `forcedBy` is first built.
- **F2, accepted.** In development, 9 of the vendor's 13 samples fall in a 1.1ms burst on the first
  click; in production it is 9 of 14. After the first click the evidence is 4/4 in development and
  5/5 in production. The comments now say so. **Carried to step 5:** burst samples are not
  independent, and the confidence model must not count them as such.
- **F3, accepted.** "React's 3MB development map" becomes "1.7MB map, for a 3.1MB served script".
- **F4, accepted.** `expect(entry.slices).toHaveLength(6)` is a long-frame count, which is banned.
  It becomes a non-empty check plus a per-slice check that each URL ends in `app.js`.
- **F5, F7, accepted.** The out-of-window explanation now covers all three cases, and the build
  mode is added to the "12ms slice" figure.
- **F6, F8, done by the orchestrator in this file.** 0.17 becomes 0.16 standard errors, and the
  replay note says "92 of the replay's 96 stacked samples charged to `OrderTable.tsx`". The
  done-when's "(measured 76%/83%)" is marked as a v0.2-era figure.

### Step 4 — closed

The fix pass applied every accepted finding. `pnpm check` is green at 213 tests (110 core, 103
corpus). A before-and-after snapshot of all 8 captures (136 frame resolutions, every function
attribution, script entry and interaction) is identical apart from the two intended prose changes.
On the out-of-window samples, the script measured 6 before the first window, not the reviewer's 7.
6 + 3 + 2 is the 11 total, so the reviewer's count was the one that was off. Step 5 starts next, on
Fable, as `overnight-run.md` asks.

### Step 5 — outcome

Built in `packages/core/src/confidence.ts`, `frame-attribution.ts` and `capture-attribution.ts`,
with `attribution.ts`, `profiler.ts`, `line-attribution.ts` and `component-attribution.ts` extended.
`pnpm check` is green at 282 tests (154 core, 128 corpus), and `pnpm build` passes. Not committed.

**The design.** Confidence is three quantities on every weight, and no score.

- *Support*: how the number was arrived at. `measured` (fiber self times, frame slices), `sampled`
  (a share of profiler samples, with its independent counts), or `subtraction` (what was left, with
  the verdict of its cross-check). A union, so a weight cannot exist without it:
  `confidenceWeight(fraction, basis, support)` derives the rest and throws if a sampled fraction is
  not the share its own counts give.
- *Range*: the interval the true share plausibly lies in. The timing grid either side of a
  measurement, and of a subtraction whose check agreed or was not made; a 95% Wilson interval for a
  sampled share. Thin evidence widens the answer.
- *Level*: `high`, `moderate` or `low`, by one rule in `confidenceLevelOf`. A measurement is high,
  unless its whole is under 1ms and the timing grid alone is more than 20 points of it, which is
  low; no corpus weight is that short. A sampled share is moderate from 21 independent samples up
  and low below, and never high; a frame's pooled function share is judged on the fewer of its
  pool's samples and its own slice's. A subtraction is high when the second signal agrees over 21
  or more in-frame samples, moderate when it agrees on fewer or nothing could check it, and low
  when it disagrees. The 21 is a choice, not a derivation: `findings.md`'s "±20 points at five
  samples" is its measure of unusable, roughly one standard error of an even split there, and
  applied as a 95% half-width, the stricter reading, a Wilson interval at an even split is first
  inside it at 21 samples. At five samples the 95% range is ±33 points.

The tier stays on the candidate, as before. A ranking also carries `lead`: whether the first
candidate's range clears the second's (`clear`, `within-noise`, `sole`, `none`).

**What was built.**

- `independentSampleWeights` in `profiler.ts`. A burst is a run of samples each under 5ms after
  the last, half the sampling floor; it counts once, shared equally among its samples. Measured
  first: of the corpus's 16,451 gaps, 16,376 are 9ms or longer, 11 fall between 5 and 9ms, and 64
  are under 5ms, in 14 bursts holding 78 samples (4x, both build modes). Four of the bursts are
  `vendor-listener`'s first click. This is F2. Every sample share in the engine is now a share of
  independent samples, and the raw counts stay on the evidence. A burst counts as one look only
  while it is shorter than the 10ms floor; every corpus burst spans 6.0ms or less, so each still
  counts once (4x, both build modes).
- `crossCheckEmptyStacks` in `confidence.ts`. It compares the share of a frame outside every
  reported script with the share of in-frame samples that had no stack. They agree within the
  larger of one sample and two binomial standard deviations, and are left unchecked under five
  samples. On the corpus's 53 frames 45 agree, 8 are unchecked (all `derive-in-render`: five with
  four samples each, and three outside the profile's span, which say so as
  `frame-outside-profile`), none disagree (4x, both build modes). The comparison is against time
  outside *scripts*, not against the unattributed charge, because the rendering update's own layout also runs with no stack:
  `spans`' first frame is 0.1% unattributed and 15.8% outside scripts (development, 4x).
- `attributeFrames` in `frame-attribution.ts`. Every slice of a frame becomes a candidate whose
  weight is a share of the frame's duration, and the weights sum to 1 on all 53 frames. A script
  slice's JavaScript is divided by the strongest signal available: fiber self times where a timed
  commit landed in it, else functions sampled in that site's slices across the interaction, else
  the script entry as LoAF named it. Forced style and layout is one candidate charged to its
  script entry. Time nothing can name is an explicit `unattributed` candidate per reason, with
  the cross-check on its confidence.
- `attributeCapture` in `capture-attribution.ts`: the entry point. Per frame, per interaction
  (`components`, `functions`, `frames`), every commit, `workingFrom` naming each missing signal,
  and `statementLevel: 'unavailable-in-page'`.
- The step 3 deferral (#9). A commit's remainder is now an explicit `unattributed` candidate:
  `bailed-out-reconciliation` at the fiber tier, `no-rendered-component-on-stack` at the profiler
  tier, `no-profiler` for a commit nothing measured. Rankings sum to 1.
- Vocabulary. `ScriptEntrySite` moved into `attribution.ts`. A `script-entry` subject for the
  `loaf-script-registration` tier. `browser-work.forcedBy` is now a `ScriptEntrySite`: the engine
  has no script text, so it cannot turn LoAF's offset into a line, and the comment that predicted
  a "not attempted" `UnmappedReason` is resolved that way. A `frame-slice` evidence kind, a
  `frame-slice-sample-share` basis, and five `UnattributedReason`s.

**How the done-when is demonstrated**, in `packages/corpus/src/capture.test.ts`, all through
`attributeCapture`:

- *Declared culprit at declared tier.*
  - `derive-in-render … > development: the component is known, at high confidence, from fiber
    timings`; `production: the component is sampled, under the name the source map gives back`;
    `{mode}: the function is a distribution over the replay, with the declared line first`.
  - `spans … > development: every rendered component, measured, with its share of the frame`;
    `production: the same names from samples, at the confidence a handful of samples earns`.
  - `innerhtml-rebuild … > {mode}/unforced` and `{mode}/forced`.
  - `vendor-listener … > {mode}: ranks the three slices as declared, and names each one's true
    owner`.
- *Degrades rather than guesses.*
  - `thin evidence … > derive-in-render/{mode}: inside long frames, a top function outside the
    declared range is never claimed`. Production's long frames hold 4 stacked samples with line 32
    in front; the answer there is `within-noise` and `low`, with a range of 15-85% (4x). Asserted
    as a rule, not as those counts.
  - `vendor-listener … > {mode}: the vendor's share rests on independent samples, not on a burst`.
    5 of 5 independent samples in development and 5.9 of 6 in production, against 13 of 13 and 13
    of 14 raw, so `low` (4x).
  - `spans … > development: says when equal components cannot be ranked`.
- *A large unattributed share.* `innerhtml-rebuild … > {mode}/unforced`: 88.9-90.3% unattributed,
  top-ranked, cross-checked: the empty-stack share is within 2.8 points of the share outside
  scripts. `moderate`, not `high`, because each frame holds 9 to 12 in-frame samples, fewer than
  the 21 that would let agreement confirm it. The largest named candidate is `rebuildRows` at
  9.7-11.1%, `low` (4x, both build modes).
- *The degraded tiers*, each by removing a signal from a real capture: `degraded tiers … > no
  profiler, …` (five tests), `no React hook, …`, `no source map, …`.

No test asserts a long-frame count. Assertions about frames are made of each frame the engine
returns.

**What moved in steps 3 and 4.** Raw counts are unchanged, so every figure those steps quote
still holds. Burst collapse moved sample-share weights in two fixtures only: `vendor-listener`, by
up to 26.9 points, and `spans`, by up to 5.8 (4x). `derive-in-render`'s weights did not move at
all, so the replay shares of 70.7% and 83.6% stand. The production `spans` corpus test, and the
unit tests that compared a whole weight or a total below 1, were updated for the new shape.

**The carried items.**

- *Replay population.* It is the function level's population by construction:
  `InteractionAttribution.functions` is taken over the interaction's window.
- *The 60% floor.* The model's range says what the standard-error note said. The 95% range of
  65 of 92 is 60.7-79.0%, and of the previous capture's 62 of 102 it is 51.1-69.7% (development,
  4x). The floor sits at the edge of one and inside the other. The floor itself is untouched.
- *Cross-check bounds.* Reproduced through the engine under `isWithinFrame`: 88.9-90.3% outside
  scripts with 88.9-91.7% empty stacks unforced, 14.3-16.9% with 10-30% forced (4x, both build
  modes).

Choices made without a human, each the conservative option:

1. **Overlap names components and gives them no share.** With no profile and no fiber timings,
   the hook still says which components rendered in a commit that landed in a script. They go on
   the script entry's evidence, and the commit's ranking is one `unattributed` candidate. An equal
   split would have been a number nobody measured. So `window-overlap` is still an unproduced
   `WeightBasis`, as is `sole-candidate`; both now say so in their comments.
2. **A timed commit is placed in a frame by a fit check, not by samples.** Its render must fit
   between the slice's start and the commit. All 17 timed commits in corpus frames fit
   (development, 4x). Where one does not, its components are not charged and a note says so. The
   profiler does not raise a component's confidence, because fiber timings never depended on it.
3. **A sampled share is never `high`.** The word is kept for a measurement or a confirmed
   subtraction. `derive-in-render` production's `OrderTable`, 67 of 69 samples, is `moderate`.
4. **A frame's function split is pooled per interaction and site**, not across the capture,
   because React registers one listener for every event. In production `derive-in-render` that
   pool is one frame's 4 samples. The stable answer is the interaction's `functions`.
5. **The cross-check is per frame.** Pooling it over a replay's frames would check the 8 frames
   that are now unchecked. Not built.
6. **Production React frames list functions**, and the components are in the interaction's
   ranking. Multiplying a slice by a commit window's component shares would stack two estimates
   over two different windows.

Not done, and known:

- Why Chrome emits bursts is not established. The model only declines to count them twice.
- The boundary sample from step 4's C9 is still charged to the forced-layout slice, so one
  development `vendor-listener` pool shows `vendorTrack` at 1 of 51 samples there.
- `third-party-script` is still an unused subject. Naming a vendor is `later.md`'s.
- `findings.md` is unchanged. The two new measurements, the burst gaps and the cross-check's
  denominator, are recorded in `profiler.ts` and `frame-attribution.ts`.

### Step 5 cycle — review findings and the orchestrator's decisions

The refactor is committed as `3930f5d`. Two parallel cold reviewers again. The figures reviewer
reproduced almost every figure from raw JSON, its own Wilson arithmetic and `trace-mapping`,
independently of the engine. **No figure was fabricated.** Two were wrong: the vendor slice share,
and a misread press count that had also crept into this file. The governing principle for the
decisions below is "the numbers must be honest": where a confidence level claims more than its
evidence holds, the level comes down, even when that changes a corpus assertion. The reviewer
called three of these morning decisions. I took the conservative side of each tonight and listed
it under Questions.

**Code reviewer (C):**
- **C1, accepted** (in Questions). A subtraction whose cross-check "agrees" was `high` on 5–14
  in-frame samples, which is fewer than the 21 the same module requires before a sampled share is
  even `moderate`. Agreement is now only as strong as the samples that could have disagreed:
  `high` needs a usable sample count. Every corpus unattributed candidate therefore becomes
  `moderate`. Step 5's done-when still holds, because `innerhtml-rebuild` still ranks a large
  unattributed share first and does not give a confident wrong answer.
- **C2, accepted.** A `measured` weight whose grid share exceeds the usable half-width is `low`,
  not `high`. Nothing in the corpus is affected.
- **C3, accepted.** The no-profiler commit remainder's basis becomes `sole-candidate`, not
  `fiber-self-time-share`.
- **C4, accepted** (in Questions). A per-frame function share drawn from a pool was graded by the
  pool's sample count. It is now graded by the frame's own count, `inOwnWindow`, which keeps the
  pool's range. `describeConfidence` says "of the N samples at this site across the interaction".
  This applies `findings.md` point 2, "per-frame percentages remain unusable".
- **C5, accepted, with F3.** The 21-sample threshold is documented as the project's chosen bar,
  not as a derivation. `findings.md`'s ±20 points at five samples is about one standard error; the
  95% Wilson half-width at five samples is ±33 points. The constant is kept.
- **C6, accepted.** Frames outside the profile's span become
  `unchecked: frame-outside-profile` with a note, not `too-few-samples`.
- **C7, minimal fix accepted.** An agreeing or unchecked subtraction's range is now ±grid, not a
  single point. **Not done:** whether an unchecked subtraction's range should be `[0, fraction]`.
  That is in Questions.
- **C8, C9, C10, C11, accepted:** the stale `totalWeight` doc, per-commit fit-check notes plus a
  note for the zero-JavaScript case, a throw instead of a silent drop, and three stale comments.
- **C12, accepted.** Burst collapse is bounded by the burst's span, so a faster sampler is not
  collapsed into one sample. Nothing in the corpus changes.
- **C13, accepted** as documentation: a frame ranking can list one function twice, once per slice.
- **C14, C15, C16, C17, accepted.**
  - `ResolvedProfile | null` everywhere, carrying `independence`.
  - `attributeCapture` builds per window and stops re-finding interactions by label.
  - Each frame is decomposed once, and pools are keyed by slice.
  - Subtraction support and scaled sample support each get a constructor.
- **C18, partly accepted.** Split the profiler-tier join out of `component-attribution.ts` into
  `component-samples.ts`. The further tally-plumbing split is left; one seam per pass.

**Figures reviewer (F):**
- **F1, accepted.** The vendor slice is 7.7–9.0%, not 7.7–8.9%; production reaches 9.018%.
- **F2, accepted.** Production `derive-in-render` produced a long frame after **1** of 24 presses,
  not 2. LoAF reported 3 frames: the page load at 48.9ms, one at 443.2ms in the replay, and one at
  115168.1ms after the window closed. The "2" came from `sawNewFrame`, which counted the page load. Fixed in `capture-attribution.ts`. The
  orchestrator fixed both occurrences in this file, including its own note on step 4's
  done-when. The in-frame population figures are unaffected.
- **F3, accepted** with C5.
- **F4, accepted.** `capture.test.ts:311` asserted `frames` equal to `[]` for `state-owner-self`,
  which is a long-frame count of zero. It now asserts the components without touching `frames`.
  The same applies to `components.test.ts:192` and `:344`, from step 3 tonight. **Carried to step
  6:** `records.test.ts` asserts frame counts at `:140`, `:182`, `:422` and `:489`, from commit
  `024ca24` before tonight. Step 6 rewrites that suite, so the rule is applied there.
- **F5, accepted.** The `within-noise` rows of the lead test were chosen from engine output. The
  comment now says so, and records that `initial-mount`'s `clear` lead for `App` comes from
  host-fiber time charged to `App`, the step 3 #1 artefact, not from a real difference.
- **F6, F7, accepted:** the build mode and throttle on "one 12ms slice", and the v0.3 cadence of
  14.2–14.7ms named apart from the previous capture's 12.2ms.
- **F8, accepted.** The `innerhtml-rebuild` tests also assert the function name, and that its
  definition line falls at or before the ground truth's range.
- **F9, accepted.** `.sort` is read from the ground truth's `expectedSourceText`, not hard-coded.

### Step 5 — closed

The fix pass applied every accepted finding. `pnpm check` is green at 289 tests (161 core, 128
corpus). A before-and-after snapshot of all 8 captures, run with and without the profile, changed
exactly as decided and in nothing else:
- 103 agreeing unattributed candidates went from `high` to `moderate` (C1).
- 32 pooled function candidates went from `moderate` to `low` (C4).
- Every subtraction range is now ±grid (C7).
- 3 frames are now `frame-outside-profile` (C6).
- The no-profiler commit remainder's basis is now `sole-candidate` (C3).

No weight, subject, tier, order or lead changed. Two consequences are worth reading:
- **The no-profiler `innerhtml-rebuild` test weakened** from "strictly lower confidence than with
  the profile" to "never higher". C1 forces this, because both runs are now `moderate`. The
  degradation still shows elsewhere: script time drops to `loaf-script-registration`, and
  `workingFrom` names the missing profiler.
- **F8 needed a ground-truth field.** `rebuildRows` was not in the `innerhtml-rebuild` ground
  truth, so `acceptableAttribution.sampledListener` was added, holding the function, line 133 and
  its expected source text. The anchor suite validates it against the source.

Step 6 starts next.

## Questions for the morning

- **The step 5 confidence levels were lowered where review found them over-claiming.** Chosen
  tonight, as the conservative side:
  - A cross-check "agreement" makes a subtraction `high` only on 21 or more in-frame samples, the
    same bar as estimating a share. Every corpus unattributed answer is therefore `moderate`, not
    `high`.
  - A per-frame function share is graded by that frame's own samples, not by its interaction's
    pool.

  The case against: LoAF's partition is exact, so the subtraction itself is measured, and the
  cross-check only confirms that nothing attributable hid in the gap. On that view agreement at
  9–12 samples could still earn `high`.
- **Should an unchecked subtraction's range be `[0, fraction]`?** Unreported sub-5ms script could
  hide in the gap. Not done tonight; the range is ±grid. Doing it would make the no-profiler
  `innerhtml-rebuild` lead `within-noise`.
- **Should "profiler header absent → infer from overlap" produce weighted candidates?** Step 5
  built it conservatively. With no profile and no fiber timings, the components the hook saw render
  are attached as `fiber-rendered` evidence on the script entry they overlapped. The commit's
  ranking is then a single `unattributed` (`no-profiler`) candidate, and no share is invented for
  those components. The `window-overlap` and `sole-candidate` weight bases exist, but nothing
  produces them yet. Kept this way overnight, because it never states a number the evidence does
  not hold. If you want overlap candidates with weights, that is a design decision about how much
  confidence overlap alone earns.
- **Should the derive-in-render histogram narrative live only in `findings.md`, with the README,
  the ground truth and the tests citing it?** It is currently told in six places. Not consolidated
  tonight, because doing so means cutting measurement prose in an unattended run.
- **Should the replay floor of 0.6 stay at step 4's declared 60%?** One capture measured 60.8% of 102, only
  0.16 standard errors above it, so a future re-capture may flap. Kept at 0.6, with the
  standard error noted beside it.
- **Step 4's "60%+ of in-frame `OrderTable` samples" is now measured over the replay, every sample
  inside the drive's steps, instead of inside long frames.** In-frame production holds 3 samples
  after the re-capture, because LoAF reported a long frame after only 1 of 24 presses (3 frames: the page load, one in the
  replay, and one after the window closed), against 5 of 24 before (not re-checked for the same page-load misreading).
  Orchestrator's decision: accept the replay population. It is the same function work, a frame
  under the 50ms threshold is still a slow keypress, and it follows the settled rule that long-frame
  counts are not assertable. The in-frame share is still reported. If you want the claim limited
  strictly to long frames, production needs more presses per run, which means a fixture plan change
  and a re-capture.
- **Should the root package depend on `@frameblame/core` so that `spike/fixtures.ts` can drop its own
  `BuildMode`?** Chosen for tonight: leave the duplicate, because it avoids a lockfile change in an
  unattended run.
