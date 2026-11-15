/**
 * The answer's shape: what the type model refuses to let through.
 *
 * These tests are about the two checked constructors. Both checks exist to
 * catch a specific mistake this project has already reasoned about: a weight
 * derived from a denominator that was zero, or one that disagrees with the
 * counts it claims to be a share of; and a set of causes that together claim
 * more of a frame than the frame contains. The rules that turn a support
 * into a level and a range are `confidence.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION_TIERS,
  type CandidateCause,
  confidenceWeight,
  describeTier,
  describeUnattributedReason,
  rankCauses,
  type UnattributedReason,
} from './attribution.ts';
import type { WeightSupport } from './confidence.ts';

/** A measured support: exact to a grid of one part in a thousand. */
const MEASURED: WeightSupport = { kind: 'measured', gridShare: 0.001 };

/** The support of a share of `samples` independent samples in `of`. */
function sampled(samples: number, of: number, ofMeasuredShare = 1): WeightSupport {
  return {
    kind: 'sampled',
    independentSamples: samples,
    ofIndependentSamples: of,
    ofMeasuredShare,
    inOwnWindow: null,
  };
}

/** A component candidate holding a measured `fraction`. */
function cause(fraction: number, name: string): CandidateCause {
  return {
    subject: { kind: 'component', name, nameIsMinified: false, definedAt: null },
    weight: confidenceWeight(fraction, 'fiber-self-time-share', MEASURED),
    tier: 'react-fiber-timings',
    evidence: [
      {
        kind: 'fiber-render-time',
        componentName: name,
        actualDurationMs: 1,
        selfDurationMs: 1,
      },
    ],
  };
}

/** A component candidate holding `samples` of `of` independent samples. */
function sampledCause(samples: number, of: number, name: string): CandidateCause {
  return {
    ...cause(0, name),
    weight: confidenceWeight(samples / of, 'sample-share', sampled(samples, of)),
    tier: 'profiler-mapped',
  };
}

describe('confidenceWeight', () => {
  it('carries the basis it was computed from, and the confidence its support earns', () => {
    const weight = confidenceWeight(0.73, 'sample-share', sampled(73, 100));
    expect(weight.fraction).toBe(0.73);
    expect(weight.basis).toBe('sample-share');
    // Derived here from the support, never supplied: a level nobody can
    // inspect the reason for cannot be built.
    expect(weight.confidence.level).toBe('moderate');
    expect(weight.confidence.support).toEqual(sampled(73, 100));
    expect(weight.confidence.range.low).toBeLessThan(0.73);
    expect(weight.confidence.range.high).toBeGreaterThan(0.73);
  });

  it('refuses a weight that is not a fraction', () => {
    // Every route to one of these is a division by a denominator that was zero
    // or came from a different frame, and a clamped 1.0 would present that as
    // total confidence.
    expect(() => confidenceWeight(1.4, 'frame-slice-share', MEASURED)).toThrow(
      /outside \[0, 1\]/,
    );
    expect(() => confidenceWeight(-0.1, 'frame-slice-share', MEASURED)).toThrow(
      /outside \[0, 1\]/,
    );
    expect(() => confidenceWeight(Number.NaN, 'window-overlap', MEASURED)).toThrow(
      /not a number/,
    );
    expect(() => confidenceWeight(0 / 0, 'frame-slice-share', MEASURED)).toThrow(
      /not a number/,
    );
  });

  it('refuses a sampled weight that is not the share its counts give', () => {
    // A range computed from 5 of 13 beside a fraction of 13 of 13 would
    // describe two different estimates under one name.
    expect(() => confidenceWeight(1, 'sample-share', sampled(5, 13))).toThrow(
      /not the share its sample counts give/,
    );
    // Scaled by the measured share it divides, the counts still have to agree.
    expect(
      confidenceWeight(0.1, 'frame-slice-sample-share', sampled(5, 10, 0.2)).fraction,
    ).toBe(0.1);
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
    expect(ranked.lead).toBe('sole');
  });

  it('says whether the first candidate is distinguishable from the second', () => {
    /*
     * The same two-to-one split, at two sample counts. Over 69 samples the
     * ranges are far apart and the order is an answer. Over 3 they overlap,
     * and the order is a guess: in the corpus that is `derive-in-render`'s
     * production long frames, where the candidate in front is not the
     * declared culprit (4x).
     */
    expect(
      rankCauses([sampledCause(46, 69, 'comparator'), sampledCause(23, 69, 'body')]).lead,
    ).toBe('clear');
    expect(
      rankCauses([sampledCause(2, 3, 'body'), sampledCause(1, 3, 'comparator')]).lead,
    ).toBe('within-noise');

    // Two measurements closer together than the timing grid are not ordered
    // either: `spans`' components each burn the same 25ms.
    expect(rankCauses([cause(0.1667, 'A'), cause(0.166, 'B')]).lead).toBe('within-noise');
    expect(rankCauses([cause(0.6, 'A'), cause(0.2, 'B')]).lead).toBe('clear');
    expect(rankCauses([]).lead).toBe('none');
  });
});

describe('unattributed reasons', () => {
  it('describes every reason, so a remainder can always say why it has no cause', () => {
    const reasons: readonly UnattributedReason[] = [
      'no-javascript-on-stack',
      'before-first-reported-script',
      'between-reported-scripts',
      'outside-script-and-rendering-update',
      'rendering-update-before-style-and-layout',
      'after-last-reported-script',
      'no-profiler',
      'bailed-out-reconciliation',
      'no-rendered-component-on-stack',
      'no-located-frame',
    ];
    for (const reason of reasons) {
      expect(describeUnattributedReason(reason).length).toBeGreaterThan(10);
    }
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
