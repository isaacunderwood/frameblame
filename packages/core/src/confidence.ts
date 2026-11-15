/**
 * The confidence model: how far a weight can be trusted, and what that
 * judgement rests on.
 *
 * A weight says how much of a whole a candidate is charged with. This module
 * says how well that number is known, in three quantities and no score:
 *
 * 1. **Its support**, which is how the number was arrived at. It was
 *    *measured*, by timers the browser or React ran around the thing itself.
 *    Or it was *sampled*, estimated from the profiler's samples, and is as
 *    good as the number of independent samples behind it. Or it is what was
 *    left after *subtraction*, which is how every unattributed share arises,
 *    and is as good as the second signal that confirms it.
 * 2. **Its range**, the interval the true share plausibly lies in. A point
 *    for a measurement, to within the timing grid. A 95% Wilson interval for
 *    a sampled share, which widens as the samples thin. Where the evidence is
 *    thin the answer gets wider, not wrong.
 * 3. **Its level**, a three-valued summary derived from the other two by the
 *    rule in `confidenceLevelOf`, and never set by hand.
 *
 * The tier a candidate stands on (`AttributionTier`) is the fourth quantity,
 * and it lives on the candidate rather than here: a tier says what kind of
 * thing could be named, and confidence says how well its share is known. A
 * LoAF script entry's share of a frame is measured exactly and names only the
 * line that registered a listener; a function's share over five samples names
 * the right function and is a guess about how much.
 *
 * ## Why these three and not a score
 *
 * `findings.md` gives the model its job in four sentences, and each one maps
 * to a support rather than to a number between 0 and 1. The component is
 * known in development: fiber self times are measurements. The function is a
 * distribution over replayed frames, not a per-frame percentage: a sample
 * share, with a range that is plus or minus 20 points at five samples. The
 * statement is unavailable from inside the page: no support exists for it, so
 * no candidate can claim it (`CauseSubject`'s `granularity` has one value).
 * The unattributed remainder is cross-checked against the empty-stack share:
 * subtraction, with a second signal.
 *
 * ## What this module does not do
 *
 * It does not know what a frame, a commit or a stack is. It takes counts and
 * shares and returns ranges, levels and verdicts. Collapsing bursts of
 * samples into independent ones is `profiler.ts`; deciding what to count is
 * the attribution modules'.
 */

/**
 * A weight's confidence in one word, strongest first in `CONFIDENCE_LEVELS`.
 *
 * - `high` — the share was measured rather than estimated, or it was inferred
 *   by subtraction and a second, independent signal agrees with it.
 * - `moderate` — a sampled share over enough independent samples that no
 *   share's range could be wider than plus or minus
 *   `USABLE_SHARE_HALF_WIDTH`, or a subtraction nothing was available to
 *   check.
 * - `low` — a sampled share over too few samples to be more than a ranked
 *   guess, or a subtraction the second signal contradicts.
 *
 * A sampled share is never `high`. The word is kept for a number that was
 * measured or independently confirmed; how precise an estimate is, is what
 * its range is for.
 */
export type ConfidenceLevel = 'high' | 'moderate' | 'low';

/** The levels, strongest first, so that "lower confidence" is an index comparison. */
export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['high', 'moderate', 'low'];

/** Whether `a` is a strictly lower level than `b`. */
export function isLowerConfidence(a: ConfidenceLevel, b: ConfidenceLevel): boolean {
  return CONFIDENCE_LEVELS.indexOf(a) > CONFIDENCE_LEVELS.indexOf(b);
}

/**
 * The interval a share plausibly lies in, both ends in [0, 1], with
 * `low <= high`. The weight it belongs to lies inside it.
 */
export interface WeightRange {
  readonly low: number;
  readonly high: number;
}

/**
 * The widest a sampled share's 95% range may be, as a half-width, and still be
 * called an estimate rather than a guess: plus or minus 20 points.
 *
 * The figure is the project's own. `findings.md` calls per-frame percentages
 * unusable at "plus or minus 20 points at five samples", and says 24 presses
 * is what makes the function-level distribution stable. A Wilson interval at
 * an even split, where it is widest, reaches this half-width at 21
 * independent samples and is inside it from there on, which puts the line
 * where those two sentences put it.
 */
export const USABLE_SHARE_HALF_WIDTH = 0.2;

/**
 * The fewest independent samples a share may be compared over: five, the count
 * at which one sample is worth `USABLE_SHARE_HALF_WIDTH` of the share. Below
 * it a single sample moves the share by more than the model's coarsest usable
 * resolution, so a comparison of two shares says nothing either way.
 */
export const MIN_SAMPLES_TO_COMPARE_SHARES = 1 / USABLE_SHARE_HALF_WIDTH;

/**
 * The two-sided normal quantile for 95%, which is the confidence every sampled
 * range in this project is quoted at.
 */
const Z_95 = 1.959964;

/**
 * The 95% Wilson score interval for a share of `successes` in `trials`.
 *
 * Wilson rather than the textbook `p +/- z * sqrt(p(1-p)/n)`, because the
 * counts here are small and the shares are often 0 or 1. At five samples that
 * all landed in one function the textbook interval is `[1, 1]`, total
 * certainty from five samples, and Wilson gives `[0.57, 1]`.
 *
 * Both arguments are counts of *independent* samples, which may be fractional
 * (see `independentSampleWeights` in `profiler.ts`). The interval treats them
 * as independent draws. Consecutive profiler ticks are not quite that, since
 * one long function spans several of them, so the range is a floor on the
 * uncertainty rather than an exact statement of it. With no trials at all the
 * range is everything, `[0, 1]`.
 */
export function wilsonRange(successes: number, trials: number): WeightRange {
  if (!(trials > 0)) return { low: 0, high: 1 };
  const share = Math.min(Math.max(successes / trials, 0), 1);
  const z2OverN = (Z_95 * Z_95) / trials;
  const centre = (share + z2OverN / 2) / (1 + z2OverN);
  const half =
    (Z_95 * Math.sqrt((share * (1 - share)) / trials + z2OverN / (4 * trials))) /
    (1 + z2OverN);
  // The interval contains the share by construction; the clamps only absorb
  // float error at shares of exactly 0 and 1, where an end equals the share.
  return {
    low: Math.min(Math.max(centre - half, 0), share),
    high: Math.max(Math.min(centre + half, 1), share),
  };
}

/**
 * The verdict of comparing the frame partition against the profiler about how
 * much of a frame had no script running.
 *
 * The two signals are independent. LoAF's boundaries say how much of the frame
 * lay outside every script entry it reported. The profiler says what share of
 * its in-frame samples had no JavaScript on the stack. Subtraction alone
 * cannot tell browser work from a gap in LoAF's own accounting, and an empty
 * stack alone does not say how much time it covers. When they agree, the time
 * outside scripts really had no script in it, and declining to name a cause
 * for it is a finding rather than a shrug.
 *
 * - `agrees` and `disagrees` carry both shares and the counts behind the
 *   sampled one, in independent samples.
 * - `unchecked` says why there was no comparison: no profile at all, or fewer
 *   than `MIN_SAMPLES_TO_COMPARE_SHARES` independent samples inside the frame.
 */
export type CrossCheck =
  | {
      readonly verdict: 'agrees' | 'disagrees';
      /** Share of the frame's duration outside every reported script, from LoAF. */
      readonly shareOutsideScripts: number;
      /** Independent in-frame samples with no JavaScript on the stack. */
      readonly samplesWithoutStack: number;
      /** Independent in-frame samples, with a stack or without. */
      readonly ofSamplesInFrame: number;
      /**
       * How far `samplesWithoutStack` may sit from the count the partition
       * predicts and still agree, in samples. See `crossCheckEmptyStacks`.
       */
      readonly toleranceSamples: number;
    }
  | { readonly verdict: 'unchecked'; readonly reason: 'no-profiler' }
  | {
      readonly verdict: 'unchecked';
      readonly reason: 'too-few-samples';
      /** Independent in-frame samples: fewer than `MIN_SAMPLES_TO_COMPARE_SHARES`. */
      readonly ofSamplesInFrame: number;
    };

/**
 * Compares the share of a frame outside every reported script with the share
 * of in-frame samples that had no JavaScript on the stack.
 *
 * `shareOutsideScripts` is a fraction of the frame's duration, from LoAF's
 * boundaries. `emptyStack` holds the profiler's side in independent samples,
 * or `null` when there was no profile.
 *
 * The two agree when the observed empty-stack count is within the larger of
 * one sample and two binomial standard deviations of the count the partition
 * predicts, `n * share`. The tolerance is in samples because that is the unit
 * the profiler's evidence comes in: at ten samples a frame that is 15%
 * outside scripts predicts 1.5 empty stacks, and 0 to 3 are all ordinary
 * draws. A tolerance in points cannot say that. One corpus frame holds 2
 * empty stacks of 6 against a predicted 0.85, which is 19 points apart and
 * 1.15 samples (`derive-in-render`, development, 4x). The one-sample floor
 * is the count's own resolution.
 *
 * Measured on the corpus's 53 frames (4x, both build modes): 45 agree, 8 are
 * unchecked for holding fewer than five samples (all in `derive-in-render`:
 * five frames with four samples each and three with none), and none disagree.
 * What a disagreement looks like is therefore reasoned: the unforced
 * `innerHTML` frames are 88.9-90.3% outside scripts, and they would disagree
 * if their samples showed the forced frames' 10-30% of empty stacks instead of
 * the 88.9-91.7% they do show.
 */
export function crossCheckEmptyStacks(
  shareOutsideScripts: number,
  emptyStack: {
    readonly samplesWithoutStack: number;
    readonly ofSamplesInFrame: number;
  } | null,
): CrossCheck {
  if (emptyStack === null) return { verdict: 'unchecked', reason: 'no-profiler' };

  const { samplesWithoutStack, ofSamplesInFrame } = emptyStack;
  if (ofSamplesInFrame < MIN_SAMPLES_TO_COMPARE_SHARES) {
    return { verdict: 'unchecked', reason: 'too-few-samples', ofSamplesInFrame };
  }

  const share = Math.min(Math.max(shareOutsideScripts, 0), 1);
  const predicted = ofSamplesInFrame * share;
  const toleranceSamples = Math.max(
    1,
    2 * Math.sqrt(ofSamplesInFrame * share * (1 - share)),
  );
  return {
    verdict:
      Math.abs(samplesWithoutStack - predicted) <= toleranceSamples
        ? 'agrees'
        : 'disagrees',
    shareOutsideScripts: share,
    samplesWithoutStack,
    ofSamplesInFrame,
    toleranceSamples,
  };
}

/**
 * How a weight was arrived at, which decides how far it can be trusted.
 *
 * A union, so that each kind carries exactly what its confidence is derived
 * from and nothing can claim a level without it: a sampled share cannot exist
 * without its independent counts, and a subtraction cannot exist without the
 * verdict of its cross-check, even when the verdict is that nothing checked
 * it.
 */
export type WeightSupport =
  | {
      /**
       * Arithmetic on durations the browser or React timed directly: a fiber's
       * self time as a share of its commit or its frame, a frame slice as a
       * share of its frame. Not an estimate.
       */
      readonly kind: 'measured';
      /**
       * The timing grid as a share of the weight's denominator: two 100us
       * coarsening steps (`COARSENED_TIMING_TOLERANCE_MS`) over the
       * denominator's milliseconds. The weight is exact to within this, and
       * two measured weights closer than it are not distinguishable.
       */
      readonly gridShare: number;
    }
  | {
      /**
       * A share of profiler samples, counted in independent samples: bursts
       * collapsed, so a sample taken nine times in a millisecond counts once.
       */
      readonly kind: 'sampled';
      readonly independentSamples: number;
      readonly ofIndependentSamples: number;
      /**
       * The measured share the sample share divides, in (0, 1]. 1 where the
       * weight is the sample share itself. Less where the weight is a frame
       * slice's measured share of its frame, split among functions by their
       * share of the samples: the weight is then
       * `ofMeasuredShare * independentSamples / ofIndependentSamples`.
       */
      readonly ofMeasuredShare: number;
    }
  | {
      /**
       * What was left when everything attributable was taken out. The
       * arithmetic is exact; what it cannot say alone is that nothing
       * attributable was there, which is what `check` is for.
       */
      readonly kind: 'subtraction';
      readonly check: CrossCheck;
    };

/** A weight's confidence: the level, the range, and the support both came from. */
export interface WeightConfidence {
  readonly level: ConfidenceLevel;
  readonly range: WeightRange;
  readonly support: WeightSupport;
}

/**
 * The level a support earns. This is the whole rule, and it is the only place
 * a level is decided.
 *
 * - `measured` is `high`: the number is a measurement of the thing claimed.
 * - `sampled` is `moderate` when there are enough independent samples that
 *   an even split of them would have a 95% range within plus or minus
 *   `USABLE_SHARE_HALF_WIDTH`, and `low` otherwise. Judged at the even split,
 *   the widest a range can be at that count, so that the level is a property
 *   of how much evidence there was and not of where the share happened to
 *   fall: one sample of thirteen has a narrow range and is no better founded
 *   than nine of thirteen, and every candidate in one ranking gets the same
 *   answer. The candidate's own range still says how wide its share is.
 *   Scaling by `ofMeasuredShare` does not enter into it, because scaling a
 *   guess by a small slice makes its range narrow without making it less of
 *   a guess.
 * - `subtraction` is `high` when the cross-check agrees, `moderate` when
 *   nothing was available to check it, and `low` when the check disagrees.
 */
export function confidenceLevelOf(support: WeightSupport): ConfidenceLevel {
  switch (support.kind) {
    case 'measured':
      return 'high';
    case 'sampled': {
      const samples = support.ofIndependentSamples;
      const widest = wilsonRange(samples / 2, samples);
      return (widest.high - widest.low) / 2 <= USABLE_SHARE_HALF_WIDTH
        ? 'moderate'
        : 'low';
    }
    case 'subtraction':
      switch (support.check.verdict) {
        case 'agrees':
          return 'high';
        case 'unchecked':
          return 'moderate';
        case 'disagrees':
          return 'low';
      }
  }
}

function clampShare(share: number): number {
  return Math.min(Math.max(share, 0), 1);
}

/**
 * The range a weight of `fraction` plausibly lies in, given its support.
 *
 * - `measured`: the fraction plus or minus the timing grid's share.
 * - `sampled`: the Wilson range of the sample share, scaled by the measured
 *   share it divides.
 * - `subtraction`: the fraction itself where the check agrees or was not
 *   made. Where the check disagrees, the span between the fraction and what
 *   it would be if the profiler's empty-stack share were the true share
 *   outside scripts, since one of the two signals is wrong and nothing here
 *   says which.
 */
export function weightRangeOf(fraction: number, support: WeightSupport): WeightRange {
  switch (support.kind) {
    case 'measured':
      return {
        low: clampShare(fraction - support.gridShare),
        high: clampShare(fraction + support.gridShare),
      };
    case 'sampled': {
      const range = wilsonRange(support.independentSamples, support.ofIndependentSamples);
      return {
        low: Math.min(range.low * support.ofMeasuredShare, fraction),
        high: Math.max(range.high * support.ofMeasuredShare, fraction),
      };
    }
    case 'subtraction': {
      const { check } = support;
      if (check.verdict !== 'disagrees' || check.shareOutsideScripts <= 0) {
        return { low: fraction, high: fraction };
      }
      const sampledShare = check.samplesWithoutStack / check.ofSamplesInFrame;
      const bySamples = clampShare((fraction * sampledShare) / check.shareOutsideScripts);
      return { low: Math.min(fraction, bySamples), high: Math.max(fraction, bySamples) };
    }
  }
}

/** One line of prose for a cross-check, for a report that must say what it compared. */
export function describeCrossCheck(check: CrossCheck): string {
  if (check.verdict === 'unchecked') {
    return check.reason === 'no-profiler'
      ? 'not cross-checked: no profile was captured, so this rests on subtraction alone'
      : `not cross-checked: only ${check.ofSamplesInFrame.toFixed(1)} independent samples fell inside the frame, too few to compare a share over`;
  }
  const outside = `${(100 * check.shareOutsideScripts).toFixed(1)}%`;
  const empty =
    `${check.samplesWithoutStack.toFixed(1)} of ${check.ofSamplesInFrame.toFixed(1)} ` +
    'independent in-frame samples had no JavaScript on the stack';
  return check.verdict === 'agrees'
    ? `cross-checked: ${outside} of the frame lay outside every reported script, and ${empty}, which agrees`
    : `cross-check failed: ${outside} of the frame lay outside every reported script, but ${empty}, which does not agree`;
}

/** One line of prose for a weight's confidence: the level, and what it rests on. */
export function describeConfidence(confidence: WeightConfidence): string {
  const { level, range, support } = confidence;
  const percent = (share: number): string => `${(100 * share).toFixed(1)}%`;
  switch (support.kind) {
    case 'measured':
      return `${level} confidence: measured, exact to the timing grid`;
    case 'sampled':
      return (
        `${level} confidence: sampled, ${support.independentSamples.toFixed(1)} of ` +
        `${support.ofIndependentSamples.toFixed(1)} independent samples, so between ` +
        `${percent(range.low)} and ${percent(range.high)} at 95%`
      );
    case 'subtraction':
      return `${level} confidence: what was left after subtraction, ${describeCrossCheck(support.check)}`;
  }
}
