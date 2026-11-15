/**
 * The profiler tier for lines: which functions a population of samples spent
 * its time in, each located by where it is defined, ranked by sample share.
 *
 * This is the production story, and the only signal that names the script a
 * slice's time was spent in, which third-party attribution would be built on.
 * It needs no React hook, no development build and no build-time plugin:
 * sampled stacks, resolved through whatever source maps the scripts shipped
 * (`source-map.ts`), and counted.
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
 * into the innermost function the developer wrote, it is the cost of the
 * `.map` callback defined on line 49, which is what it is. The fold is never
 * silent: each candidate's `ignore-listed-callees` evidence counts the samples
 * it absorbed.
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
 * question LoAF answers wrongly for third parties; it, and the comparison with
 * what LoAF named, are `script-entry-attribution.ts`.
 *
 * ## What this module does not do
 *
 * It does not weigh a candidate against the frame's duration, merge it with
 * the React tier's answer, or decide a confidence beyond the sample share.
 * That is the confidence model's job. It does not group LoAF's script entries
 * either; `script-entry-attribution.ts` builds on this module for that. It
 * reads only the records it is handed.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import {
  ATTRIBUTION_TIERS,
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
import { isWithinFrame, type LongAnimationFrame } from './loaf.ts';
import type { CaptureProvenance } from './provenance.ts';
import type { CapturedSignals } from './signals.ts';
import {
  type FrameResolution,
  generatedSiteKey,
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
 * sample on the boundary between two adjacent scripts is counted once (see
 * `scriptSlicePopulation` for why that end is a tie-break).
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
 * two per capture, none of them with a stack (all eight captures, 4x): 11 in
 * all, of which 6 precede the first window, 3 follow the last, and `spans`
 * production's 2 fall between two steps. The profiler starts 1.4-3.1ms
 * before the first window opens, except in `spans`, whose first window opens
 * at 0 and so contains the init-script start and the first mount's samples
 * before any input arrives. A consumer that took the first *action* as the
 * start of the samples would mis-bin that mount. The windows are inclusive at
 * both ends, as `signals.ts` defines them.
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
  for (const [index, frame] of located.entries()) {
    if (!isIgnoreListed(frame)) return { frame, foldedCallees: index > 0 };
  }
  const [leaf] = located;
  return leaf === undefined ? null : { frame: leaf, foldedCallees: false };
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
  return {
    kind: 'source-location',
    location: resolution.definedAt,
    granularity: 'function-definition',
    scriptUrl: resolution.scriptUrl,
    functionName: functionNameOf(resolution),
    enclosingCallToken:
      resolution.kind === 'mapped' ? resolution.enclosingCallToken : null,
  };
}

interface FunctionTally {
  readonly resolution: Located;
  samples: number;
  foldedCallees: number;
}

/**
 * One function's tally as a candidate: its share of `stackedSamples`, with the
 * samples it was charged and, where it absorbed any, the ignore-listed callees
 * it folded in. Assumes `stackedSamples` includes the tally's own samples.
 *
 * The tier is read off the subject's own location, so a candidate cannot claim
 * `profiler-mapped` for a position that did not come through a map.
 */
function functionCandidate(
  tally: FunctionTally,
  stackedSamples: number,
  window: SampleWindowKind,
): CandidateCause {
  const evidence: [CauseEvidence, ...CauseEvidence[]] = [
    {
      kind: 'profiler-samples',
      samples: tally.samples,
      ofSamplesInWindow: stackedSamples,
      window,
    },
  ];
  if (tally.foldedCallees > 0) {
    evidence.push({ kind: 'ignore-listed-callees', samples: tally.foldedCallees });
  }
  const subject = functionSubject(tally.resolution);
  return {
    subject,
    // `stackedSamples` is at least `tally.samples`, which is at least 1.
    weight: confidenceWeight(tally.samples / stackedSamples, 'sample-share'),
    tier: subject.location.throughSourceMap ? 'profiler-mapped' : 'profiler-unmapped',
    evidence,
  };
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

    // Keyed on the generated site: see `generatedSiteKey` for why that is the
    // function's identity whether or not a map applied.
    const key = generatedSiteKey(charged.frame.frame);
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
    [...tallies.values()].map((tally) =>
      functionCandidate(tally, stackedSamples, population.window),
    ),
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

/**
 * One line of prose naming what a function attribution was working from: the
 * population and its counts, and the tiers its candidates actually reached,
 * strongest first, so that an all-unmapped answer never mentions a map.
 */
export function describeFunctionAttribution(attribution: FunctionAttribution): string {
  const windowLabel: Record<SampleWindowKind, string> = {
    frame: 'inside long animation frames',
    'since-previous-commit': "inside React commits' windows",
    interaction: 'inside the interaction windows',
    'script-slice': "inside the LoAF entry's script slices",
  };
  const { causes } = attribution.causes;
  const reached = ATTRIBUTION_TIERS.filter((tier) =>
    causes.some((cause) => cause.tier === tier),
  );
  const workingFrom =
    reached.length === 0
      ? 'no sample was charged'
      : reached.map(describeTier).join(', and ');
  return (
    `${String(attribution.stackedSamples)} stacked samples ` +
    `${windowLabel[attribution.population.window]}, ` +
    `${String(attribution.samplesWithoutStack)} more with no JavaScript on the stack; ` +
    `${workingFrom}. ${FUNCTION_LEVEL_CAVEAT}`
  );
}
