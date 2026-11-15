/**
 * The shape of an answer: ranked candidate causes, each with a weight, a tier,
 * and the evidence it was derived from.
 *
 * The invariant this module exists to express is that **confidence lives in the
 * data model**. A frame does not have a culprit; it has candidates with
 * weights, and a single obvious cause is the degenerate case where one
 * candidate holds all the weight. Modelling it the other way turns every
 * ambiguous frame into a bug report — and the real data is ambiguous even on
 * the easiest possible fixture, where the honest answer was a component at high
 * confidence and a *distribution* over lines.
 *
 * What is here is the vocabulary and the two checked constructors. What is
 * deliberately not here is any heuristic: nothing in this module knows how to
 * read a fiber tree, count a sample, or decide which tier a frame qualifies
 * for. How far a weight can be trusted is `confidence.ts`, which this module
 * attaches to every weight: a fraction cannot be built here without the
 * support its confidence is derived from.
 */

import type { LineColumn } from './char-position.ts';
import {
  confidenceLevelOf,
  type WeightConfidence,
  type WeightSupport,
  weightRangeOf,
} from './confidence.ts';
import type { FrameSlice } from './frame-decomposition.ts';

/**
 * What a claim was derived from, strongest first.
 *
 * "Degrade in tiers, and name the tier" is an invariant: always produce
 * something, and always state what it was working from. Each of these is a real
 * state the corpus contains, not a hypothetical:
 *
 * - `react-fiber-timings` — the DevTools hook plus fiber `actualDuration`, in a
 *   development build. The primary component signal: it saw every component
 *   that rendered in every scenario tested, including the ones React declined
 *   to name and the one that produced no frame at all.
 * - `react-component-span` — React's own `performance.measure` spans.
 *   **Corroboration only.** The props-identity gate makes them blind to the
 *   `setState` owner, context consumers and every first mount, so a claim that
 *   rests on them alone is a claim about which components React happened to
 *   name.
 * - `profiler-mapped` — sampled stacks resolved through a shipped source map.
 *   The whole production story, and it resolves *better* than development: the
 *   component name comes back from the map's `names` array, with no hook, no
 *   development build and no build-time plugin.
 * - `profiler-unmapped` — sampled stacks not resolved through a source map,
 *   because none shipped, none could be read, or the map did not cover the
 *   position, so the names and positions are whatever the script shipped.
 *   Still a real answer, and it must be reported with the warning that the
 *   name may be minified. `UnmappedReason` says which of those it was.
 * - `loaf-script-registration` — a script entry as LoAF named it, by its
 *   `sourceCharPosition`. Precise for non-framework jank, and systematically
 *   wrong about third parties: it names the line that *registered* a
 *   listener, so a vendor library's cost is attributed to the first-party
 *   file that called `addEventListener`.
 * - `loaf-timing-only` — the frame's own boundaries and nothing else. What is
 *   left when the profiler is unavailable and there is no React: where the time
 *   went inside the frame, but not whose code it was.
 * - `unattributed` — the tool knows when it happened and declines to say what
 *   it was. Not a failure mode; a result. It is the tier the corpus's
 *   browser-work-dominated frames belong in, and two independent signals agree
 *   on it there.
 */
export type AttributionTier =
  | 'react-fiber-timings'
  | 'react-component-span'
  | 'profiler-mapped'
  | 'profiler-unmapped'
  | 'loaf-script-registration'
  | 'loaf-timing-only'
  | 'unattributed';

/**
 * The tiers in descending order of what they can support.
 *
 * Exported as data so that "strongest tier reached" is a lookup rather than a
 * comparison someone writes again each time, and so that adding a tier forces
 * a decision about where it sits.
 */
export const ATTRIBUTION_TIERS: readonly AttributionTier[] = [
  'react-fiber-timings',
  'profiler-mapped',
  'profiler-unmapped',
  'react-component-span',
  'loaf-script-registration',
  'loaf-timing-only',
  'unattributed',
];

/** One line of prose naming what a tier was working from, for a report. */
export function describeTier(tier: AttributionTier): string {
  switch (tier) {
    case 'react-fiber-timings':
      return "React's DevTools hook and fiber render timings (development build)";
    case 'react-component-span':
      return "React's own render spans, which it emits only for components whose props changed by identity";
    case 'profiler-mapped':
      return 'sampled stacks resolved through the shipped source map';
    case 'profiler-unmapped':
      return 'sampled stacks not resolved through a source map, so names are as the bundle shipped them';
    case 'loaf-script-registration':
      return "the long-frame script entry's own position, which is where the listener was registered";
    case 'loaf-timing-only':
      return "the long frame's own boundaries, with no stacks and no component signal";
    case 'unattributed':
      return 'nothing: the time is accounted for but no cause is claimed for it';
  }
}

/**
 * Why a position is in generated code rather than in an original file.
 *
 * Each is the "source map absent" tier, and each deserves a different warning,
 * because only some of them are the developer's to fix:
 *
 * - `no-source-map` — the script shipped none. The corpus's two vanilla
 *   fixtures serve hand-written files out of `public/` byte-for-byte in both
 *   build modes, so their names and positions are already the original ones;
 *   a minified bundle with no map would report minified names the same way,
 *   and nothing in the trace tells the two apart.
 * - `source-map-unavailable` — a map was named but could not be fetched.
 * - `source-map-unreadable` — a map was fetched but is not a version 3 map the
 *   resolver can read.
 * - `no-mapping-at-position` — the map covers the script but not this
 *   position: a bundler's own runtime, or a module's top level. One production
 *   frame in `spans`, at generated `1:1`, is this. Also what a map gets for
 *   naming an original line past the end of its source, which only a corrupt
 *   map does and no corpus map does.
 */
export type UnmappedReason =
  | 'no-source-map'
  | 'source-map-unavailable'
  | 'source-map-unreadable'
  | 'no-mapping-at-position';

/**
 * A position in an original source file, or in generated code with the reason
 * it is not in an original one.
 *
 * A union on `throughSourceMap`, so that a generated position cannot be written
 * without saying why no map applied, and a mapped one cannot carry such a
 * reason.
 */
export type SourceLocation =
  | {
      /**
       * The original file as the source map names it, resolved against the
       * map's `sourceRoot` but not against its URL: `OrderTable.tsx` in a
       * development capture, `../../src/OrderTable.tsx` in a production one.
       */
      readonly file: string;
      /** 1-based line, 0-based column — `core`'s convention throughout. */
      readonly position: LineColumn;
      readonly throughSourceMap: true;
    }
  | {
      /** The served script's URL. */
      readonly file: string;
      /** 1-based line, 0-based column, in the script as it was served. */
      readonly position: LineColumn;
      /**
       * The position is in generated code: a minified bundle, a dev server's
       * transform of a module, or a script served as written. A claim built on
       * one must say so.
       */
      readonly throughSourceMap: false;
      readonly whyNot: UnmappedReason;
    };

/**
 * Where a function's name came from.
 *
 * `source-map` is the map's `names` array, which is how a production bundle's
 * `h` comes back as `OrderTable`. `served-script` is the name the profiler
 * read off the script as it was served: the original name in a development
 * build or a hand-written script, a minified one in a production bundle with
 * no map, and nothing in the trace distinguishes those two.
 */
export interface FunctionName {
  readonly text: string;
  readonly from: 'source-map' | 'served-script';
}

/**
 * Why a share of a frame, a commit or a sample population has no cause
 * attached.
 *
 * The first six are slices of a frame, named for where they sit in it. The
 * rest are remainders of a narrower whole: a commit's render time, or a
 * population of samples.
 */
export type UnattributedReason =
  /**
   * The profiler sampled it and found no JavaScript on the stack. Not
   * produced as a reason of its own: the empty-stack signal is the
   * cross-check behind every slice reason below, and travels on the
   * candidate's evidence and in its confidence.
   */
  | 'no-javascript-on-stack'
  /** Before the first script entry the frame reported: input delay, plus any sub-5ms script. */
  | 'before-first-reported-script'
  /** Between two reported script entries. */
  | 'between-reported-scripts'
  /** After the last script and before the rendering update: style and layout LoAF does not count. */
  | 'outside-script-and-rendering-update'
  /**
   * Inside the rendering update, before style and layout: `requestAnimationFrame`
   * callbacks and resize or intersection observers, none of which LoAF reports
   * as a script when it runs for under 5ms.
   */
  | 'rendering-update-before-style-and-layout'
  /** After the last script on a frame that had no rendering update to name its tail. */
  | 'after-last-reported-script'
  /**
   * Nothing could see inside it: no profile was captured. For a commit, the
   * hook named the components that rendered and nothing measured their cost.
   */
  | 'no-profiler'
  /**
   * React's reconciliation beneath components it bailed out of: render time
   * inside the commit that belongs to no component that rendered.
   */
  | 'bailed-out-reconciliation'
  /**
   * Stacked samples in a commit's window that reach no rendered component's
   * frame: React's own reconciliation and commit work, or whatever ran in the
   * window before the render began.
   */
  | 'no-rendered-component-on-stack'
  /** Stacked samples with no frame that has a position to charge. */
  | 'no-located-frame';

/** A few words for an unattributed reason, for a report. */
export function describeUnattributedReason(reason: UnattributedReason): string {
  switch (reason) {
    case 'no-javascript-on-stack':
      return 'no JavaScript was on the stack';
    case 'before-first-reported-script':
      return 'before the first script the frame reported';
    case 'between-reported-scripts':
      return 'between two reported scripts';
    case 'outside-script-and-rendering-update':
      return 'after the last script and before the rendering update';
    case 'rendering-update-before-style-and-layout':
      return 'inside the rendering update, before style and layout';
    case 'after-last-reported-script':
      return 'after the last script, on a frame with no rendering update';
    case 'no-profiler':
      return 'no profile was captured to see inside it';
    case 'bailed-out-reconciliation':
      return "React's reconciliation beneath components that did not render";
    case 'no-rendered-component-on-stack':
      return 'samples that reached no rendered component';
    case 'no-located-frame':
      return 'samples with no frame that has a position';
  }
}

/**
 * What LoAF named for a script entry: the registration site of the entry
 * point, which is where a listener was added rather than whose code it ran.
 *
 * The position is a character offset into the served script, as LoAF reports
 * it. Turning it into a line needs the script's text (`char-position.ts`),
 * which the engine is not handed, so it is carried as the offset rather than
 * as a `SourceLocation` that would have to invent a line.
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
 * What a candidate cause points at.
 *
 * A union rather than a bag of optional fields, because the four kinds carry
 * genuinely different things and are useful for different claims: a component
 * is what a React developer acts on, a source location is what survives into
 * production, a third party is what a user cannot fix, and browser work is what
 * no amount of component attribution will explain.
 */
export type CauseSubject =
  | {
      readonly kind: 'component';
      readonly name: string;
      /**
       * `true` when `name` came out of a production bundle — `h`, `re` — which
       * the report must say rather than printing it as though it were a name
       * the developer would recognise.
       */
      readonly nameIsMinified: boolean;
      /** Where the component is defined, when a map or a hook could say. */
      readonly definedAt: SourceLocation | null;
    }
  | {
      /**
       * A function, located by where it is defined.
       *
       * The JS Self-Profiling API reports the line a function was *defined*
       * on, never the line that was executing, so every location the profiler
       * tier produces is a function's definition site. `granularity` says so
       * in the data rather than leaving it to the wording: line 32 of
       * `OrderTable.tsx` means "inside the component body but in no nested
       * callback", not "line 32 ran". Statement-level attribution needs CDP's
       * `positionTicks` and is unavailable from inside the page at any sample
       * count, which is why there is no other value.
       */
      readonly kind: 'source-location';
      readonly location: SourceLocation;
      readonly granularity: 'function-definition';
      /**
       * The served script the function ran in, which is what LoAF's
       * `sourceURL` names. Carried beside `location` because a mapped location
       * names an original file, and the question "is this the script LoAF
       * blamed" is about the served one.
       */
      readonly scriptUrl: string;
      /** `null` for an anonymous function or a module's top level. */
      readonly functionName: FunctionName | null;
      /**
       * For an anonymous callback, the call it was passed to, e.g. `.sort`,
       * read from the source map's `sourcesContent` at the resolved position.
       *
       * This is what makes the claim defensible. The honest phrasing is
       * `OrderTable.tsx:36, in the callback passed to .sort`, and "line 36 is
       * slow" is not. `null` for a named function, and wherever the original
       * text is not available.
       */
      readonly enclosingCallToken: string | null;
    }
  | {
      /**
       * A LoAF script entry, named by the site LoAF gave for it. The subject
       * of the `loaf-script-registration` tier: what is left to name when no
       * stronger signal says whose code ran inside the entry.
       */
      readonly kind: 'script-entry';
      readonly site: ScriptEntrySite;
      /**
       * `whole-entry` when the candidate is all of the entry's own
       * JavaScript. `outside-component-renders` when component candidates
       * beside it were charged the renders that ran inside the entry, and
       * this one is the rest: React's own work and the handler that started
       * it.
       */
      readonly scope: 'whole-entry' | 'outside-component-renders';
    }
  | {
      readonly kind: 'third-party-script';
      readonly url: string;
      /** A vendor name, when something could map the URL to one. */
      readonly entity: string | null;
    }
  | {
      readonly kind: 'browser-work';
      readonly what: 'forced-style-and-layout' | 'style' | 'layout' | 'paint';
      /**
       * The script entry that forced it, as LoAF named it: forced style and
       * layout is reported on the script entry it happened inside, so the
       * work is charged to that entry. `null` for the rendering update's own
       * style, layout and paint, which no script forced.
       *
       * LoAF's site rather than a `SourceLocation`, because the entry's
       * position is a character offset nobody here can turn into a line. The
       * functions the profiler saw running in the same entry are separate
       * candidates beside this one.
       */
      readonly forcedBy: ScriptEntrySite | null;
    }
  | {
      readonly kind: 'unattributed';
      readonly reason: UnattributedReason;
    };

/**
 * What a weight was computed from.
 *
 * Required, so that a weight cannot exist without saying how it was arrived at.
 * The difference between a weight derived from 46 of 63 samples and one derived
 * from a single frame's timing overlap is the difference between a claim and a
 * guess, and a bare number loses it.
 */
export type WeightBasis =
  /**
   * Share of the independent samples in a window that were charged to this
   * subject, bursts collapsed. The window is named on the `profiler-samples`
   * evidence beside it, and the independent counts are on the weight's
   * confidence.
   */
  | 'sample-share'
  /**
   * A component's fiber self time as a share of the whole being divided: its
   * commit's render time, or the duration of the frame the commit landed in.
   */
  | 'fiber-self-time-share'
  /** Share of the frame's own duration, from LoAF's partition. */
  | 'frame-slice-share'
  /**
   * A script slice's JavaScript, as a share of the frame from LoAF's
   * partition, divided among functions by their share of the samples taken
   * inside that entry's slices across the replay. The product of a
   * measurement and an estimate, and only as good as the estimate.
   */
  | 'frame-slice-sample-share'
  /**
   * The only candidate the evidence allows: the degenerate case. Not
   * produced: a sole candidate keeps the basis its weight was measured on,
   * and `RankedCauses.lead` is what says it stands alone.
   */
  | 'sole-candidate'
  /**
   * Nothing but the fact that the two windows overlapped. The weakest basis,
   * and not produced: where overlap is all that is known, the overlapping
   * components are named as evidence on the script entry they overlapped and
   * none is given a share (`frame-attribution.ts`), because any split of the
   * time among them would be a number nobody measured.
   */
  | 'window-overlap';

/**
 * A weight in [0, 1], with what it was computed from and how far it can be
 * trusted.
 *
 * Not a bare number: the type exists so that a fraction cannot travel without
 * its basis or its confidence, and so that the range check happens once, in
 * `confidenceWeight`, rather than at each site that divides two measurements.
 * `basis` says what the fraction is a share of. `confidence` says how well it
 * is known: a level, the range the true share plausibly lies in, and the
 * support both were derived from (`confidence.ts`).
 */
export interface ConfidenceWeight {
  readonly fraction: number;
  readonly basis: WeightBasis;
  readonly confidence: WeightConfidence;
}

/** How far a sampled weight may sit from its own counts before it is a different number. */
const SAMPLED_WEIGHT_SLACK = 1e-9;

/**
 * Builds a weight, or throws saying what was wrong with it.
 *
 * `support` is how the fraction was arrived at, and the weight's level and
 * range are derived from it here, so neither can be supplied by a caller. A
 * weight therefore cannot exist with a confidence nobody can inspect the
 * reason for.
 *
 * Throws rather than clamping on a value outside [0, 1] or a non-finite one,
 * because every such value this project could produce is a division by a
 * denominator that was zero or came from a different frame — and a clamped 1.0
 * would present that as total confidence. Throws too when a sampled weight
 * disagrees with the counts it claims to be a share of, since a range computed
 * from one number and a fraction computed from another would describe two
 * different estimates.
 */
export function confidenceWeight(
  fraction: number,
  basis: WeightBasis,
  support: WeightSupport,
): ConfidenceWeight {
  if (!Number.isFinite(fraction)) {
    throw new Error(`confidence weight is ${String(fraction)}, which is not a number`);
  }
  if (fraction < 0 || fraction > 1) {
    throw new Error(`confidence weight ${String(fraction)} is outside [0, 1]`);
  }
  if (support.kind === 'sampled' && support.ofIndependentSamples > 0) {
    const fromCounts =
      (support.ofMeasuredShare * support.independentSamples) /
      support.ofIndependentSamples;
    if (Math.abs(fromCounts - fraction) > SAMPLED_WEIGHT_SLACK) {
      throw new Error(
        `confidence weight ${String(fraction)} is not the share its sample counts give, ` +
          String(fromCounts),
      );
    }
  }
  return {
    fraction,
    basis,
    confidence: {
      level: confidenceLevelOf(support),
      range: weightRangeOf(fraction, support),
      support,
    },
  };
}

/**
 * The window a sample count was taken over.
 *
 * Named because the denominator changes what a share means. `frame` is the
 * long frame's own extent, by `isWithinFrame`. `since-previous-commit` is the
 * stretch of page clock that ends at a React commit and begins at the latest
 * of the interaction's start, the previous commit, and the last recorded
 * input action at or before the commit. The hook reports when a commit
 * finished but not when its render began, so the window bounds the render
 * rather than being it, and it can hold samples of whatever ran between its
 * start and the render's. `interaction` is the union of the capture's
 * interaction windows, which is the replay population: it does not depend on
 * how many presses cleared LoAF's 50ms threshold. `script-slice` is a frame's
 * script slices, half-open so that a sample on the boundary between two
 * adjacent scripts belongs to one of them.
 */
export type SampleWindowKind =
  'frame' | 'since-previous-commit' | 'interaction' | 'script-slice';

/**
 * One piece of evidence behind a candidate cause.
 *
 * Every variant carries its own denominator where it has one, so that "46
 * samples" is never reported without the "of 63" that makes it mean something.
 * Per-frame sample percentages are not usable on their own — plus or minus 20
 * points at five samples — which is why the replay exists and why the counts
 * travel with the claim.
 */
export type CauseEvidence =
  | {
      /**
       * Raw counts, as the trace holds them. The weight beside this evidence
       * is computed from the same samples with bursts collapsed, and its
       * confidence carries those independent counts.
       */
      readonly kind: 'profiler-samples';
      readonly samples: number;
      /** The denominator: samples with a stack inside `window`. */
      readonly ofSamplesInWindow: number;
      /** Which window the samples were counted in. See `SampleWindowKind`. */
      readonly window: SampleWindowKind;
    }
  | {
      readonly kind: 'fiber-render-time';
      readonly componentName: string;
      /** The fiber's subtree time, as React reported it. */
      readonly actualDurationMs: number;
      /**
       * `actualDurationMs` minus the in-commit children's, signed — see
       * `fiber-self-time.ts` — or `null` where the capture could not
       * support the subtraction. See `react.ts`.
       */
      readonly selfDurationMs: number | null;
    }
  | {
      /**
       * The DevTools hook saw this fiber render, from React's own render
       * evidence, with no timing attached. What a production build leaves: the
       * hook still fires on every commit and the `PerformedWork` bit is still
       * set, but `actualDuration` is null, so *that* a component rendered is
       * known and *how long for* has to come from somewhere else.
       */
      readonly kind: 'fiber-rendered';
      readonly componentName: string;
      readonly participation: 'mounted' | 'updated';
    }
  | {
      readonly kind: 'react-component-span';
      readonly componentName: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'loaf-script';
      readonly scriptIndex: number;
      readonly durationMs: number;
      readonly resolvedFromCharPosition: boolean;
    }
  | {
      readonly kind: 'forced-style-and-layout';
      readonly scriptIndex: number;
      readonly durationMs: number;
    }
  | {
      /**
       * A slice of the frame's partition that is not a script: the time
       * before, between or after the scripts, or part of the rendering
       * update. `slice` is the partition's own name for it
       * (`frame-decomposition.ts`), and `durationMs` its length.
       */
      readonly kind: 'frame-slice';
      readonly slice: Exclude<FrameSlice['kind'], 'script'>;
      readonly durationMs: number;
    }
  | {
      /**
       * Of the samples charged to a function, how many had ignore-listed code
       * at the leaf: library code, by the source map's own `ignoreList`, that
       * this function called. Those samples are charged to the innermost
       * function the map does not ignore, so that React's JSX runtime working
       * on behalf of a `.map` callback is reported as that callback's cost.
       * The count keeps the folding visible.
       */
      readonly kind: 'ignore-listed-callees';
      readonly samples: number;
    }
  | {
      /**
       * The profiler's side of a frame's cross-check, in raw counts: how many
       * of the samples inside the frame had no JavaScript on the stack. The
       * verdict, computed from the independent counts, is on the weight's
       * confidence.
       */
      readonly kind: 'empty-stack-share';
      readonly samplesWithoutStack: number;
      readonly ofSamplesInFrame: number;
    };

/**
 * A non-empty list of evidence, as `CandidateCause` requires: mutable, for the
 * builders that add to a candidate's evidence before it is ranked.
 */
export type NonEmptyEvidence = [CauseEvidence, ...CauseEvidence[]];

/**
 * One candidate cause of a frame's cost.
 *
 * `tier` and `evidence` are both required, and `evidence` is a non-empty tuple.
 * Those two choices are the whole point of the type: a candidate with no tier
 * is a number whose provenance has been lost, and a candidate with no evidence
 * is an assertion. Neither can be constructed.
 */
export interface CandidateCause {
  readonly subject: CauseSubject;
  readonly weight: ConfidenceWeight;
  readonly tier: AttributionTier;
  readonly evidence: readonly [CauseEvidence, ...CauseEvidence[]];
}

/**
 * Candidate causes in descending weight order, with their total.
 *
 * The total is carried rather than recomputed because it is the honest part: it
 * says how much of the frame the ranking accounts for, and the remainder is the
 * unattributed share. A ranking that summed to 1.0 on a frame that was 90%
 * browser work would be the exact failure the unattributed tier exists to
 * prevent.
 */
export interface RankedCauses {
  readonly causes: readonly CandidateCause[];
  /** Sum of the weights, in [0, 1]. */
  readonly totalWeight: number;
  readonly lead: RankingLead;
}

/**
 * Whether the first candidate is distinguishable from the second on the
 * evidence, which is the difference between an answer and a ranked guess.
 *
 * - `clear` — the first candidate's range lies wholly above the second's.
 * - `within-noise` — the two ranges overlap, so the order between them is not
 *   established: sampling noise at a handful of samples, or two measurements
 *   closer together than the timing grid.
 * - `sole` — there is one candidate, the degenerate case.
 * - `none` — there are no candidates.
 *
 * Read from the candidates' own ranges, so it needs no threshold of its own.
 * The corpus's sharpest case is `derive-in-render` in production (4x). Inside
 * its long frames there are four stacked samples: two in the component's
 * body, defined on line 32, one in `App`, and one in the `.sort` comparator
 * defined on line 36. The body's range is 15-85% and the comparator's 5-70%,
 * `within-noise`, and the candidate in front is not the declared culprit.
 * Over the replay the comparator holds 56 of 69 stacked samples against the
 * body's 11, ranges of 70-89% and 9-26%, and the lead is `clear`.
 */
export type RankingLead = 'clear' | 'within-noise' | 'sole' | 'none';

/** The lead of a ranking already in descending weight order. See `RankingLead`. */
function leadOf(ranked: readonly CandidateCause[]): RankingLead {
  const [first, second] = ranked;
  if (first === undefined) return 'none';
  if (second === undefined) return 'sole';
  return first.weight.confidence.range.low > second.weight.confidence.range.high
    ? 'clear'
    : 'within-noise';
}

/**
 * Sorts candidates by weight and checks that they do not claim more than the
 * whole they are shares of: a frame, or a commit's render.
 *
 * Throws when the weights sum past 1 by more than a rounding hair, because
 * every way of producing that is a double count — the same milliseconds charged
 * to a component and to the script that rendered it, or forced style and layout
 * added alongside the script it happened inside. That is the mistake
 * `findings.md` names first, and it should fail where it is made rather than
 * surface as a frame that is 140% explained.
 *
 * Ties are left in the order they were supplied: with five samples a frame's
 * second and third candidates are routinely tied, and inventing an order
 * between them would present sampling noise as a ranking.
 */
export function rankCauses(causes: readonly CandidateCause[]): RankedCauses {
  const ranked = [...causes].sort((a, b) => b.weight.fraction - a.weight.fraction);
  const totalWeight = ranked.reduce((sum, cause) => sum + cause.weight.fraction, 0);

  // One part in a thousand: enough to absorb floating-point summation of
  // weights that were each derived from a division, and far too small to hide a
  // genuine double count, the smallest of which would be a whole slice.
  if (totalWeight > 1.001) {
    throw new Error(
      `candidate causes' weights sum to ${totalWeight.toFixed(3)}, which is more than all of it`,
    );
  }

  return { causes: ranked, totalWeight: Math.min(totalWeight, 1), lead: leadOf(ranked) };
}
