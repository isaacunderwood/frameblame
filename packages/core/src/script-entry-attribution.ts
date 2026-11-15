/**
 * LoAF's script entries against the profiler: for each registration site LoAF
 * named, which functions the profiler saw running inside its slices, and
 * whether they ran in the script LoAF named.
 *
 * A script slice is the population for "whose code was this LoAF entry",
 * which is the question LoAF answers wrongly for third parties. LoAF reports
 * where a listener was *registered*, so a vendor library called from a
 * first-party listener is charged to the first-party file. The profiler
 * reports the script each sample was running in, and this module puts the two
 * answers side by side rather than replacing one with the other: LoAF's site
 * is the `loaf-script-registration` tier's claim, and the profiler's ranking
 * is `line-attribution.ts`'s, over the slices that site produced.
 *
 * ## Slices are half-open
 *
 * Adjacent script slices in one frame share their boundary instant exactly,
 * so each slice is half-open at its end and a sample on a boundary is counted
 * once. That end is a tie-break, not evidence about which script the sample
 * belongs to; `scriptSlicePopulation` records the one corpus case and which
 * way it really pointed.
 *
 * ## What the comparison cannot see
 *
 * It compares served scripts. Inside one bundle the profiler and LoAF name
 * the same file whatever ran, so a vendor bundled into the app is never
 * flagged; across a dev server's separately served modules, ordinary
 * first-party work under React's dispatcher is. `ScriptDisagreement` says
 * which.
 *
 * ## What this module does not do
 *
 * It does not resolve a map or charge a sample to a function: that is
 * `source-map.ts` and `line-attribution.ts`, which this module calls and
 * which never call back. It does not decide which script is a third party,
 * which nothing in the trace states. It reads only the records it is handed.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import { describeTier, type ScriptEntrySite } from './attribution.ts';
import { decomposeFrame, type FrameSlice } from './frame-decomposition.ts';
import {
  attributeSampledFunctions,
  chargedSamples,
  describeSourceLocation,
  type FunctionAttribution,
  type SamplePopulation,
} from './line-attribution.ts';
import { type CaptureProvenance, formatMilliseconds } from './provenance.ts';
import type { CapturedSignals } from './signals.ts';
import type { ResolvedProfile } from './source-map.ts';

/** A frame's script slice, as `decomposeFrame` cuts it. */
export type ScriptSlice = Extract<FrameSlice, { kind: 'script' }>;

/**
 * Every sample inside any of these script slices, each half-open at its end.
 *
 * The slice's own extent rather than the script entry's, because the slice is
 * what the partition charges to the script; the two are identical on all 77
 * script entries in the corpus.
 *
 * The half-open end is a tie-break, not a reading of the evidence. Adjacent
 * script slices share their boundary instant exactly, so a sample on it has
 * to go to one of them, and "counted once" relies on that exactness:
 * `a.startMs + a.durationMs === b.startMs` held on all 24 adjacent pairs in
 * the corpus (all eight captures, 4x). The one boundary sample in the corpus
 * points the other way. `vendor-listener`'s sample at 3757.2ms (development,
 * 4x) has `vendorTrack` at its leaf, so it belongs to the earlier slice, the
 * vendor's, and the half-open end counts it in the later, forced-layout one.
 * Kept anyway, because any tie-break is arbitrary and this one is at least
 * consistent.
 */
export function scriptSlicePopulation(slices: readonly ScriptSlice[]): SamplePopulation {
  return {
    window: 'script-slice',
    ranges: slices.map((slice) => ({
      kind: 'interval',
      fromMs: slice.startMs,
      toMs: slice.startMs + slice.durationMs,
      end: 'exclusive',
    })),
  };
}

/**
 * The profiler and LoAF disagreeing about whose script a LoAF entry's time was.
 *
 * LoAF names the script that *registered* the entry point, so wherever
 * first-party code calls into a vendor library it names the first-party file.
 * The profiler names the script each sample was running in.
 *
 * Script-level only, which makes it blind in one direction and noisy in the
 * other. Within one bundle it stays `null`: a vendor bundled into the app runs
 * in the same served script LoAF named, so it is never flagged. On a dev
 * server that serves each module separately, every first-party callback React
 * invokes is flagged, because LoAF names react-dom's dispatcher and the
 * profiler names the component's own module; `derive-in-render` development
 * is that case.
 */
export interface ScriptDisagreement {
  /** The script LoAF named. */
  readonly loafScriptUrl: string | null;
  /** The script the profiler's top-ranked candidate ran in. */
  readonly profilerScriptUrl: string;
  /**
   * Stacked samples charged to a function in any script other than the one
   * LoAF named, of the attribution's `stackedSamples`.
   */
  readonly samplesElsewhere: number;
}

/**
 * Every script slice in a capture that LoAF attributed to one registration
 * site, with what the profiler says ran in them.
 *
 * Grouped across frames because one entry's share is a handful of samples:
 * `vendor-listener`'s vendor slices last 12.0-12.4ms against a median cadence
 * of 14.2-14.7ms per capture in the v0.3 re-capture, and 12.2ms in the one
 * before, so each holds about one sample per frame (4x, both build modes),
 * and the profiler's answer for it is only stable over every frame that entry
 * appeared in.
 *
 * Nor are a group's samples evenly spread. Of `vendor-listener`'s vendor
 * slice samples, 9 of 13 in development fall in a 1.1ms burst on the first
 * click (165.8-166.9ms), and 9 of 14 in production in 181.0-182.5ms (4x).
 * After the first click the evidence is 4 of 4 in development and 5 of 5 in
 * production, all `vendorTrack`; the sixth development click's slice holds
 * none, its one sample sitting on the boundary that `scriptSlicePopulation`
 * gives to the next slice. Samples in a burst are not independent evidence,
 * so `profiler`'s weights are shares of independent samples, bursts collapsed:
 * 5 of 5 in development and 5.9 of 6 in production, which is what each
 * candidate's confidence is derived from. The raw counts stay on the evidence.
 */
export interface ScriptEntryAttribution {
  /** Carried so that `durationMs` can be quoted with its build mode and throttle. */
  readonly provenance: CaptureProvenance;
  /** What LoAF said. The `loaf-script-registration` tier's claim. */
  readonly site: ScriptEntrySite;
  readonly slices: readonly ScriptSlice[];
  /** Summed slice durations, in milliseconds. */
  readonly durationMs: number;
  /** `null` when the capture has no profile. */
  readonly profiler: FunctionAttribution | null;
  /**
   * Set when the profiler's top-ranked candidate ran in a different script
   * than LoAF named; `null` when they agree or there is no profile.
   */
  readonly disagreement: ScriptDisagreement | null;
}

/** What LoAF named for the script entry a slice was cut from. */
export function scriptEntrySiteOf(slice: ScriptSlice): ScriptEntrySite {
  const { script } = slice;
  return {
    sourceUrl: script.sourceUrl,
    sourceFunctionName: script.sourceFunctionName,
    sourceCharPosition: script.sourceCharPosition,
    invoker: script.invoker,
    invokerType: script.invokerType,
  };
}

/**
 * A stable key for a site: everything LoAF reports about it. Two entries with
 * the same key are the same registration site, as far as LoAF can tell.
 */
export function scriptEntrySiteKey(site: ScriptEntrySite): string {
  return JSON.stringify([
    site.sourceUrl,
    site.sourceFunctionName,
    site.sourceCharPosition,
    site.invoker,
    site.invokerType,
  ]);
}

function disagreementOf(
  site: ScriptEntrySite,
  attribution: FunctionAttribution,
): ScriptDisagreement | null {
  const [top] = attribution.causes.causes;
  if (top?.subject.kind !== 'source-location') return null;
  if (top.subject.scriptUrl === site.sourceUrl) return null;

  const samplesElsewhere = attribution.causes.causes.reduce(
    (sum, cause) =>
      cause.subject.kind === 'source-location' &&
      cause.subject.scriptUrl !== site.sourceUrl
        ? sum + chargedSamples(cause)
        : sum,
    0,
  );
  return {
    loafScriptUrl: site.sourceUrl,
    profilerScriptUrl: top.subject.scriptUrl,
    samplesElsewhere,
  };
}

/**
 * Attributes every LoAF script entry in the capture to the functions the
 * profiler saw running inside it, grouped by the registration site LoAF named.
 *
 * Returns one entry per distinct site, in the order each was first seen, each
 * with its slices as `decomposeFrame` cuts them, its summed duration in
 * milliseconds, the profiler's ranked functions over those slices, and the
 * disagreement when the profiler's top function ran in a different script
 * than LoAF named. Pass `resolveProfile(signals.profile)`, or `null` when the
 * capture has no profile, in which case LoAF's site is all there is.
 *
 * Assumes a site is identified by everything LoAF reports about it: URL,
 * function name, character offset, invoker and invoker type. Two listeners
 * registered on the same line by different code would share a site.
 */
export function attributeScriptEntries(
  signals: CapturedSignals,
  resolved: ResolvedProfile | null,
): readonly ScriptEntryAttribution[] {
  const groups = new Map<string, { site: ScriptEntrySite; slices: ScriptSlice[] }>();
  for (const frame of signals.frames) {
    for (const slice of decomposeFrame(frame).slices) {
      if (slice.kind !== 'script') continue;
      const site = scriptEntrySiteOf(slice);
      const key = scriptEntrySiteKey(site);
      const group = groups.get(key) ?? { site, slices: [] };
      group.slices.push(slice);
      groups.set(key, group);
    }
  }

  return [...groups.values()].map(({ site, slices }) => {
    const profiler =
      resolved === null
        ? null
        : attributeSampledFunctions(
            resolved,
            signals.provenance,
            scriptSlicePopulation(slices),
          );
    return {
      provenance: signals.provenance,
      site,
      slices,
      durationMs: slices.reduce((sum, slice) => sum + slice.durationMs, 0),
      profiler,
      disagreement: profiler === null ? null : disagreementOf(site, profiler),
    };
  });
}

/**
 * One line of prose for a script entry: what LoAF named, with the milliseconds
 * qualified by the capture's provenance, and where the profiler disagreed.
 */
export function describeScriptEntry(entry: ScriptEntryAttribution): string {
  const { site, profiler } = entry;
  const offset =
    site.sourceCharPosition === null
      ? ''
      : ` at offset ${String(site.sourceCharPosition)}`;
  const count = entry.slices.length;
  const loafSaid =
    `LoAF named ${site.sourceUrl ?? 'no script'}${offset} for ` +
    `${formatMilliseconds(entry.durationMs, entry.provenance)} over ` +
    `${String(count)} ${count === 1 ? 'entry' : 'entries'} ` +
    `(${describeTier('loaf-script-registration')})`;
  if (profiler === null)
    return `${loafSaid}; no profile was captured to check it against`;

  const [top] = profiler.causes.causes;
  if (top?.subject.kind !== 'source-location') {
    return `${loafSaid}; the profiler found no stacked sample in it to charge`;
  }
  const share = `${String(chargedSamples(top))} of ${String(profiler.stackedSamples)} stacked samples`;
  const profilerSaid = `the profiler put ${share} in ${describeSourceLocation(top.subject)}`;
  return entry.disagreement === null
    ? `${loafSaid}; ${profilerSaid}, in the same script`
    : `${loafSaid}; ${profilerSaid}, which is a different script`;
}
