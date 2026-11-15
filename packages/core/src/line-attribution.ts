/**
 * The profiler tier for lines: which functions a population of samples spent
 * its time in, each located by where it is defined, ranked by sample share.
 *
 * This is the production story and the only source of third-party
 * attribution. It needs no React hook, no development build and no build-time
 * plugin: sampled stacks, resolved through whatever source maps the scripts
 * shipped (`source-map.ts`), and counted.
 *
 * ## What a candidate claims
 *
 * A candidate is a *function*, located by its definition site, with a line
 * attached. It is never a statement. The JS Self-Profiling API reports the
 * line a function was defined on, so `OrderTable.tsx:36, in the callback
 * passed to .sort` is the strongest claim the data supports, and "line 36 is
 * slow" is not one it supports at all. The subject's `granularity` carries
 * that into the data, and `describeSourceLocation` words it that way.
 *
 * ## Which frame a sample is charged to
 *
 * Each sample with a stack is charged to one frame, found by walking from the
 * leaf outwards to the first frame that is not library code. "Library code"
 * means exactly one thing here: the frame resolved through a source map into a
 * source the map's own `ignoreList` names. That is the bundler's statement,
 * not a guess from a path, and Vite makes it for every `node_modules` source in
 * all four React captures and for none of the fixtures' files.
 *
 * The leaf alone would be the purer answer, and it is the wrong one for a
 * React developer. In `derive-in-render`'s development replay 16 of the 96
 * stacked samples have React's JSX runtime at the leaf, 14 of them called
 * from the row-rendering `.map` callback at `OrderTable.tsx:49` and 2 from the
 * component body (4x). Charged to the leaf, that work is reported as
 * `react-jsx-dev-runtime.development.js:327`, which nobody can act on. Folded
 * into the innermost function the developer wrote, it is line 49's cost,
 * which is what it is. The fold is never silent: each candidate's
 * `ignore-listed-callees` evidence counts the samples it absorbed.
 *
 * Where no frame on the stack qualifies, the sample is charged to the leaf, so
 * React's own scheduling work is still a candidate under its own name rather
 * than dropped from the denominator.
 *
 * A frame that did not resolve through a map is never skipped as library code,
 * because nothing says it is library code. That is what keeps the vendor
 * finding intact: `vendor-listener`'s `vendor.js` ships no map, so its
 * function is the leaf and is charged as itself.
 *
 * What that rule cannot see: a third-party SDK bundled from `node_modules` into
 * the app's own bundle is ignore-listed, so its samples fold into the
 * first-party function that called it, and the third-party share of such a
 * frame is reported as first-party, with the absorbed count beside it. No
 * capture in the corpus has that shape. Splitting it out needs the
 * ignore-listed source carried on the evidence, which is a confidence-model
 * question rather than a resolution one.
 *
 * ## The populations
 *
 * A share is only as stable as the population it is taken over, and the
 * population is named on every answer. Over the replay's interaction windows
 * the `derive-in-render` histogram does not depend on how many presses cleared
 * LoAF's 50ms threshold, which is the long-frame count no suite may assert on.
 * Inside long frames is the population that answers "what was this frame
 * doing", and the one whose empty-stack share means anything. A script slice
 * is the population for "whose code was this LoAF entry", which is the
 * question LoAF answers wrongly for third parties.
 *
 * ## What this module does not do
 *
 * It does not weigh a candidate against the frame's duration, merge it with
 * the React tier's answer, or decide a confidence beyond the sample share.
 * That is the confidence model's job. It reads only the records it is handed.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import {
  type AttributionTier,
  type CandidateCause,
  type CauseEvidence,
  type CauseSubject,
  confidenceWeight,
  describeTier,
  type FunctionName,
  type RankedCauses,
  rankCauses,
  type SampleWindowKind,
  type UnmappedReason,
} from './attribution.ts';
import { decomposeFrame, type FrameSlice } from './frame-decomposition.ts';
import { isWithinFrame, type LongAnimationFrame } from './loaf.ts';
import { type CaptureProvenance, formatMilliseconds } from './provenance.ts';
import type { CapturedSignals } from './signals.ts';
import {
  definitionSite,
  type FrameResolution,
  resolvedStack,
  type ResolvedProfile,
} from './source-map.ts';

/** A source-location subject, which is what every candidate here points at. */
export type FunctionSubject = Extract<CauseSubject, { kind: 'source-location' }>;

/**
 * One stretch of page clock a sample may fall in.
 *
 * `frame` defers to `isWithinFrame`, with its two-step tolerance, so that
 * "in-frame" means the same thing here as everywhere else in the engine.
 * `interval` states its own end: inclusive for an interaction window, as
 * `signals.ts` defines one, and exclusive for a script slice, so that a
 * sample on the boundary between two adjacent scripts is counted once.
 */
export type SampleRange =
  | { readonly kind: 'frame'; readonly frame: LongAnimationFrame }
  | {
      readonly kind: 'interval';
      readonly fromMs: number;
      readonly toMs: number;
      readonly end: 'inclusive' | 'exclusive';
    };

/**
 * The samples a share is taken over: every sample inside any of `ranges`,
 * counted once however many ranges contain it, named by `window`.
 */
export interface SamplePopulation {
  readonly window: SampleWindowKind;
  readonly ranges: readonly SampleRange[];
}

function inRange(range: SampleRange, atMs: number): boolean {
  if (range.kind === 'frame') return isWithinFrame(range.frame, atMs);
  if (atMs < range.fromMs) return false;
  return range.end === 'inclusive' ? atMs <= range.toMs : atMs < range.toMs;
}

/**
 * Every sample inside any interaction window: the replay population.
 *
 * Samples outside every window are left out. In the corpus that is at most
 * two per capture, none of them with a stack (all eight captures, 4x): the
 * profiler starts 1.4-3.1ms before the first window opens, except in `spans`,
 * whose first window opens at 0 and so contains the init-script start and the
 * first mount's samples before any input arrives. A consumer that took the
 * first *action* as the start of the samples would mis-bin that mount. The
 * windows are inclusive at both ends, as `signals.ts` defines them.
 */
export function interactionPopulation(signals: CapturedSignals): SamplePopulation {
  return {
    window: 'interaction',
    ranges: signals.interactions.map((interaction) => ({
      kind: 'interval',
      fromMs: interaction.fromMs,
      toMs: interaction.toMs,
      end: 'inclusive',
    })),
  };
}

/** Every sample inside any long animation frame, by `isWithinFrame`. */
export function longFramePopulation(signals: CapturedSignals): SamplePopulation {
  return {
    window: 'frame',
    ranges: signals.frames.map((frame) => ({ kind: 'frame', frame })),
  };
}

/** A frame's script slice, as `decomposeFrame` cuts it. */
export type ScriptSlice = Extract<FrameSlice, { kind: 'script' }>;

/**
 * Every sample inside any of these script slices, each half-open at its end.
 *
 * The slice's own extent rather than the script entry's, because the slice is
 * what the partition charges to the script; the two are identical on all 77
 * script entries in the corpus.
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

/** The functions a population of samples was spent in. */
export interface FunctionAttribution {
  /** Carried so that any figure quoted from this answer can be qualified. */
  readonly provenance: CaptureProvenance;
  readonly population: SamplePopulation;
  /** Every sample in the population, with a stack or without. */
  readonly samples: number;
  /**
   * Samples in the population with no JavaScript on the stack.
   *
   * Meaningful inside long frames, where it is the unattributed tier's second
   * signal. Over an interaction window it is mostly the idle time between
   * presses, so it says nothing about what the presses cost.
   */
  readonly samplesWithoutStack: number;
  /** The denominator every weight is a share of. */
  readonly stackedSamples: number;
  /**
   * Stacked samples with no frame that has a position, charged to nobody, so
   * the ranked weights fall short of 1 by their share. 0 in every capture.
   */
  readonly unlocatedSamples: number;
  readonly causes: RankedCauses;
}

/** A located resolution, which every charged frame is. */
type Located = Exclude<FrameResolution, { kind: 'unlocated' }>;

/** Whether a resolution is library code by its own map's account. */
function isIgnoreListed(resolution: Located): boolean {
  return resolution.kind === 'mapped' && resolution.inIgnoredSource;
}

/**
 * The frame a sample is charged to, and whether that skipped ignore-listed
 * frames to get there. See "Which frame a sample is charged to" above.
 * `null` when no frame on the stack has a position.
 */
function chargedFrame(
  stack: readonly FrameResolution[],
): { readonly frame: Located; readonly foldedCallees: boolean } | null {
  const located = stack.filter(
    (resolution): resolution is Located => resolution.kind !== 'unlocated',
  );
  const [leaf] = located;
  if (leaf === undefined) return null;

  const index = located.findIndex((resolution) => !isIgnoreListed(resolution));
  const frame = located[index];
  return frame === undefined
    ? { frame: leaf, foldedCallees: false }
    : { frame, foldedCallees: index > 0 };
}

/**
 * A stable key for the function a resolution points at: its served script and
 * its definition site there. Two frames with the same generated position are
 * the same function; keying on the original position as well would split
 * nothing, since the map is a function of the generated one.
 */
function functionKey(resolution: Located): string {
  const generated =
    resolution.kind === 'mapped' ? resolution.generated : resolution.generated.position;
  return `${resolution.scriptUrl}:${String(generated.line)}:${String(generated.column)}`;
}

function functionNameOf(resolution: Located): FunctionName | null {
  if (resolution.kind === 'mapped' && resolution.originalName !== null) {
    return { text: resolution.originalName, from: 'source-map' };
  }
  const served = resolution.frame.name;
  return served === null ? null : { text: served, from: 'served-script' };
}

/** The candidate subject for a charged frame. */
function functionSubject(resolution: Located): FunctionSubject {
  const location = definitionSite(resolution);
  // Unreachable: `definitionSite` returns `null` only for an unlocated frame,
  // which `Located` excludes.
  if (location === null) throw new Error('a located frame has no definition site');
  return {
    kind: 'source-location',
    location,
    granularity: 'function-definition',
    scriptUrl: resolution.scriptUrl,
    functionName: functionNameOf(resolution),
    enclosingCallToken:
      resolution.kind === 'mapped' ? resolution.enclosingCallToken : null,
  };
}

/** The tier a charged frame's candidate stands on. */
function tierOf(resolution: Located): AttributionTier {
  return resolution.kind === 'mapped' ? 'profiler-mapped' : 'profiler-unmapped';
}

interface FunctionTally {
  readonly resolution: Located;
  samples: number;
  foldedCallees: number;
}

/**
 * Charges every stacked sample in the population to a function and ranks the
 * functions by their share of the stacked samples.
 *
 * Returns one candidate per function, at `profiler-mapped` where its
 * definition site resolved through a source map and `profiler-unmapped` where
 * it did not, with the reason on its location. Weights are shares of
 * `stackedSamples`, with basis `sample-share`; ties keep the order the
 * functions were first sampled in. Assumes `resolved` is the capture's own
 * profile and `population`'s ranges are page-clock milliseconds on the same
 * clock, which every capture's are.
 *
 * Per-candidate shares are coarse at small sample counts: plus or minus 20
 * points at five samples, which is why the replay population exists.
 */
export function attributeSampledFunctions(
  resolved: ResolvedProfile,
  provenance: CaptureProvenance,
  population: SamplePopulation,
): FunctionAttribution {
  const tallies = new Map<string, FunctionTally>();
  let samples = 0;
  let samplesWithoutStack = 0;
  let unlocatedSamples = 0;

  for (const sample of resolved.trace.samples) {
    if (!population.ranges.some((range) => inRange(range, sample.atMs))) continue;
    samples += 1;
    if (sample.stackId === null) {
      samplesWithoutStack += 1;
      continue;
    }

    const charged = chargedFrame(resolvedStack(resolved, sample.stackId));
    if (charged === null) {
      unlocatedSamples += 1;
      continue;
    }

    const key = functionKey(charged.frame);
    const tally = tallies.get(key) ?? {
      resolution: charged.frame,
      samples: 0,
      foldedCallees: 0,
    };
    tally.samples += 1;
    if (charged.foldedCallees) tally.foldedCallees += 1;
    tallies.set(key, tally);
  }

  const stackedSamples = samples - samplesWithoutStack;
  const causes = rankCauses(
    [...tallies.values()].map((tally): CandidateCause => {
      const evidence: [CauseEvidence, ...CauseEvidence[]] = [
        {
          kind: 'profiler-samples',
          samples: tally.samples,
          ofSamplesInWindow: stackedSamples,
          window: population.window,
        },
      ];
      if (tally.foldedCallees > 0) {
        evidence.push({ kind: 'ignore-listed-callees', samples: tally.foldedCallees });
      }
      return {
        subject: functionSubject(tally.resolution),
        // `stackedSamples` is at least `tally.samples`, which is at least 1.
        weight: confidenceWeight(tally.samples / stackedSamples, 'sample-share'),
        tier: tierOf(tally.resolution),
        evidence,
      };
    }),
  );

  return {
    provenance,
    population,
    samples,
    samplesWithoutStack,
    stackedSamples,
    unlocatedSamples,
    causes,
  };
}

/**
 * The samples a candidate was charged, read off its `profiler-samples`
 * evidence. 0 for a candidate from any other tier.
 */
export function chargedSamples(cause: CandidateCause): number {
  return cause.evidence.reduce(
    (sum, evidence) =>
      evidence.kind === 'profiler-samples' ? sum + evidence.samples : sum,
    0,
  );
}

/** One line of prose for why a position is not in an original file. */
export function describeUnmappedReason(reason: UnmappedReason): string {
  switch (reason) {
    case 'no-source-map':
      return 'the script shipped no source map';
    case 'source-map-unavailable':
      return "the script's source map could not be fetched";
    case 'source-map-unreadable':
      return "the script's source map could not be read";
    case 'no-mapping-at-position':
      return "the script's source map does not cover this position";
  }
}

/**
 * A function candidate as the claim it supports, e.g.
 * `OrderTable.tsx:36, in the callback passed to .sort`.
 *
 * Function-level, and worded so: the line is where the function is defined,
 * and the phrase names the function rather than calling the line slow. A
 * position not resolved through a map carries the warning that the name and
 * line are as the script was served, which in a production bundle means
 * minified.
 */
export function describeSourceLocation(subject: FunctionSubject): string {
  const { location, functionName, enclosingCallToken } = subject;
  const where = `${location.file}:${String(location.position.line)}`;
  const what =
    functionName !== null
      ? `in ${functionName.text}`
      : enclosingCallToken !== null
        ? `in the callback passed to ${enclosingCallToken}`
        : 'in an anonymous function';
  const claim = `${where}, ${what}`;
  if (location.throughSourceMap) return claim;
  return (
    `${claim} (not through a source map: ${describeUnmappedReason(location.whyNot)}, ` +
    'so the name and line are as the script was served, and may be minified)'
  );
}

/** The one sentence that must accompany a ranked list of function candidates. */
export const FUNCTION_LEVEL_CAVEAT =
  'Each line is where the sampled function is defined, not the statement that was running: ' +
  'the in-page profiler reports definition sites only, so this is function-level attribution';

/** One line of prose naming what a function attribution was working from. */
export function describeFunctionAttribution(attribution: FunctionAttribution): string {
  const window: Record<SampleWindowKind, string> = {
    frame: 'inside long animation frames',
    'since-previous-commit': "inside React commits' windows",
    interaction: 'inside the interaction windows',
    'script-slice': "inside the LoAF entry's script slices",
  };
  return (
    `${String(attribution.stackedSamples)} stacked samples ` +
    `${window[attribution.population.window]}, ` +
    `${String(attribution.samplesWithoutStack)} more with no JavaScript on the stack; ` +
    `${describeTier('profiler-mapped')} where a map applied, otherwise ` +
    `${describeTier('profiler-unmapped')}. ${FUNCTION_LEVEL_CAVEAT}`
  );
}

/**
 * What LoAF named for a script entry: the registration site of the entry
 * point, which is where a listener was added rather than whose code it ran.
 */
export interface ScriptEntrySite {
  /** `null` when Chrome reported no URL. */
  readonly sourceUrl: string | null;
  readonly sourceFunctionName: string | null;
  readonly sourceCharPosition: number | null;
  readonly invoker: string;
  readonly invokerType: string;
}

/**
 * The profiler and LoAF disagreeing about whose script a LoAF entry's time was.
 *
 * LoAF names the script that *registered* the entry point, so wherever
 * first-party code calls into a vendor library it names the first-party file.
 * The profiler names the script each sample was running in.
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
 * Grouped across frames because one entry's share is a handful of samples: a
 * 12ms slice at a 12-15ms cadence is about one sample per frame (4x), so the
 * profiler's answer for it is only stable over every frame that entry
 * appeared in.
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

function siteOf(slice: ScriptSlice): ScriptEntrySite {
  const { script } = slice;
  return {
    sourceUrl: script.sourceUrl,
    sourceFunctionName: script.sourceFunctionName,
    sourceCharPosition: script.sourceCharPosition,
    invoker: script.invoker,
    invokerType: script.invokerType,
  };
}

function siteKey(site: ScriptEntrySite): string {
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
      const site = siteOf(slice);
      const key = siteKey(site);
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
