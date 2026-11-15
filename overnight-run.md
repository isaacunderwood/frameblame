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

## Assume you will forget this

This is one long session. When its context fills, it is summarised and continues — so the thing
that fails overnight is not running out of room, it is a fact losing its reason on the way through
a summary. Three of this project's conclusions were reversed once because exactly that happened to
a human.

So write everything down as you go, and trust files over memory:

- **Record a step's outcome in `handoff.md` before starting the next one**, never after. A summary
  landing between doing the work and writing it down is how the night loses a step.
- **Never read a file in `corpus/` directly.** They run to 1.9MB each and one `Read` would cost a
  tenth of the window. Query them with a short `node -e` script, through
  `packages/corpus/src/records.ts`, or in a subagent that reports figures rather than contents. The
  same goes for anything under `spike/archive/`, which has a 5.1MB file in it.
- **Push the heavy reading into subagents.** Their tool output stays out of this session; only
  their conclusion comes back. That is why the refactor and the review are subagents, and it is
  also the right shape for any survey across many files.
- **Put a fact in a test or a comment, not in your head.** If you measure something, the figure
  belongs beside the code that relies on it, with the build mode and throttle rate that produced
  it.
- When you reorient after a summary, this brief plus `handoff.md` plus the module comments are the
  state. Re-read them rather than reconstructing what you were doing.
- **Verify before you assert.** `pnpm check` green is the floor, not the proof: it catches an
  invented API but not an invented measurement. Any figure you write down comes from a script you
  ran against `corpus/` or from a test that passes, and the next section's review exists to catch
  the ones that came from neither. If you cannot verify a number, do not write it.

## Models

Run the orchestrator and every subagent on **Opus 5.5** (`claude-opus-5-5`) at **effort high**. Its
default effort is `medium`, one level below what agentic work wants, so set it rather than inherit
it. The reason for Opus over Fable 5.2 is the usage ceiling, not capability: Fable costs twice as
much per token and takes longer turns, so it reaches the limit in roughly half the wall-clock time,
and a loop that stalls at 3am loses the whole night. Steps 3 to 6 are execution against explicit
criteria with a review pass behind each, which is not where the extra headroom pays.

The exception is **step 5, the confidence model** — the only open design problem left. Spawn that
one step's subagent with the `fable` model override, then go back to Opus for its refactor, review
and fix cycle. If Fable is unavailable, do step 5 on Opus at effort `xhigh` and say so in
`handoff.md`.

## Where things stand

Steps 1 and 2 of `handoff.md` are built: the record types, the frame partition, the vocabulary for
ranked causes, and the adapter that parses all eight captures into them. `pnpm check` and
`pnpm build` pass at 114 tests. There are no heuristics — nothing attributes a frame to a
component, weights a sample, or resolves a source map yet.

## You are the orchestrator, and you hold almost nothing

**Every step below runs in its own fresh subagent, one at a time.** Not because the work fans out —
it does not, each step's output is the next one's input — but because a fresh agent starts with an
empty context. That is what keeps a step's working memory from accumulating in this session and
being summarised into a half-remembered version of itself later. You delegate, read the conclusion,
check it against the repo, commit, and move on.

Two consequences, both binding:

- **Never use a `fork` subagent for a step.** A fork inherits this context, which defeats the
  entire point. Use a general-purpose agent with a brief that names the files to read first.
- **Run one at a time.** Never two steps at once, and nothing at all while the capture is running.

Each step's brief must be self-contained, because the agent running it knows nothing: name the step
and its completion criteria from `handoff.md`, name the files to read before writing anything
(`CLAUDE.md`, the relevant `packages/core` modules, and `findings.md` where the step depends on a
finding), and state that it must leave `pnpm check` green and report what it did rather than
narrating as it goes.

After **every** step, including step 0, run this three-part cycle before moving on:

1. **Refactor**, in a fresh subagent. Behaviour-preserving cleanup of the code that step touched
   and the code it leans on.
2. **Review**, in a fresh subagent. A reader with no memory of anyone's reasoning, reviewing the
   diff since the last commit.
3. **Fix**, in a fresh subagent, briefed with the review's findings. You decide which findings to
   accept and record that decision and your reasons in `handoff.md` yourself — that judgement is
   the one thing not to delegate, because it is what the morning will be read for.

Then run `pnpm check`, commit, push, and start the next step.

Two rules bind the refactor every time it runs:

- **Behaviour is fixed.** The same tests pass, with the same assertions, before and after. A
  refactor that needs a test changed is not a refactor — stop it and record why.
- **A comment that records a measurement, a browser quirk, or the reason a heuristic is shaped the
  way it is may be moved but never deleted.** This repo's comments are the part that cannot be
  re-derived; `findings.md` exists because three conclusions were lost once already. A tidy-up
  that shortens them has destroyed the most valuable thing in the file.

The review subagent's brief, each time. Ask for all six answers explicitly:

1. Does the code do what its comments claim?
2. Does it meet the completion criteria the step declares in `handoff.md`?
3. Does it over-claim or under-claim anywhere?
4. Is any millisecond figure quoted without the build mode and CPU throttle rate that produced it?
5. **Does every new number appear in the corpus?** For each figure introduced in the diff — in
   code, in a comment, in a test, in a ground truth, in `findings.md` — find it in `corpus/` or
   derive it with a script and say which. A figure that can be found in neither is fabricated, and
   that is the finding this review exists for above all others. The project has already shipped a
   wrong number twice and a dangling citation once.
6. **Is any of it hard to read, or is there a clearly more elegant way to write it?** Readability
   is a stated requirement of this repo, not a preference: this code is read by strangers judging
   whether the author is any good, and by agents with no memory of the conversation that produced
   it. In scope, and expected: code that cannot be followed on one read; a comment explaining
   *what* the code does because the code does not say it; a function doing two things; duplication;
   a misleading name; a module long enough that a real seam has appeared; a formulation that is
   simply clearer at identical behaviour.

On that last question, three rules keep it from becoming churn:

- **Bring the rewrite, not the opinion.** An elegance finding arrives as the actual replacement
  code, or a sketch precise enough to apply. "This could be cleaner" is not a finding.
- **Behaviour and recorded reasons outrank beauty.** If a clearer formulation loses a measurement,
  a browser quirk, or the reason a heuristic is shaped the way it is, it loses. `CLAUDE.md` is the
  arbiter: comments explain *why*, the code carries the *what*, and the obscure browser behaviour
  in this repo is deliberately over-documented rather than under-.
- **Prettier owns formatting and ESLint owns its rules.** Neither is review material. Line breaks,
  quote style and import order are already decided and already enforced.

A review that reports nothing is a suspicious review. A review whose findings are all preference
between equivalent spellings is a useless one.

## Version control, already set up

The repo is now a git repository with `origin` at `github.com/isaacunderwood/frameblame`, and the
work so far is one commit on the branch **`v0.3-engine`**, taken off `origin/main`. `user.name` and
`user.email` are set locally, so your commits will not fail for want of an identity. Work on that
branch; do not commit to `main` and do not merge.

The branch is pushed and tracking `origin/v0.3-engine`. Credentials are in the macOS keychain via
`gh auth setup-git`, so `git push` works without `gh` being on your `PATH` — which it is not, since
Homebrew's `bin` is absent from `~/.zshenv` and that is the only profile a non-interactive shell
reads. Use plain `git`, not `gh`.

**Push after every commit, and never let it block.** Prefix anything that touches the network with
`GIT_TERMINAL_PROMPT=0`, so that a credential that has expired fails in a second instead of waiting
all night on a username prompt. If a push fails, record it in `handoff.md` and carry on committing
locally — the local commits are the revert points and the night does not depend on the remote. Do
not retry a failed push more than once, and do not open a pull request; that is a morning decision.

## Step 0 — cleanup, and the one capture

Do these in order, and do them first.

1. The refactor pass, scoped as above. The real debts, rather than a sweep: `corpus.ts` and
   `provenance.ts` each define a `BuildMode`; `spike/` has grown seven modules with some
   duplication between `collect-run.ts` and `dump-raw-streams.ts`; `records.ts` is long enough to
   split along the three signals if that reads better. `corpus.test.ts`'s local readers are
   **deliberately** throwaway and step 6 deletes them — leave them alone until then.
2. The collector change, which is the only reason a browser is needed tonight. In
   `spike/collectors.ts`: record a parent id per fiber in `describeCommit`, and add
   `forcedStyleDuration` and `forcedLayoutDuration` to `serializeScript`, which is missing them
   because the ambient declarations it was written from were. Then update
   `packages/core/src/react.ts`, which currently states the absence of fiber linkage as a property
   of the capture, and `packages/corpus/src/records.ts` to read it.
3. **Re-capture all eight runs in one pass**: `pnpm spike:corpus`. All eight, serially, in one
   invocation. Not the subset the tests read — the corpus's whole value is that its entries are
   comparable to each other, and a previous session broke that by re-capturing two.
4. Then the cycle, then commit.

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
- Commit after each step and after each fix round, with a message saying which step it was, then
  push as above.
- Keep `handoff.md` current as you go: what is done, what each review found, what you decided
  against and why. It is what gets read in the morning.
- When every step is done and the gate is green, write a short `handoff.md` section stating what
  is finished and what the next session should pick up, then end the loop.

Use `caffeinate -dims` for anything long-running. The capture drives a headed browser against a
real compositor, so the display has to stay awake as well as the system.
