# Handoff — v0.1 spike

You are starting this project from an empty directory.

Read `CLAUDE.md` first: it carries what the tool is, the three signals it joins, the invariants,
and the quality bar. This document carries only the work for this session.

## Why this is worth building

No tool does this today. As of November 2026, six RUM vendors collect LoAF's
`sourceCharPosition` and none resolve it to an original pre-bundle file and line; zero of
fifteen attribute a frame to a framework component. Sentry and Datadog ship both performance
APIs this tool joins and correlate neither.

The reason the deep signal is available here and not to them: the JS Self-Profiling API needs a
response header and carries sampling overhead. Unacceptable on real users' devices; free on a
dev server.

## The work

The one real technical risk is that the join is ambiguous more often than it is useful. This
session exists to find that out in a day rather than a month. Build the smallest thing that can
answer it, and resist building the engine until it has answered.

### 1. Scaffold the workspace

pnpm workspaces, five members:

```
packages/core       pure engine — the join, the confidence model, no DOM access
packages/agent      thin in-page collector — installs observers, buffers, emits
packages/react      React adapter — reads the DevTools hook for component identity
apps/viewer         the separate-tab UI (Vite + React)
fixtures/           apps that jank on purpose, with known ground truth
```

Tooling: `vitest` for `core`, Playwright for the fixture suite, `@jridgewell/trace-mapping` for
source maps, `tsdown` (or `tsup`) for library builds, `changesets` for releases,
`BroadcastChannel` for agent→viewer transport behind an interface.

Hold off on a build orchestrator — five members and no build-time problem.

**Done when** `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` all
succeed from the repo root.

### 2. Write fixture #1

A real interaction that janks for a known reason, in a Vite + React app under `fixtures/`. Each
fixture declares its **ground truth** — the component and line genuinely responsible — in a
sibling file the test suite reads.

The human chooses which bug this is. If no choice is recorded in the repo, ask before inventing
one: a fixture built from a bug the author has actually been bitten by is how they learn whether
the output is *useful*, not merely *correct*.

**Done when** the fixture janks reproducibly under CPU throttling, and its ground truth is
recorded in a form a test can assert against.

### 3. Dump the raw streams

A bare script. No engine, no abstraction, no UI. It performs one interaction against fixture #1
and writes the raw LoAF entries, the raw profiler trace, and the raw React commit records to
three files.

**Done when** all three files contain data for the same interaction, with timestamps on a common
clock.

### 4. Answer the go/no-go

By hand, from those three files: can you identify the fixture's known culprit from the signals,
and is the correspondence clean or a coin-flip? Write the finding — including the ambiguity you
found — into `findings.md`.

**Done when** `findings.md` states plainly whether the join identifies the ground-truth culprit
on this fixture, and what made it hard.

### Stop there

The engine, the viewer, the confidence scoring and the remaining fixtures all depend on the
answer to step 4. Report the finding and let the human decide what follows.

Everything beyond this session is in `later.md`, each item with the reasoning that deferred it.
Build none of it now — several will feel urgent.

## Needs the human

- **The package name.** Avoid a `react-` prefix: the core is framework-agnostic with a React
  adapter, and the prefix caps the project at the React story.
- **Which bug is fixture #1.**
