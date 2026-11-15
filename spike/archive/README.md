# Archive — preserved evidence, not maintained source

These are the throwaway scripts and raw dumps behind the claims in `findings.md`. They were
written during the v0.1 spike and its adversarial review round, run once, and kept only because
every conclusion they produced would otherwise be unreproducible.

They are **deliberately outside the lint, format and typecheck gate** (see the ignore entries in
`eslint.config.js`, `.prettierignore` and the root `tsconfig.json`). Holding one-off probes to
the repo's quality bar would mean rewriting them, and a rewritten probe is no longer evidence of
what was actually run. Read them as lab notes.

When a finding here earns a permanent place, the fixture graduates into `fixtures/` with a
`ground-truth.json` and the measurement graduates into `spike/dump-raw-streams.ts`. Then the
corresponding file here can go.

## What produced what

| File | Produced |
|---|---|
| `probe.ts`, `dev-replay.json`, `prod-replay.json` | The 24-press replay. Line-histogram aggregation, the production-build result, and the 50ms-threshold finding. |
| `spans/` + `dev-replay.json` | The React `performance.measure` props-identity gate — the four-case app whose mount produced five rendering components and zero spans. |
| `probe-vanilla.ts`, `vanilla/`, `vanilla*.json` | Frame decomposition where script does not dominate (93% residual), and the third-party registration-site finding from three sibling listeners. |
| `cdp-profile.ts`, `cdp-dev.json`, `cdp-prod.json` | CDP `positionTicks` at 100µs: true per-statement attribution, and its collapse in a minified bundle. |
| `dev-4profilers.json` | Four concurrent `Profiler` instances gaining nothing — 984 distinct timestamps against 982 for one. Kept so nobody retries it. |
| `analyse.*`, `stacks.ts`, `summarise.mjs`, `resolve.mjs` | The by-hand step-4 analysis: stack walking, source-map resolution, per-run summaries. |
| `browser_protocol.json` | The CDP protocol definition, fetched to check `Profiler` domain parameters against the real schema rather than from memory. |
| `v0.1-flat-capture/` | The last capture written by the flat `spike/out/` dump, before each run got its own timestamped directory: one keystroke on `derive-in-render`, development, 4x, 2026-11-14T23:05. Its clock note still asks whether the profiler shares the page's timeline, which is the question `findings.md` went on to answer. Moved here rather than deleted because it is the only copy and `spike/out/` is both gitignored and periodically cleared. |

## Caveat

The very first run of the v0.1 spike — the cold run quoted in `findings.md` for the 226ms frame
and its 14-of-21 empty stacks — is **not here**. It was overwritten before anything was copied
aside. That is the specific accident the next session's step 1 exists to prevent.
