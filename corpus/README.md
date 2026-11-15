# Corpus — captured signals, kept

Eight captures: every fixture under `fixtures/`, in both build modes, with the three raw signals
recorded as the browser reported them. This is the engine's test input. `packages/core` is pure
and has no I/O, so `packages/corpus` reads these files and hands the records over; nothing here
needs a browser, a dev server, or a network.

Written by `pnpm spike:corpus`. Do not edit a file in here by hand — recapture instead.

```
corpus/
  manifest.json                     what was captured, when, and how long it took
  <fixture>/<development|production>/
    run.json                        read this first: the plan, the steps, the counts
    loaf.json                       long animation frames, plus whatever the fixture published
    profile.json                    the sampled profile, with each script's source map
    react-commits.json              DevTools-hook commits and React's performance.measure spans
    source-windows.json             the served text around every attributed position
```

## Why it is kept rather than regenerated

Because it could not be, and that cost the project real evidence. The v0.1 spike overwrote one
output directory on every run, and the coldest, strangest run of the session — a 226ms frame in
which 14 of 21 samples had no JavaScript on the stack — was overwritten before anything was
copied aside. `findings.md` still cites those numbers and marks them as a dangling citation,
because no file in this repo can produce them any more.

Three of that spike's conclusions were also reversed on review. A corpus is what makes the next
reversal cheap: the claim changes, the evidence does not move.

## Reading a run

Start with `run.json`. It carries the drive plan and one record per step, so a frame can be
traced back to the interaction that caused it — which matters because several fixtures make a
claim *per interaction* rather than per frame. Each step records the long-frame count before and
after it, and each action records whether a long frame followed it at all. An action that
produced no frame is data: LoAF reports nothing under 50ms, and on two of these fixtures that
silence is part of the finding.

Every file repeats the same envelope — fixture, build mode, CPU throttle rate, browser version,
run id. That duplication is deliberate: a millisecond figure quoted without the build mode and
throttle rate that produced it is indefensible, and these files are meant to be readable one at
a time, years later, by someone who does not have the others open.

`source-windows.json` is the link the v0.1 dumps were missing. The profiler reports a position
in the script the browser executed, which in development is Vite's transform of a module and in
production is a minified bundle — neither of which survives the server being stopped. So a few
hundred characters of the served text around every attributed position are stored with it, and
the resolution chain the project's central claim rests on can be walked end to end from disk:

```
profiler frame   OrderTable.tsx (generated) 27:108
served text      "(a, b) => a.customer.localeCompare(b.customer)"
inline map       → OrderTable.tsx original line 36   ← the declared dominant culprit
```

## What these numbers are not

They are one capture each, on one machine, in one thermal state, under 4× CPU throttling on
Chromium 159. They are evidence that a signal exists and has a shape, not a benchmark. The
capture's own warm-up run makes the point: the handoff warns that the first run of a session
behaves differently enough to mislead, so `spike:corpus` runs one capture first and deliberately
does not promote it. The run id is in `manifest.json` under `warmUp` if the difference is of
interest; its files are in `spike/out/`.

One figure in here is a measurement of the threshold rather than of the fixture. `derive-in-render`
sits close enough to LoAF's fixed 50ms reporting threshold that its long-frame *count* moves with
how warm the machine is. From the same 24 presses, on one machine within one hour: 14, 14, 14, 23
and 14 in development, and 14 then 6 in production. The aggregate line histogram is the stable
quantity — 69% to 93% of samples in the declared line range, with line 36 ranked first every time
— and it is what the suite asserts on, at a floor of 60%. **Never assert on a frame count.**

## Recapturing

```
pnpm spike:corpus                        # everything, both modes, with a warm-up
pnpm spike:corpus spans                  # one fixture, both modes
pnpm spike:corpus spans --no-warm-up     # skip the warm-up on an already-warm machine
pnpm spike:dump <fixture> <mode>         # one capture into spike/out/, not promoted
```

Never run two captures at once. Each fixture binds a fixed port and they will fight over it; and
even on different ports, two browsers sharing a CPU make every millisecond figure in both runs
meaningless.
