/**
 * `@frameblame/react` — the React adapter.
 *
 * Attribution works without it: a frame can be blamed on a file and a line from
 * the two platform signals alone. What this package adds is the name of the
 * component that owned that line, which is the difference between "something in
 * `OrderTable.tsx:112`" and "`OrderTable` spent 240ms sorting". It is a
 * separate package because the core is framework-agnostic and the adapter seam
 * has to exist anyway for the degradation tiers.
 *
 * In development both come from the DevTools hook and fiber `actualDuration`.
 * React also publishes named render spans as `performance.measure` entries,
 * which are cheaper to read but are emitted only for components whose props
 * changed by identity — so they miss the `setState` owner, context consumers
 * and first mount, and serve here as corroboration rather than as the signal.
 * Their names carry a leading zero-width space (U+200B), they must be observed
 * rather than polled for because React clears them immediately, and only
 * `name`, `startTime` and `duration` can be trusted: the `detail` object is a
 * mutated singleton describing whichever measure was emitted last.
 *
 * In production neither exists, and component identity comes from the
 * profiler's stack resolved through the shipped source map instead. See
 * `findings.md`.
 */

export { hasReactDevToolsHook, REACT_DEVTOOLS_GLOBAL_HOOK_KEY } from './devtools-hook.ts';
export type { ReactDevToolsHook } from './devtools-hook.ts';
