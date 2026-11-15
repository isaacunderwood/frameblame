/**
 * The confidence model's rules, on the smallest numbers that show each one.
 *
 * Nothing here is a measurement except where a comment says so and gives the
 * build mode and throttle rate. `packages/corpus` asserts what these rules say
 * about the real captures.
 */

import { describe, expect, it } from 'vitest';

import {
  confidenceLevelOf,
  type CrossCheck,
  crossCheckEmptyStacks,
  describeConfidence,
  describeCrossCheck,
  isLowerConfidence,
  isUsableSampleCount,
  measuredSupport,
  MIN_SAMPLES_TO_COMPARE_SHARES,
  type SampledSupport,
  scaledSampleSupport,
  sampleShareSupport,
  subtractionSupport,
  USABLE_SHARE_HALF_WIDTH,
  weightRangeOf,
  type WeightSupport,
  wilsonRange,
} from './confidence.ts';

function sampled(samples: number, of: number, ofMeasuredShare = 1): WeightSupport {
  return {
    kind: 'sampled',
    independentSamples: samples,
    ofIndependentSamples: of,
    ofMeasuredShare,
    inOwnWindow: null,
  };
}

const halfWidth = (samples: number, of: number): number => {
  const range = wilsonRange(samples, of);
  return (range.high - range.low) / 2;
};

describe('wilsonRange', () => {
  it('does not turn five agreeing samples into certainty', () => {
    // The textbook interval at 5 of 5 is [1, 1].
    const range = wilsonRange(5, 5);
    expect(range.high).toBe(1);
    expect(range.low).toBeCloseTo(0.566, 3);
  });

  it('contains the share, and narrows as the samples grow', () => {
    for (const [samples, of] of [
      [0, 4],
      [1, 3],
      [2, 3],
      [62, 96],
      [56, 69],
    ] as const) {
      const range = wilsonRange(samples, of);
      expect(range.low).toBeLessThanOrEqual(samples / of);
      expect(range.high).toBeGreaterThanOrEqual(samples / of);
    }
    expect(halfWidth(50, 100)).toBeLessThan(halfWidth(5, 10));
  });

  it('is everything when there were no samples at all', () => {
    expect(wilsonRange(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('puts the usable line at 21 samples, the bar the project chose', () => {
    /*
     * `findings.md`'s "±20 points at five samples" is roughly one standard
     * error of an even split there, its measure of unusable. Taken as a 95%
     * half-width, the stricter reading, an even split is first inside it at
     * 21 independent samples, below the 24 presses that make the replay
     * stable. At five samples the 95% half-width is 33 points.
     */
    expect(halfWidth(2.5, 5)).toBeCloseTo(0.33, 2);
    expect(halfWidth(10, 20)).toBeGreaterThan(USABLE_SHARE_HALF_WIDTH);
    expect(halfWidth(10.5, 21)).toBeLessThanOrEqual(USABLE_SHARE_HALF_WIDTH);
    expect(halfWidth(12, 24)).toBeLessThanOrEqual(USABLE_SHARE_HALF_WIDTH);
    expect(isUsableSampleCount(20)).toBe(false);
    expect(isUsableSampleCount(21)).toBe(true);
    expect(isUsableSampleCount(0)).toBe(false);
  });
});

describe('confidenceLevelOf', () => {
  it('calls a measurement high', () => {
    expect(confidenceLevelOf({ kind: 'measured', gridShare: 0.003 })).toBe('high');
  });

  it('calls a measurement low when the timing grid swamps its whole', () => {
    // Two 0.1ms grid steps over a 1ms whole is the usable half-width exactly.
    expect(confidenceLevelOf(measuredSupport(1))).toBe('high');
    // Under 1ms, the grid alone is more than a fifth of the whole.
    expect(confidenceLevelOf(measuredSupport(0.5))).toBe('low');
    // With no whole at all, the grid is everything.
    expect(measuredSupport(0)).toEqual({ kind: 'measured', gridShare: 1 });
    expect(confidenceLevelOf(measuredSupport(0))).toBe('low');
    expect(
      describeConfidence({
        level: 'low',
        range: weightRangeOf(0, measuredSupport(0)),
        support: measuredSupport(0),
      }),
    ).toContain('the timing grid is 100.0% of the whole');
  });

  it('never calls a sampled share high, and calls a thin one low', () => {
    expect(confidenceLevelOf(sampled(56, 69))).toBe('moderate');
    expect(confidenceLevelOf(sampled(1000, 1000))).toBe('moderate');
    expect(confidenceLevelOf(sampled(5, 5))).toBe('low');
    expect(confidenceLevelOf(sampled(2, 3))).toBe('low');
  });

  it('judges a sampled share by how many samples there were, not where it fell', () => {
    // One of thirteen has a narrow range and is no better founded than nine
    // of thirteen. Scaling by a small slice does not rescue it either.
    expect(confidenceLevelOf(sampled(1, 13))).toBe('low');
    expect(confidenceLevelOf(sampled(9, 13))).toBe('low');
    expect(confidenceLevelOf(sampled(9, 13, 0.05))).toBe('low');
    expect(confidenceLevelOf(sampled(1, 21))).toBe('moderate');
  });

  it('judges a pooled share by the fewer of its pool and its own window', () => {
    /*
     * A frame's slice divided by a pool of 59 samples, of which the slice
     * itself holds 4: which functions ran is an estimate, how this frame
     * split is not.
     */
    const pool: SampledSupport = sampleShareSupport(39, 59);
    expect(confidenceLevelOf(pool)).toBe('moderate');
    const inFrame = scaledSampleSupport(pool, 0.8, 4);
    expect(inFrame).toEqual({
      kind: 'sampled',
      independentSamples: 39,
      ofIndependentSamples: 59,
      ofMeasuredShare: 0.8,
      inOwnWindow: 4,
    });
    expect(confidenceLevelOf(inFrame)).toBe('low');
    expect(confidenceLevelOf(scaledSampleSupport(pool, 0.8, 21))).toBe('moderate');
    // The range is still the pool's.
    expect(weightRangeOf(0.8 * (39 / 59), inFrame)).toEqual(
      weightRangeOf(0.8 * (39 / 59), scaledSampleSupport(pool, 0.8, 59)),
    );
    expect(
      describeConfidence({
        level: confidenceLevelOf(inFrame),
        range: weightRangeOf(0.8 * (39 / 59), inFrame),
        support: inFrame,
      }),
    ).toContain(
      '39.0 of the 59.0 independent samples at this site across the interaction, 4.0 of them in this slice',
    );
  });

  it('calls a subtraction high only when a second signal agrees over enough samples to disagree', () => {
    const level = (check: CrossCheck) =>
      confidenceLevelOf(subtractionSupport(check, 150));

    /*
     * 11 of 12 empty stacks against a frame 90% outside scripts agrees, but
     * twelve samples are fewer than a sampled share needs to be an estimate
     * at all, so the agreement confirms only that the two are not far apart.
     */
    const thin = crossCheckEmptyStacks(0.9, {
      samplesWithoutStack: 11,
      ofSamplesInFrame: 12,
    });
    expect(thin.verdict).toBe('agrees');
    expect(level(thin)).toBe('moderate');
    const usable = crossCheckEmptyStacks(0.9, {
      samplesWithoutStack: 19,
      ofSamplesInFrame: 21,
    });
    expect(usable.verdict).toBe('agrees');
    expect(level(usable)).toBe('high');

    expect(level(crossCheckEmptyStacks(0.9, null))).toBe('moderate');
    expect(level({ verdict: 'unchecked', reason: 'frame-outside-profile' })).toBe(
      'moderate',
    );
    expect(
      level(crossCheckEmptyStacks(0.9, { samplesWithoutStack: 1, ofSamplesInFrame: 12 })),
    ).toBe('low');
  });

  it('orders the levels', () => {
    expect(isLowerConfidence('moderate', 'high')).toBe(true);
    expect(isLowerConfidence('low', 'moderate')).toBe(true);
    expect(isLowerConfidence('high', 'high')).toBe(false);
    expect(isLowerConfidence('high', 'low')).toBe(false);
  });
});

describe('crossCheckEmptyStacks', () => {
  it('agrees when the empty-stack count is what the partition predicts', () => {
    /*
     * The shape of `innerhtml-rebuild`'s unforced frames: 90.3% of the frame
     * outside every script, and 11 of 12 in-frame samples with no stack
     * (development, 4x).
     */
    const check = crossCheckEmptyStacks(0.903, {
      samplesWithoutStack: 11,
      ofSamplesInFrame: 12,
    });
    expect(check.verdict).toBe('agrees');
    expect(describeCrossCheck(check)).toContain('which agrees');
  });

  it('allows for what a handful of samples can and cannot tell apart', () => {
    /*
     * 2 empty stacks of 6 against a frame 14.1% outside scripts
     * (`derive-in-render`, development, 4x): 19 points apart, and 1.15
     * samples from the 0.85 the partition predicts, which is inside two
     * standard deviations.
     */
    const check = crossCheckEmptyStacks(0.141, {
      samplesWithoutStack: 2,
      ofSamplesInFrame: 6,
    });
    expect(check.verdict).toBe('agrees');
  });

  it('disagrees when the profiler saw JavaScript where LoAF reported no script', () => {
    // A frame LoAF calls 90% outside scripts, whose samples nearly all carry
    // a stack: something ran that LoAF did not report, and the subtraction is
    // not to be trusted.
    const check = crossCheckEmptyStacks(0.9, {
      samplesWithoutStack: 1,
      ofSamplesInFrame: 11,
    });
    expect(check.verdict).toBe('disagrees');
    expect(describeCrossCheck(check)).toContain('does not agree');

    // And the other way: a script-dominated frame whose samples are empty.
    expect(
      crossCheckEmptyStacks(0.03, { samplesWithoutStack: 8, ofSamplesInFrame: 10 })
        .verdict,
    ).toBe('disagrees');
  });

  it('declines to compare shares over fewer than five samples, or with no profile', () => {
    expect(MIN_SAMPLES_TO_COMPARE_SHARES).toBe(5);
    expect(
      crossCheckEmptyStacks(0.03, { samplesWithoutStack: 0, ofSamplesInFrame: 4 }),
    ).toEqual({ verdict: 'unchecked', reason: 'too-few-samples', ofSamplesInFrame: 4 });
    const none = crossCheckEmptyStacks(0.9, null);
    expect(none).toEqual({ verdict: 'unchecked', reason: 'no-profiler' });
    expect(describeCrossCheck(none)).toContain('subtraction alone');
    expect(
      describeCrossCheck({ verdict: 'unchecked', reason: 'frame-outside-profile' }),
    ).toContain('outside the span the profiler sampled');
  });
});

describe('weightRangeOf', () => {
  it('is the timing grid either side of a measurement', () => {
    const range = weightRangeOf(0.5, { kind: 'measured', gridShare: 0.002 });
    expect(range.low).toBeCloseTo(0.498, 10);
    expect(range.high).toBeCloseTo(0.502, 10);
    expect(weightRangeOf(1, { kind: 'measured', gridShare: 0.002 }).high).toBe(1);
  });

  it('scales a sampled range by the measured share it divides', () => {
    const whole = weightRangeOf(1, sampled(5, 5));
    const slice = weightRangeOf(0.1, sampled(5, 5, 0.1));
    expect(slice.high).toBeCloseTo(0.1, 10);
    expect(slice.low).toBeCloseTo(whole.low * 0.1, 10);
  });

  it('is the timing grid either side of a subtraction that agrees, and a span for one that does not', () => {
    const agrees = crossCheckEmptyStacks(0.9, {
      samplesWithoutStack: 11,
      ofSamplesInFrame: 12,
    });
    // A point where the whole has no grid.
    expect(weightRangeOf(0.82, subtractionSupport(agrees, null))).toEqual({
      low: 0.82,
      high: 0.82,
    });
    // Two 0.1ms steps over a 100ms frame either side, agreeing or unchecked.
    for (const check of [agrees, crossCheckEmptyStacks(0.9, null)]) {
      const range = weightRangeOf(0.82, subtractionSupport(check, 100));
      expect(range.low).toBeCloseTo(0.818, 10);
      expect(range.high).toBeCloseTo(0.822, 10);
    }

    // One of the two signals is wrong, and nothing says which: the range runs
    // from what the samples imply to what the partition says.
    const disagrees = crossCheckEmptyStacks(0.9, {
      samplesWithoutStack: 1,
      ofSamplesInFrame: 10,
    });
    const range = weightRangeOf(0.9, subtractionSupport(disagrees, 100));
    expect(range.low).toBeCloseTo(0.1, 10);
    expect(range.high).toBe(0.9);
  });
});

describe('describeConfidence', () => {
  it('says the level and what it rests on', () => {
    const support = sampled(5, 5);
    const said = describeConfidence({
      level: confidenceLevelOf(support),
      range: weightRangeOf(1, support),
      support,
    });
    expect(said).toContain('low confidence');
    expect(said).toContain('5.0 of 5.0 independent samples');
    expect(said).toContain('56.6%');
  });
});
