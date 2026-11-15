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
 * read a fiber tree, weight a sample, or decide which tier a frame qualifies
 * for. Those are the next steps, and a type model that smuggled them in would
 * be deciding them before the arithmetic they rest on has been reviewed.
 */

import type { LineColumn } from './char-position.ts';

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
 * - `loaf-script-registration` — a script entry's `sourceCharPosition`,
 *   resolved. Precise for non-framework jank, and systematically wrong about
 *   third parties: it names the line that *registered* a listener, so a vendor
 *   library's cost is attributed to the first-party file that called
 *   `addEventListener`.
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

/** Why a slice of a frame has no cause attached. */
export type UnattributedReason =
  /** The profiler sampled it and found no JavaScript on the stack. */
  | 'no-javascript-on-stack'
  /** Before the first script entry the frame reported: input delay, plus any sub-5ms script. */
  | 'before-first-reported-script'
  /** Between two reported script entries. */
  | 'between-reported-scripts'
  /** After the last script and before the rendering update: style and layout LoAF does not count. */
  | 'outside-script-and-rendering-update'
  /** No profiler, so nothing could see inside the frame at all. */
  | 'no-profiler';

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
      readonly kind: 'third-party-script';
      readonly url: string;
      /** A vendor name, when something could map the URL to one. */
      readonly entity: string | null;
    }
  | {
      readonly kind: 'browser-work';
      readonly what: 'forced-style-and-layout' | 'style' | 'layout' | 'paint';
      /**
       * The script that forced it, where the browser named one.
       *
       * Nothing constructs this yet. When something first does, the position
       * will come from LoAF's `sourceCharPosition` in the served script, and
       * an unmapped `SourceLocation` must say why no map applied. A position
       * nobody tried to resolve through a map fits none of `UnmappedReason`'s
       * four members, so it will need a "not attempted" member then, rather
       * than borrowing `no-source-map` and claiming something unchecked.
       */
      readonly forcedBy: SourceLocation | null;
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
   * Share of the samples in a window whose stack reached this subject. The
   * window is named on the `profiler-samples` evidence beside it.
   */
  | 'sample-share'
  /** Share of a commit's render time, from fiber timings. */
  | 'fiber-self-time-share'
  /** Share of the frame's own duration, from LoAF's partition. */
  | 'frame-slice-share'
  /** The only candidate the evidence allows: the degenerate case. */
  | 'sole-candidate'
  /** Nothing but the fact that the two windows overlapped. The weakest basis. */
  | 'window-overlap';

/**
 * A weight in [0, 1], with what it was computed from.
 *
 * Not a bare number: the type exists so that a fraction cannot travel without
 * its basis, and so that the range check happens once, in `confidenceWeight`,
 * rather than at each site that divides two measurements.
 */
export interface ConfidenceWeight {
  readonly fraction: number;
  readonly basis: WeightBasis;
}

/**
 * Builds a weight, or throws saying what was wrong with it.
 *
 * Throws rather than clamping on a value outside [0, 1] or a non-finite one,
 * because every such value this project could produce is a division by a
 * denominator that was zero or came from a different frame — and a clamped 1.0
 * would present that as total confidence.
 */
export function confidenceWeight(fraction: number, basis: WeightBasis): ConfidenceWeight {
  if (!Number.isFinite(fraction)) {
    throw new Error(`confidence weight is ${String(fraction)}, which is not a number`);
  }
  if (fraction < 0 || fraction > 1) {
    throw new Error(`confidence weight ${String(fraction)} is outside [0, 1]`);
  }
  return { fraction, basis };
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
      readonly kind: 'empty-stack-share';
      readonly samplesWithoutStack: number;
      readonly ofSamplesInFrame: number;
    };

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

  return { causes: ranked, totalWeight: Math.min(totalWeight, 1) };
}
