/**
 * The answer's shape: what the type model refuses to let through.
 *
 * There is no heuristic here yet, so these tests are about the two checked
 * constructors and nothing else. They are worth having now because both checks
 * exist to catch a specific mistake this project has already reasoned about: a
 * weight derived from a denominator that was zero, and a set of causes that
 * together claim more of a frame than the frame contains.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_TIERS,
  type CandidateCause,
  confidenceWeight,
  describeTier,
  rankCauses,
} from './attribution.ts';

function cause(fraction: number, name: string): CandidateCause {
  return {
    subject: { kind: 'component', name, nameIsMinified: false, definedAt: null },
    weight: confidenceWeight(fraction, 'sample-share'),
    tier: 'react-fiber-timings',
    evidence: [
      { kind: 'profiler-samples', samples: 1, ofSamplesInWindow: 1, window: 'frame' },
    ],
  };
}

describe('confidenceWeight', () => {
  it('carries the basis it was computed from', () => {
    expect(confidenceWeight(0.73, 'sample-share')).toEqual({
      fraction: 0.73,
      basis: 'sample-share',
    });
  });

  it('refuses a weight that is not a fraction', () => {
    // Every route to one of these is a division by a denominator that was zero
    // or came from a different frame, and a clamped 1.0 would present that as
    // total confidence.
    expect(() => confidenceWeight(1.4, 'sample-share')).toThrow(/outside \[0, 1\]/);
    expect(() => confidenceWeight(-0.1, 'frame-slice-share')).toThrow(/outside \[0, 1\]/);
    expect(() => confidenceWeight(Number.NaN, 'window-overlap')).toThrow(/not a number/);
    expect(() => confidenceWeight(0 / 0, 'sample-share')).toThrow(/not a number/);
  });
});

describe('rankCauses', () => {
  it('orders by weight and reports how much of the frame is accounted for', () => {
    const ranked = rankCauses([cause(0.19, 'useCartTotals'), cause(0.68, 'OrderTable')]);

    expect(ranked.causes.map((candidate) => candidate.weight.fraction)).toEqual([
      0.68, 0.19,
    ]);
    // 13% of this frame is accounted for by nothing, which is the number the
    // unattributed tier exists to keep visible.
    expect(ranked.totalWeight).toBeCloseTo(0.87, 10);
  });

  it('leaves ties in the order they arrived', () => {
    /*
     * A 64ms frame yields four to seven samples at Chrome's 10ms sampling
     * floor (a 12.2ms median cadence in one corpus capture, 14.5ms in the
     * next, 4x, both build modes), so the second and third candidates are routinely tied. Inventing
     * an order between them would present sampling noise as a ranking.
     */
    const ranked = rankCauses([cause(0.25, 'first'), cause(0.25, 'second')]);
    const names = ranked.causes.map((candidate) =>
      candidate.subject.kind === 'component' ? candidate.subject.name : '',
    );

    expect(names).toEqual(['first', 'second']);
  });

  it('refuses a ranking that claims more than the whole frame', () => {
    // The shape of a double count: the same milliseconds charged to a component
    // and to the script that rendered it.
    expect(() => rankCauses([cause(0.8, 'OrderTable'), cause(0.6, 'App')])).toThrow(
      /more than all of it/,
    );
  });

  it('holds all the weight on one candidate in the degenerate case', () => {
    // "A single obvious cause is the degenerate case where one candidate holds
    // all the weight" — an invariant, and it has to be expressible.
    const ranked = rankCauses([cause(1, 'OrderTable')]);
    expect(ranked.causes).toHaveLength(1);
    expect(ranked.totalWeight).toBe(1);
  });
});

describe('tiers', () => {
  it('describes every tier, so a claim can always name what it came from', () => {
    for (const tier of ATTRIBUTION_TIERS) {
      expect(describeTier(tier).length).toBeGreaterThan(10);
    }
  });

  it('ranks the React fiber tier above React spans', () => {
    /*
     * The ordering is a finding, not a preference. React emits a span only for
     * a component whose props changed by identity, so the spans are blind to
     * the `setState` owner, to context consumers and to every first mount —
     * which is why promoting them to the primary signal was the most
     * consequential error the v0.1 spike made, and why this assertion exists to
     * fail if anyone reorders the list back.
     */
    expect(ATTRIBUTION_TIERS.indexOf('react-fiber-timings')).toBeLessThan(
      ATTRIBUTION_TIERS.indexOf('react-component-span'),
    );
    expect(ATTRIBUTION_TIERS.indexOf('profiler-mapped')).toBeLessThan(
      ATTRIBUTION_TIERS.indexOf('profiler-unmapped'),
    );
    expect(ATTRIBUTION_TIERS.at(-1)).toBe('unattributed');
  });
});
