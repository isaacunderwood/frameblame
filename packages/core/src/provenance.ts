/**
 * What produced a set of signal records, and how to quote a figure from them.
 *
 * This module exists to make one invariant mechanical rather than aspirational:
 * every millisecond figure is shown with the build mode and CPU throttle rate
 * that produced it. A 64ms frame measured under 4x throttling is roughly a 16ms
 * frame unthrottled on the same machine, and neither is what a user on a
 * mid-range Android sees — so a bare "64ms" is not a weaker claim than a
 * qualified one, it is an indefensible one.
 *
 * It holds the provenance record and the two formatters. It deliberately does
 * not know where provenance comes from: the corpus reads it out of a dump's
 * envelope, and a live collector would build it from the page it is attached
 * to.
 */

/**
 * Which build of the measured app the records came from.
 *
 * Both are first-class. `findings.md` reversed an early assumption that
 * production was the weaker case: production resolves *better* than
 * development, because the profiler plus a shipped source map recovers the
 * component name from the map's `names` array with no React hook and no
 * development build. What production loses is the React tier, not accuracy.
 */
export type BuildMode = 'development' | 'production';

/**
 * The circumstances one capture was collected under.
 *
 * Every field is here because quoting a figure without it has already produced
 * a wrong conclusion somewhere in this project's history, or would.
 */
export interface CaptureProvenance {
  /** Identifies the capture. A corpus run id, or whatever a collector names a session. */
  readonly runId: string;
  /** What was measured: a fixture id in the corpus, a page URL in the field. */
  readonly subject: string;
  readonly buildMode: BuildMode;
  /**
   * How the build was produced, in the words of whoever produced it — e.g.
   * "production (vite build, sourcemap: true, served by vite preview)".
   *
   * Carried alongside `buildMode` rather than derived from it because
   * "production" covers builds that differ in the ways that matter here:
   * whether source maps shipped, whether the bundle was minified, and which
   * server set the profiling header.
   */
  readonly buildModeDescription: string;
  /**
   * CPU throttling factor applied while measuring. 1 means unthrottled.
   *
   * Note that it does not scale every app equally, so it cannot be divided out:
   * real computation scales with the rate, while code that busy-waits on
   * `performance.now()` burns the same wall-clock time at any rate. The corpus
   * contains one fixture of each kind, which is why this travels with the
   * figures instead of being normalised away.
   */
  readonly cpuThrottleRate: number;
  /** The browser and version, e.g. `chromium 159.0.8154.6`. */
  readonly browser: string;
  /** ISO-8601, wall clock. Not on the page's timeline; see `signals.ts`. */
  readonly collectedAt: string;
}

/**
 * The qualifier that must accompany any figure from this capture, e.g.
 * `development, 4x CPU throttle, chromium 159.0.8154.6`.
 *
 * Returns the throttle rate verbatim rather than describing it as "unthrottled"
 * at 1, because a reader who sees `1x CPU throttle` knows the question was
 * asked and answered, where silence could mean either.
 */
export function describeProvenance(provenance: CaptureProvenance): string {
  const rate = `${String(provenance.cpuThrottleRate)}x CPU throttle`;
  return `${provenance.buildMode}, ${rate}, ${provenance.browser}`;
}

/**
 * Formats a duration in milliseconds with its provenance attached, e.g.
 * `64.6ms (development, 4x CPU throttle, chromium 159.0.8154.6)`.
 *
 * `ms` is a duration, not a timestamp, and is rounded to one decimal place —
 * which is the resolution the signals actually carry. Every LoAF field is
 * coarsened onto a randomised 100us grid, so a second decimal place would be
 * reporting noise as precision. See `COARSENED_TIMING_TOLERANCE_MS` in
 * `loaf.ts`.
 */
export function formatMilliseconds(ms: number, provenance: CaptureProvenance): string {
  return `${ms.toFixed(1)}ms (${describeProvenance(provenance)})`;
}
