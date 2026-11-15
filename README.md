# frameblame

Which component caused that janky frame, and on what line — plus the share of the frame that
was a third-party script, forced layout, or unattributable.

A dev-time tool for React apps. It joins three signals on one timeline: **Long Animation
Frames** as the cheap trigger (which frames were bad, how bad), the **JS Self-Profiling API** as
the expensive explanation (real sampled stacks, source-mappable), and **React's DevTools hook**
for component identity.

**Status: corpus captured, engine next.** The correlation has been verified against a fixture
with declared ground truth, re-run adversarially against three more, and written up in
[`findings.md`](./findings.md) — including what was ambiguous and the three conclusions the
review round reversed. All four fixtures now live in `fixtures/`, and every claim in that
document is re-measured from captured signals in [`corpus/`](./corpus/README.md), which `pnpm
test` asserts against without launching a browser. There is no engine and no UI yet, on purpose:
both were waiting on that answer.

Two limits worth knowing before reading further: from inside the page the profiler reports the
line a function was *defined* on, not the line executing, so attribution is function-level
rather than statement-level; and LoAF's 50ms threshold hides jank that sits just under it — on
the fixture here, 18 of 24 interactions that burned ~45ms of main thread produced no entry at
all.

## Why it can do this when RUM vendors cannot

The deep signal needs a `Document-Policy: js-profiling` response header and carries sampling
overhead. That is unacceptable on real users' devices and free on a dev server.

As of November 2026, six RUM vendors collect LoAF's `sourceCharPosition` and none resolve it to
an original pre-bundle file and line; zero of fifteen attribute a frame to a framework
component. Sentry and Datadog ship both performance APIs this tool joins and correlate neither.

## Layout

```
packages/core       pure engine — the join and the confidence model. No DOM, no I/O.
packages/corpus     reads captured dumps off disk, so core never needs to. Tests only.
packages/agent      thin in-page collector — installs observers, buffers, emits
packages/react      React adapter — component identity
apps/viewer         the reporting UI, in its own tab
fixtures/           apps that jank on purpose, each with declared ground truth
corpus/             those fixtures' signals, captured and kept. The engine's test input.
spike/              the capture: serves a fixture, drives it, records what the browser said
```

The UI lives in a separate tab and never inside the measured app: a panel rendered into the host
contaminates the frames it reports on, and a React panel pollutes the very commit stream used for
attribution — loudest during slow frames, when it updates most.

## Commands

```
pnpm install
pnpm check          # format:check, lint, typecheck, test
pnpm build
pnpm spike:corpus   # capture every fixture in both build modes into corpus/
pnpm spike:dump     # one capture into a timestamped spike/out/ directory
pnpm dev:fixture    # the derive-in-render fixture, on :5181
pnpm dev:viewer     # the viewer, on :5180
```

The other fixtures run the same way, each on its own fixed port:
`pnpm --filter @frameblame/fixture-spans dev` (:5186), `…-innerhtml-rebuild` (:5188),
`…-vendor-listener` (:5190). Never run two captures at once — they will fight over a port, and
two browsers sharing a CPU make every millisecond figure in both runs meaningless.

Requires Node 22 or newer (`.node-version` pins the version this was developed against) and
Chromium for the fixture suite: `pnpm exec playwright install chromium`.

## A note on the toolchain

TypeScript is pinned to 6.0.3 rather than 7.x because `typescript-eslint` declares
`typescript >=4.8.4 <6.1.0`, and the type-checked lint configs are not negotiable here. It moves
up when that peer range does.

## License

MIT.
