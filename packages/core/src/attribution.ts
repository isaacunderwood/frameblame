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
 * - `profiler-unmapped` — sampled stacks with no map, so the names are whatever
 *   the bundle shipped. Still a real answer, and it must be reported with the
 *   warning that the name is minified.
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
      return 'sampled stacks with no source map, so names are as the bundle shipped them';
    case 'loaf-script-registration':
      return "the long-frame script entry's own position, which is where the listener was registered";
    case 'loaf-timing-only':
      return "the long frame's own boundaries, with no stacks and no component signal";
    case 'unattributed':
      return 'nothing: the time is accounted for but no cause is claimed for it';
  }
}

/** A position in an original source file, and whether a map was involved. */
export interface SourceLocation {
  /** The original file as the source map names it, or the served script's URL. */
  readonly file: string;
  /** 1-based line, 0-based column — `core`'s convention throughout. */
  readonly position: LineColumn;
  /**
   * `false` means the position is in generated code: a minified bundle, or a
   * dev server's transform of a module. A claim built on one must say so.
   */
  readonly throughSourceMap: boolean;
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
      readonly kind: 'source-location';
      readonly location: SourceLocation;
      readonly functionName: string | null;
      /**
       * The token the enclosing call sits on, e.g. `.sort`, when it could be
       * recovered from the served text.
       *
       * This is what makes the claim defensible. The profiler reports the line
       * a function was *defined* on, so the honest phrasing is
       * `OrderTable.tsx:36, in the callback passed to .sort` — statement-level
       * attribution is unavailable from inside the page at any sample count.
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
      /** The script that forced it, where the browser named one. */
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
 * long frame's own extent, by `isWithinFrame`. `commit-render` is the stretch
 * of page clock that ends at a React commit and begins at the previous commit
 * or the interaction's start, whichever is later: the hook reports when a
 * commit finished but not when its render began, so the window is the
 * tightest bound the records support rather than the render itself, and it
 * can hold samples of whatever ran before the render started.
 */
export type SampleWindowKind = 'frame' | 'commit-render';

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
       * `component-attribution.ts` — or `null` where the capture could not
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
 * whole frame.
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
      `candidate causes claim ${totalWeight.toFixed(3)} of the frame, which is more than all of it`,
    );
  }

  return { causes: ranked, totalWeight: Math.min(totalWeight, 1) };
}
