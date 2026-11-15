# CLAUDE.md

A dev-time tool for React apps that answers "which component caused that janky frame, and on
what line" — plus the share of the frame that was a third-party script, forced layout, or
unattributable.

It works by joining three signals on one timeline: **Long Animation Frames** as the cheap
trigger (which frames were bad, how bad), the **JS Self-Profiling API** as the expensive
explanation (real sampled stacks, source-mappable), and **React's DevTools global hook** for
component identity.

- `handoff.md` — the current session's work, with ordered steps and completion criteria.
- `later.md` — everything deferred on purpose, with the reasoning and what would justify
  picking it up. Read it before proposing a feature; it is probably already in there with an
  explanation.
- `findings.md` — what the raw-stream spike discovered about whether the join holds, and what
  re-measuring it from the captured corpus confirmed and corrected.
- `corpus/README.md` — the captured signals the engine is tested against: what is in a run
  directory, and which of its numbers are evidence rather than benchmarks.

Root `package.json` is the source of truth for commands.

## Invariants

These are load-bearing. Changing one is a design decision, not an implementation choice.

- **The numbers must be honest.** Everything below follows from this, and it is the project's
  only real claim.
- **The UI lives in a separate tab, never inside the measured app.** A panel rendered into the
  host app contaminates the frames it reports on, and a React panel pollutes the very commit
  stream used for attribution — loudest during slow frames, when it updates most.
- **Confidence lives in the data model.** The shape is `frame → ranked candidate causes with
weights`. A single obvious cause is the degenerate case where one candidate holds all the
  weight. Modelling it as `frame → one culprit` turns every ambiguous frame into a bug report.
- **Degrade in tiers, and name the tier.** Profiler header absent → infer from overlap at lower
  confidence. React hook absent → source-level attribution. Source map absent → minified name
  with a warning. Always produce something; always state what it was working from.
- **Show every millisecond figure with the build mode and CPU throttle that produced it.** Lab
  numbers quoted bare are indefensible.
- **Group and rank frames by cause, not by interaction.** All long frames are ingested, not just
  interaction-driven ones — scroll and animation jank have no Core Web Vital and no tooling, and
  they arrive on the same observer for free.
- **`core` stays pure.** The engine takes signal records and returns attributions. No DOM, no
  browser globals, no I/O — it is the part with real unit tests.
- **Verify browser API shapes against their current specs.** The LoAF and Profiler field names
  in these documents were written from memory.

## Quality bar

Functional correctness and readability are both requirements. This code will be read by
strangers judging whether the author is any good, and by future agents with no memory of the
conversation that produced it.

### ESLint and Prettier

- ESLint with a flat config (`eslint.config.js`) and `typescript-eslint`'s type-checked strict
  and stylistic configs. Fix what it reports; when a disable is genuinely right, the
  `eslint-disable` line carries a comment saying why.
- Prettier owns formatting. `eslint-config-prettier` goes last in the config array so the two
  never contest the same concern, and Prettier stays out of ESLint's rule set — they run as
  separate commands.
- Code is formatted and lint-clean before a piece of work counts as done.

### TypeScript

Strict mode with `noUncheckedIndexedAccess`. Model the domain in types: a frame's candidate
causes, the attribution tiers, and the confidence weighting each deserve a named type whose
shape makes an invalid state hard to express. Where a cast or non-null assertion is
unavoidable, a comment above it states what guarantees it.

### Comments

The browser APIs here are obscure, the correlation logic is subtle, and the reasoning behind
both is invisible to the next reader.

- Open each module with a block comment stating its role in the pipeline and what it
  deliberately does not do.
- Give every exported function a block comment covering what it returns, the units and clock of
  any timing value, and what it assumes about its inputs.
- Explain the correlation logic in prose, in multi-line comments, beside the code. That
  reasoning is the intellectual content of this repo and is worth far more written down than
  inferred. Say why a heuristic is shaped the way it is and which case motivated it.
- Where a browser API behaves unexpectedly, record the behaviour and link the spec or the bug.
- Comments explain *why*; the code carries the *what*.
