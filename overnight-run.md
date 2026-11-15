# Overnight run — autonomous, no human available

A one-off brief for a single unattended session. Delete it when the work is done.

Read `CLAUDE.md`, then `findings.md` in full, then `handoff.md`. Then read the seven modules in
`packages/core/src` and `packages/corpus/src/records.ts`: their block comments carry what the
dumps actually contain, which is not what the specifications say and not what `findings.md` said
two rounds ago.

**Nobody is awake.** Never stop to ask a question and never end a turn waiting for an answer. If
you hit something genuinely undecidable, write it under a `## Questions for the morning` heading
in `handoff.md`, choose the most conservative option, say in that section which one you chose, and
keep going on everything that is not blocked by it. An idle session is the only outright failure
here.

## Where things stand

Steps 1 and 2 of `handoff.md` are built: the record types, the frame partition, the vocabulary for
ranked causes, and the adapter that parses all eight captures into them. `pnpm check` and
`pnpm build` pass at 114 tests. There are no heuristics — nothing attributes a frame to a
component, weights a sample, or resolves a source map yet.

## The cycle

After **every** step below, including step 0, run this three-part cycle before moving on:

1. **Refactor**, in a subagent. Behaviour-preserving cleanup of the code that step touched and the
   code it leans on.
2. **Review**, in a subagent. A fresh reader with no memory of your reasoning, reviewing the diff
   since the last commit.
3. **Fix**, in this session. Apply what the review found, decide against what you disagree with,
   and record both in `handoff.md`.

Then run `pnpm check`, commit, and start the next step. The refactor and the review are the only
work that goes to subagents; the implementation steps are yours, because each one's output is the
next one's input and judgement does not fan out.

Two rules bind the refactor every time it runs:

- **Behaviour is fixed.** The same tests pass, with the same assertions, before and after. A
  refactor that needs a test changed is not a refactor — stop it and record why.
- **A comment that records a measurement, a browser quirk, or the reason a heuristic is shaped the
  way it is may be moved but never deleted.** This repo's comments are the part that cannot be
  re-derived; `findings.md` exists because three conclusions were lost once already. A tidy-up
  that shortens them has destroyed the most valuable thing in the file.

The review subagent's brief, each time: does this code do what its comments claim; does it
over-claim or under-claim anywhere; does it meet the completion criteria the step declares in
`handoff.md`; and is any number in it quoted without the build mode and CPU throttle rate that
produced it. Not style, not preferences.

## Step 0 — version control, cleanup, and the one capture

Do these in order, and do them first.

1. `git init`, a `.gitignore` check, and one commit of everything as it stands. This is the
   baseline every later step is diffed and reverted against. `corpus/` is 6.6MB of captured
   evidence and belongs in the commit — it is the test input, and the project has already lost a
   run by treating dumps as disposable.
2. The refactor pass, scoped as above. The real debts, rather than a sweep: `corpus.ts` and
   `provenance.ts` each define a `BuildMode`; `spike/` has grown seven modules with some
   duplication between `collect-run.ts` and `dump-raw-streams.ts`; `records.ts` is long enough to
   split along the three signals if that reads better. `corpus.test.ts`'s local readers are
   **deliberately** throwaway and step 6 deletes them — leave them alone until then.
3. The collector change, which is the only reason a browser is needed tonight. In
   `spike/collectors.ts`: record a parent id per fiber in `describeCommit`, and add
   `forcedStyleDuration` and `forcedLayoutDuration` to `serializeScript`, which is missing them
   because the ambient declarations it was written from were. Then update
   `packages/core/src/react.ts`, which currently states the absence of fiber linkage as a property
   of the capture, and `packages/corpus/src/records.ts` to read it.
4. **Re-capture all eight runs in one pass**: `pnpm spike:corpus`. All eight, serially, in one
   invocation. Not the subset the tests read — the corpus's whole value is that its entries are
   comparable to each other, and a previous session broke that by re-capturing two.
5. Then the cycle, then commit.

While the capture runs, **run nothing else**. No subagents, no builds, no test runs. Each fixture
binds a fixed port, and two things sharing this CPU make every millisecond figure in the capture
meaningless. This is the one window in the night that is strictly serial.

After the capture, re-derive any measured figure that moved and update it wherever it is quoted —
`findings.md`, the four `ground-truth.json` files, and the comments in `packages/core`. Derive them
with a script; never transcribe a number by hand. Five comments in those files were once found
contradicting the values beside them after a round of hand-editing.

## Steps 3, 4, 5, 6

Work `handoff.md`'s steps 3, 4, 5 and 6 in order, each followed by the cycle and a commit. Their
completion criteria are declared there and are the definition of done. Do not reopen the four
settled items at the bottom of that document, and do not build anything from "Do not build these
yet".

What fans out safely, once the capture is finished: per-fixture accuracy checks, and a survey of
what each source map can and cannot resolve. What does not: the confidence model in step 5, which
has to be one coherent thing.

The traps that cost this session the most time, all measured, all recorded in the module comments
you will have read:

- React emits spans in a development build only, and marks component spans with a U+200B prefix
  that nothing else distinguishes. `Mount` sits on the same track and carries no prefix.
- `actualDuration` and `priorityLevel` are null in production, and the component names are
  minified and not globally unique across bundles.
- `innerhtml-rebuild` and `vendor-listener` ship no source maps in either build mode. They are the
  degradation tier in its natural habitat, not a gap in the corpus.
- The profiler starts before the drive in both `spans` runs, so samples precede the first
  interaction.
- The empty-stack share that means anything is the in-frame one. The run-wide share is 68-99% and
  is mostly idle time between interactions.
- The profiler's 1-based column becomes a source map's 0-based column in exactly one place,
  `profiledFramePosition`. Keep it that way.
- No suite may assert on a long-frame count. The aggregate line histogram is the stable quantity.

## Keeping the night recoverable

- `pnpm check` must be green before every commit. If you cannot get it green after three honest
  attempts, `git reset --hard` to the last commit, write what you tried and what failed into
  `handoff.md`, and move to the next step rather than leaving the tree broken.
- Commit after each step and after each fix round, with a message saying which step it was.
- Keep `handoff.md` current as you go: what is done, what each review found, what you decided
  against and why. It is what gets read in the morning.
- When every step is done and the gate is green, write a short `handoff.md` section stating what
  is finished and what the next session should pick up, then end the loop.

Use `caffeinate -dims` for anything long-running. The capture drives a headed browser against a
real compositor, so the display has to stay awake as well as the system.
