/**
 * Which profiler samples are independent of each other.
 *
 * The one rule in `profiler.ts` with arithmetic in it. Timestamps here are
 * made up; the figures in comments are from the corpus, with their build mode
 * and throttle rate.
 */

import { describe, expect, it } from 'vitest';

import { independentSampleWeights, SAMPLE_BURST_GAP_MS } from './profiler.ts';
import { served, trace } from './synthetic-profile.test-support.ts';

function weightsAt(timestamps: readonly number[]): readonly number[] {
  return independentSampleWeights(
    trace(
      [served('http://localhost/app.js')],
      timestamps.map((atMs) => ({ atMs, stack: null })),
    ),
  );
}

describe('independentSampleWeights', () => {
  it('counts samples at the sampler’s own cadence as one each', () => {
    // 16,376 of the corpus's 16,451 inter-sample gaps are 9ms or longer (4x,
    // both build modes).
    expect(weightsAt([100, 109, 121.5, 136])).toEqual([1, 1, 1, 1]);
  });

  it('counts a burst once, shared equally among its samples', () => {
    /*
     * `vendor-listener`'s first click: nine samples in 165.8-166.9ms
     * (development, 4x). One look at the stack, taken nine times.
     */
    const burst = [165.8, 165.9, 166.0, 166.1, 166.3, 166.5, 166.6, 166.8, 166.9];
    const weights = weightsAt([150, ...burst, 180]);

    expect(weights[0]).toBe(1);
    expect(weights.at(-1)).toBe(1);
    for (const weight of weights.slice(1, -1)) expect(weight).toBe(1 / 9);
    // Eleven samples, three independent ones.
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(3, 10);
  });

  it('chains a burst through gaps that are each under half the sampling floor', () => {
    expect(SAMPLE_BURST_GAP_MS).toBe(5);
    // 4ms apart twice: one burst of three, though its ends are 8ms apart.
    expect(weightsAt([100, 104, 108])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    // A gap of exactly 5ms is not a burst.
    expect(weightsAt([100, 105])).toEqual([1, 1]);
  });

  it('treats samples sharing a timestamp as one', () => {
    // 32 pairs of corpus samples share a timestamp exactly (4x, both build modes).
    expect(weightsAt([100, 100])).toEqual([0.5, 0.5]);
  });

  it('returns nothing for an empty trace', () => {
    expect(weightsAt([])).toEqual([]);
  });
});
