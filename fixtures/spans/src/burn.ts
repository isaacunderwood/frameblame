/*
 * The fixture's unit of cost, kept in one place so that every component burns
 * exactly the same amount and the only thing that differs between them is *why*
 * they re-rendered. That is the whole experiment; a second difference would
 * give any disagreement between signals two possible explanations.
 *
 * What this module deliberately does not do:
 *
 * - It does not sleep, await, or schedule. A synthetic delay — `setTimeout`,
 *   an awaited promise, `Atomics.wait` — releases the main thread, so the
 *   browser finishes the animation frame and the long frame this fixture exists
 *   to produce never happens. Only a busy loop occupies the main thread the way
 *   a slow render body does, and occupying the main thread is the thing being
 *   measured.
 * - It does not touch the DOM, allocate, or read layout. Each component must
 *   have exactly one cost, attributable to its own render body, or a tool that
 *   got the attribution wrong could still look right.
 *
 * Throttle sensitivity, which matters when reading any number this fixture
 * produces: the loop's exit condition is a clock reading, not an amount of
 * work, so `burn(25)` returns after ~25ms of *wall-clock* time whether the CPU
 * is throttled or not — it simply completes less arithmetic at 4x. This fixture
 * is therefore throttle-insensitive, unlike `derive-in-render`, whose fixed
 * amount of work takes four times as long at 4x. Its millisecond figures are
 * the same at 1x and at 4x and must not be read as throttled measurements of a
 * real workload. `ground-truth.json` says so too, in `reproduction`.
 */

/**
 * Wall-clock milliseconds each component burns in its render body.
 *
 * 25ms is chosen so that five of them exceed one 50ms long-frame threshold
 * several times over, while a single one stays under it — a frame containing
 * one burn is deliberately near the trigger's blind spot documented in
 * `findings.md`.
 */
export const BURN_MS = 25;

/**
 * Occupies the main thread for approximately `ms` milliseconds of wall-clock
 * time, read from `performance.now()` — the same monotonic clock that LoAF
 * entries, JS Self-Profiling samples and React's render spans are all
 * timestamped on, so a burn can be lined up against all three with no
 * conversion. (`findings.md`, "The clock question: answered".)
 *
 * Returns the accumulated sum of square roots. The number is useless; it is
 * returned rather than dropped so that neither V8 nor a bundler can prove the
 * loop body dead and delete the cost this fixture is built out of.
 *
 * Assumes `ms` is a small positive number of milliseconds. It overshoots by up
 * to one batch of 500 iterations, because the clock is consulted only between
 * batches and `performance.now()` is itself coarsened onto a randomised 100µs
 * grid (5µs under cross-origin isolation). So ~25ms means ~25ms, never 25.
 */
export function burn(ms: number): number {
  const start = performance.now();
  let acc = 0;
  while (performance.now() - start < ms) {
    for (let i = 0; i < 500; i += 1) acc += Math.sqrt(i);
  }
  return acc;
}
