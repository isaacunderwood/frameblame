# Handoff — v0.2, the engine

Read `CLAUDE.md` first: it carries what the tool is, the invariants and the quality bar.

Then read `findings.md` **in full** before writing any code. It is the record of the v0.1 spike
and the adversarial review that followed it, and it reverses three conclusions that the original
design was built on. Anyone who skips it will rebuild the wrong thing confidently. The previous
session's brief is preserved as `handoff-v0.1-spike.md`; it is history, not instructions.

## Where things stand

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass from the
repo root. `pnpm check` runs the first four together.

What exists:

- **`packages/core`** — `createScriptLineIndex` and `lineColumnAt`, pure, 19 tests. Nothing else.
  No engine: it was waiting on the go/no-go, which has now been answered.
- **`packages/agent`** — the `Transport` interface and a `BroadcastChannel` implementation.
  No collectors; those are still in the spike.
- **`packages/react`** — the hook key and a presence check. No commit records yet.
- **`apps/viewer`** — a page that counts records arriving on the channel. Nothing to show yet,
  deliberately.
- **`fixtures/derive-in-render`** — jank with declared ground truth, measured and recorded.
- **`spike/dump-raw-streams.ts`** — drives one keystroke, dumps three raw streams.
- **`spike/archive/`** — the throwaway probes and dumps behind every claim in `findings.md`,
  preserved verbatim and held outside the lint gate. Read its README before writing a new probe;
  the one you want may already be there.

## The work

The verdict was go, so the engine is unblocked. But the findings that shape its design currently
rest on evidence that cannot be re-run, and one of those findings was already wrong once. Steps 1
to 3 fix that, and they are not a detour: they produce the corpus the engine is tested against.

### 1. Make the spike produce a corpus, not a snapshot

Three changes to `spike/dump-raw-streams.ts`, all of them already specified as open items at the
bottom of `findings.md`:

- **Write to a timestamped run directory** rather than overwriting `spike/out/`. Overwriting is
  how the cold run's evidence was lost, and that run is cited in `findings.md` as a dangling
  citation because of it.
- **Add a replay mode** — N presses rather than one, alternating so the query actually changes.
  Replay is no longer a nicety: it is what turns single-line attribution from a 2-of-3 coin flip
  into 73% of samples and 13 of 14 frames. `spike/archive/probe.ts` already implements this and
  was verified to produce 14–15 long frames in dev and 6 in production; adapt it rather than
  rediscovering it.
- **Store a window of source text** around each attributed position. `captureResourceSources`
  currently keeps each script's length and source map but not its text, so the "served text" link
  in the resolution chain cannot be verified from a dump. A few hundred characters either side is
  enough; storing whole bundles is not (react-dom is over a megabyte).

That last one needs the inverse of `lineColumnAt` in `core` — line and column to character
offset, which is `lineStarts[line - 1] + column`. It is three lines plus tests, and it is the
same primitive the LoAF path needs in the other direction, so it earns its place regardless.

**Done when** two consecutive runs leave two complete, independently readable run directories,
a replay of 24 presses produces the frame counts above, and the resolution chain in `findings.md`
can be re-derived from a dump with no dev server running.

### 2. Promote the three throwaway fixtures

Each becomes a real fixture under `fixtures/`, with a `ground-truth.json` in the shape
`derive-in-render` already uses. Sources are in `spike/archive/`.

- **`spans/`** → the React props-identity gate. Five components rendering ~25ms each on mount and
  not one `performance.measure` between them. This is the fixture that caught the session's worst
  error; it is the regression test that stops it recurring.
- **`vanilla/`** → two fixtures, or one with two modes: the `innerHTML` rebuild where 93% of the
  frame is unattributable, and the three sibling listeners where LoAF attributes a vendor's cost
  to the first-party line that registered the listener.

Four fixtures total. `later.md` defers the *full* corpus and says five is a harness to develop
against — this is that harness, not an early claim on the deferred work.

**Done when** each fixture janks reproducibly under the settings in its own `ground-truth.json`,
and `findings.md`'s production, frame-decomposition, third-party and span-gate claims can each be
reproduced by running something in this repo.

### 3. Capture the corpus

Run every fixture, development and production, and keep the dumps. These become the engine's test
inputs.

**Done when** `packages/core` can be given a real dump from disk and the matching
`ground-truth.json`, with no browser involved.

### 4. Build the engine

Only now. In `packages/core`, pure as the invariants require:

- **Record types** derived from what the dumps actually contain, not from the specs. The specs
  describe fields Chrome does not ship (`sourceLine`, `ProfilerSample.marker`) and omit behaviour
  Chrome has.
- **The join**, with the division of labour `findings.md` arrived at: LoAF is the trigger and the
  denominator; the React DevTools hook plus fiber `actualDuration` is the primary component signal
  in development; the profiler plus the shipped source map is the whole production story and the
  only source of third-party attribution.
- **The confidence model**, whose job is now concrete rather than theoretical: the component is
  known, the function is a distribution over replayed frames, the statement is unavailable from
  inside the page at all, and the unattributed remainder is cross-checked against the share of
  profiler samples with an empty stack.

Tests are the corpus: given this dump, produce this attribution, and assert it against the
fixture's declared ground truth. That is the accuracy suite in embryo and it needs no browser.

**Done when** `pnpm test` attributes every fixture in the corpus to its declared culprit at the
declared tier, and says so with a confidence that degrades rather than guesses where the evidence
is thin.

## Do not build these yet

Each is deferred for a reason that got *stronger* this session, not weaker:

- **The viewer.** Nothing to show until the engine emits something real.
- **The CDP-driven CLI**, despite two findings pointing at it — true per-statement attribution via
  `positionTicks`, and a trigger that can see tasks under LoAF's 50ms threshold. It is a second
  collection path, and one should work end to end first.
- **The Vite annotation plugin.** The production result made this *less* urgent: the profiler plus
  a shipped source map recovers the component name from the map's `names` field, with no hook and
  no build step.

Everything else is in `later.md`, each item with the reasoning that deferred it. Read it before
proposing a feature.

## Practical notes

- **Node is installed via fnm under `~/.local`**, with PATH set in `~/.zshenv`. If a shell says
  `node: command not found`, source that file.
- **The spike binds port 5181.** Never run two spikes concurrently — whether in two terminals or
  two subagents. They will fight over the port and overwrite each other's output. This is the
  single most likely way to waste an hour.
- **Discard the first run of a session**, or report it separately. It behaves differently enough
  to mislead: 84ms frames against 59–63ms once warm.
- **Every millisecond figure carries its build mode and CPU throttle rate.** This is an invariant,
  not a style preference.

## Already decided — do not reopen

Both settled on 2026-11-14, at the close of the session that wrote this document:

- **Step 2 is worth its cost.** Build all three fixtures, not just the production one. The
  reproducibility is the point.
- **`learning/` stays.** It is a teaching workspace that lives in this repo, excluded from the
  lint and format gate on purpose. Leave it alone; it is not part of the tool and nothing in the
  tool may depend on it.

Nothing else is waiting on the human. Work the steps in order.
