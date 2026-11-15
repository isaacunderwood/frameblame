/**
 * One frame as ranked causes, against frames, commits and profiles built by
 * hand.
 *
 * `packages/corpus` asserts the answers on the real captures. These are the
 * rules underneath, each on the smallest input that shows it: that the
 * weights are the partition and sum to 1, how a script slice is named by the
 * strongest signal available, and what the unattributed share's cross-check
 * does when the second signal agrees, is missing, or contradicts the first.
 * Figures quoted in comments are from the corpus, with their build mode and
 * throttle rate; the durations in the builders are not measurements.
 */

import { describe, expect, it } from 'vitest';

import type { CandidateCause } from './attribution.ts';
import { attributeCommit, type CommitAttribution } from './component-attribution.ts';
import { attributeFrames, describeFrameNote } from './frame-attribution.ts';
import type { ProfileTrace } from './profiler.ts';
import type { CapturedSignals } from './signals.ts';
import { resolveProfile } from './source-map.ts';
import {
  BAILED_OUT,
  capture,
  commit,
  fiber,
  paintedFrame,
  script,
} from './synthetic-capture.test-support.ts';
import {
  PROVENANCE,
  type SampleSpec,
  served,
  trace,
} from './synthetic-profile.test-support.ts';

const APP_JS = [served('http://localhost/app.js')];

/** The frames of a capture, attributed, with every commit in it placed. */
function attributed(signals: CapturedSignals) {
  const resolved = signals.profile === null ? null : resolveProfile(signals.profile);
  const commits: CommitAttribution[] = signals.react.commits.map((each) =>
    attributeCommit(signals, each, 0),
  );
  return attributeFrames(signals, resolved, commits);
}

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one, got ${String(items.length)}`);
  }
  return first;
}

/** A candidate by its subject's kind, where the frame has exactly one of that kind. */
function ofKind(
  causes: readonly CandidateCause[],
  kind: CandidateCause['subject']['kind'],
): CandidateCause {
  return only(causes.filter((cause) => cause.subject.kind === kind));
}

describe('a frame whose time went to browser work nothing can name', () => {
  /*
   * The shape of `innerhtml-rebuild`'s unforced frames: a listener of about
   * 15ms, then 110-131ms before the rendering update in which no script ran
   * (4x, both build modes). Here: 1ms of input delay, a 15ms listener, 130ms
   * of nothing LoAF can name, and 4ms of paint.
   */
  const frame = paintedFrame(
    1000,
    150,
    [script({ startTimeMs: 1001, durationMs: 15 })],
    146,
  );

  /** One sample in the listener, then eleven across the gap. */
  function samples(gap: SampleSpec['stack']): SampleSpec[] {
    return [
      { atMs: 1004, stack: [[0, 'rebuildRows', 10]] },
      ...Array.from({ length: 11 }, (_, index) => ({
        atMs: 1018 + 12 * index,
        stack: gap,
      })),
    ];
  }

  function attributedWith(profile: ProfileTrace | null) {
    return only(attributed(capture({ frames: [frame], profile })));
  }

  it('reports the gap as unattributed, first, and does not share it out among the scripts', () => {
    const answer = attributedWith(trace(APP_JS, samples(null)));
    const [top] = answer.causes.causes;

    expect(top?.subject).toEqual({
      kind: 'unattributed',
      reason: 'outside-script-and-rendering-update',
    });
    expect(top?.tier).toBe('unattributed');
    expect(top?.weight.fraction).toBeCloseTo(130 / 150, 10);
    expect(answer.unattributed.ms).toBeCloseTo(131, 10);
    expect(answer.unattributed.fraction).toBeCloseTo(131 / 150, 10);

    // The listener holds its own 15ms and nothing more.
    const listener = ofKind(answer.causes.causes, 'source-location');
    expect(listener.weight.fraction).toBeCloseTo(15 / 150, 10);
    expect(listener.weight.basis).toBe('frame-slice-sample-share');

    // Every millisecond is charged exactly once.
    expect(answer.causes.totalWeight).toBeCloseTo(1, 10);
    expect(answer.denominator).toBe('frame-duration');
  });

  it('is at moderate confidence when the profiler agrees on too few samples to have disagreed', () => {
    /*
     * 11 of 12 stackless agrees with a frame 90% outside scripts, but twelve
     * samples are fewer than a sampled share needs to be an estimate at all,
     * so agreement confirms only that the two signals are not far apart. The
     * corpus's agreeing frames hold 5 to 14 independent samples (4x, both
     * build modes).
     */
    const answer = attributedWith(trace(APP_JS, samples(null)));
    const [top] = answer.causes.causes;

    expect(answer.unattributed.check).toMatchObject({
      verdict: 'agrees',
      samplesWithoutStack: 11,
      ofSamplesInFrame: 12,
    });
    expect(top?.weight.confidence.level).toBe('moderate');
    expect(top?.weight.confidence.support).toEqual({
      kind: 'subtraction',
      check: answer.unattributed.check,
      gridShare: 0.2 / 150,
    });
    // Exact to the timing grid either side, since the slices were coarsened.
    expect(top?.weight.confidence.range.low).toBeCloseTo(130 / 150 - 0.2 / 150, 10);
    expect(top?.weight.confidence.range.high).toBeCloseTo(130 / 150 + 0.2 / 150, 10);
    // Both signals are on the evidence: the slice, and the empty stacks.
    expect(top?.evidence).toEqual([
      { kind: 'frame-slice', slice: 'script-to-render', durationMs: 130 },
      { kind: 'empty-stack-share', samplesWithoutStack: 11, ofSamplesInFrame: 12 },
    ]);
  });

  it('is at high confidence when the profiler agrees over enough samples to have disagreed', () => {
    // 21 stackless samples 6ms apart across the gap, and one in the listener.
    const answer = attributedWith(
      trace(APP_JS, [
        { atMs: 1004, stack: [[0, 'rebuildRows', 10]] },
        ...Array.from({ length: 21 }, (_, index) => ({
          atMs: 1018 + 6 * index,
          stack: null,
        })),
      ]),
    );
    const [top] = answer.causes.causes;

    expect(answer.unattributed.check).toMatchObject({
      verdict: 'agrees',
      samplesWithoutStack: 21,
      ofSamplesInFrame: 22,
    });
    expect(top?.subject).toMatchObject({ kind: 'unattributed' });
    expect(top?.weight.confidence.level).toBe('high');
  });

  it('is at moderate confidence on subtraction alone, and names the entry instead of a function', () => {
    const answer = attributedWith(null);
    const [top] = answer.causes.causes;

    // Still unattributed, still first, still 87% of the frame.
    expect(top?.subject).toMatchObject({ kind: 'unattributed' });
    expect(top?.weight.fraction).toBeCloseTo(130 / 150, 10);
    expect(answer.unattributed.check).toEqual({
      verdict: 'unchecked',
      reason: 'no-profiler',
    });
    expect(top?.weight.confidence.level).toBe('moderate');
    expect(top?.evidence.map((evidence) => evidence.kind)).toEqual(['frame-slice']);

    // With no stacks, the script is whatever LoAF named: the line that
    // registered the listener, at the tier that says so.
    const entry = ofKind(answer.causes.causes, 'script-entry');
    expect(entry.tier).toBe('loaf-script-registration');
    expect(entry.subject).toMatchObject({
      scope: 'whole-entry',
      site: { sourceUrl: 'http://localhost/app.js', sourceCharPosition: 100 },
    });
    expect(entry.weight.fraction).toBeCloseTo(15 / 150, 10);
    expect(entry.weight.confidence.level).toBe('high');
  });

  it('is at low confidence when the profiler saw JavaScript where LoAF reported none', () => {
    // The gap's samples all carry a stack: something ran that LoAF did not
    // report, so "nothing was attributable" is contradicted.
    const answer = attributedWith(trace(APP_JS, samples([[0, 'unreported', 90]])));
    const top = only(
      answer.causes.causes.filter(
        (cause) =>
          cause.subject.kind === 'unattributed' &&
          cause.subject.reason === 'outside-script-and-rendering-update',
      ),
    );

    expect(answer.unattributed.check.verdict).toBe('disagrees');
    expect(top.weight.confidence.level).toBe('low');
    // The share is no longer a point: it runs down to what the samples imply.
    expect(top.weight.confidence.range.high).toBeCloseTo(130 / 150, 10);
    expect(top.weight.confidence.range.low).toBe(0);
  });

  it('does not compare shares over fewer than five in-frame samples', () => {
    const answer = attributedWith(
      trace(APP_JS, [
        { atMs: 1004, stack: [[0, 'rebuildRows', 10]] },
        { atMs: 1050, stack: null },
        { atMs: 1100, stack: null },
      ]),
    );
    expect(answer.unattributed.check).toEqual({
      verdict: 'unchecked',
      reason: 'too-few-samples',
      ofSamplesInFrame: 3,
    });
  });

  it('says a frame the profiler was not looking at is outside the profile, not short of samples', () => {
    /*
     * The shape of `derive-in-render`'s production page-load frame,
     * 48.9-181.5ms against a first sample at 201.1ms, and of frames that end
     * after the last sample (4x): LoAF reports them, and the profiler cannot
     * have seen them.
     */
    const answer = attributedWith(
      trace(APP_JS, [
        { atMs: 1200, stack: null },
        { atMs: 1215, stack: null },
      ]),
    );
    expect(answer.unattributed.check).toEqual({
      verdict: 'unchecked',
      reason: 'frame-outside-profile',
    });
    const note = only(answer.notes);
    expect(note).toEqual({
      kind: 'frame-outside-profile',
      firstSampleAtMs: 1200,
      lastSampleAtMs: 1215,
    });
    expect(describeFrameNote(note, PROVENANCE)).toContain(
      'outside the span the profiler',
    );
    const [top] = answer.causes.causes;
    expect(top?.weight.confidence.level).toBe('moderate');

    // A sample just inside the tolerance `isWithinFrame` allows is in the frame.
    const edge = attributedWith(trace(APP_JS, [{ atMs: 1150.1, stack: null }]));
    expect(edge.unattributed.check).toMatchObject({ reason: 'too-few-samples' });
  });

  it('counts a burst of in-frame samples once', () => {
    /*
     * `vendor-listener`'s first frame holds 35 samples where its neighbours
     * hold 10 to 12, because two bursts landed in it (development, 4x). Here
     * nine stacked samples inside 1ms would outvote eleven empty ones if they
     * were counted raw.
     */
    const burst: SampleSpec[] = Array.from({ length: 9 }, (_, index) => ({
      atMs: 1004 + index * 0.1,
      stack: [[0, 'rebuildRows', 10]],
    }));
    const answer = attributedWith(trace(APP_JS, [...burst, ...samples(null).slice(1)]));

    expect(answer.unattributed.check).toMatchObject({ verdict: 'agrees' });
    if (answer.unattributed.check.verdict !== 'agrees') return;
    expect(answer.unattributed.check.ofSamplesInFrame).toBeCloseTo(12, 10);
    expect(answer.unattributed.check.samplesWithoutStack).toBe(11);
    // The raw counts are still what the evidence reports.
    const [top] = answer.causes.causes;
    expect(top?.evidence.at(-1)).toEqual({
      kind: 'empty-stack-share',
      samplesWithoutStack: 11,
      ofSamplesInFrame: 20,
    });
  });
});

describe('forced style and layout', () => {
  it('is charged to the script that forced it, inside that script, never beside it', () => {
    /*
     * `innerhtml-rebuild`'s forced frames: 94.9-103.8ms of forced work nested
     * in a 108.8-117.7ms script entry (4x, both build modes). Added as a
     * sibling slice it would put the frame past 100%.
     */
    const forcing = script({
      startTimeMs: 1000,
      durationMs: 110,
      forcedStyleAndLayoutDurationMs: 95,
      sourceCharPosition: 207,
    });
    const answer = only(
      attributed(capture({ frames: [paintedFrame(1000, 130, [forcing], 130)] })),
    );

    const forced = ofKind(answer.causes.causes, 'browser-work');
    expect(forced.subject).toMatchObject({
      what: 'forced-style-and-layout',
      forcedBy: { sourceUrl: 'http://localhost/app.js', sourceCharPosition: 207 },
    });
    expect(forced.weight.fraction).toBeCloseTo(95 / 130, 10);
    expect(forced.weight.confidence.level).toBe('high');
    expect(forced.tier).toBe('loaf-script-registration');

    const entry = ofKind(answer.causes.causes, 'script-entry');
    expect(entry.weight.fraction).toBeCloseTo(15 / 130, 10);
    expect(answer.causes.totalWeight).toBeCloseTo(1, 10);
    expect(answer.causes.causes[0]).toBe(forced);
  });
});

describe('a script slice with a React commit inside it', () => {
  const dispatch = script({
    startTimeMs: 1002,
    durationMs: 56,
    sourceFunctionName: 'dispatchDiscreteEvent',
    sourceUrl: 'http://localhost/react-dom.js',
  });
  const frame = paintedFrame(1000, 60, [dispatch], 59);

  it('gives each rendered component its measured self time, and the entry the rest', () => {
    /*
     * `derive-in-render`'s shape in development: one dispatcher entry of
     * 56.1-61.8ms holding a commit of 49.2-57.8ms (4x).
     */
    const signals = capture({
      frames: [frame],
      react: {
        hookInstalled: true,
        spans: [],
        commits: [
          commit([fiber(0, 'App', null, 46), fiber(1, 'OrderTable', 0, 45)], 1056),
        ],
      },
    });
    const answer = only(attributed(signals));
    const [top] = answer.causes.causes;

    expect(top?.subject).toMatchObject({ kind: 'component', name: 'OrderTable' });
    expect(top?.tier).toBe('react-fiber-timings');
    expect(top?.weight.fraction).toBeCloseTo(45 / 60, 10);
    expect(top?.weight.basis).toBe('fiber-self-time-share');
    expect(top?.weight.confidence.level).toBe('high');
    expect(top?.weight.confidence.support.kind).toBe('measured');
    // The evidence names the fiber timing and the script entry it sat in.
    expect(top?.evidence.map((evidence) => evidence.kind)).toEqual([
      'fiber-render-time',
      'loaf-script',
    ]);

    // What is left of the entry is React's own work and the handler: charged
    // to the entry, and said to be the remainder.
    const rest = ofKind(answer.causes.causes, 'script-entry');
    expect(rest.subject).toMatchObject({
      scope: 'outside-component-renders',
      site: { sourceFunctionName: 'dispatchDiscreteEvent' },
    });
    expect(rest.weight.fraction).toBeCloseTo((56 - 46) / 60, 10);
    expect(answer.causes.totalWeight).toBeCloseTo(1, 10);
    expect(answer.commits).toHaveLength(1);
    expect(answer.notes).toEqual([]);
  });

  it('does not charge components whose render cannot have fitted inside the script', () => {
    // 80ms of render committing 54ms into a 56ms script: most of it ran
    // somewhere else, so placing it in this frame would be a guess.
    const signals = capture({
      frames: [frame],
      react: {
        hookInstalled: true,
        spans: [],
        commits: [commit([fiber(0, 'Sliced', null, 80)], 1056)],
      },
    });
    const answer = only(attributed(signals));

    expect(answer.causes.causes.some((cause) => cause.subject.kind === 'component')).toBe(
      false,
    );
    expect(ofKind(answer.causes.causes, 'script-entry').subject).toMatchObject({
      scope: 'whole-entry',
    });
    /*
     * Both conditions fail, and each is said apart: the render cannot have
     * begun after the script did, by 26ms, and it is 24ms longer than the
     * script's 56ms of JavaScript.
     */
    const [start, sum, ...more] = answer.notes;
    expect(more).toEqual([]);
    expect(start).toEqual({
      kind: 'commit-render-does-not-fit-script',
      scriptIndex: 0,
      committedAtMs: 1056,
      byMs: 26,
    });
    expect(sum).toEqual({
      kind: 'commit-renders-exceed-script',
      scriptIndex: 0,
      renderMs: 80,
      javaScriptMs: 56,
      byMs: 24,
    });
    if (start === undefined || sum === undefined) return;
    expect(describeFrameNote(start, PROVENANCE)).toContain(
      '26.0ms (production, 4x CPU throttle',
    );
    expect(describeFrameNote(sum, PROVENANCE)).toContain('80.0ms (production, 4x');
    // The commit is still reported beside the frame.
    expect(answer.commits).toHaveLength(1);
  });

  it('notes renders that each fit but together outrun the script, by the shortfall alone', () => {
    // Two 30ms renders, each beginning after the script did, in 56ms of it.
    const signals = capture({
      frames: [frame],
      react: {
        hookInstalled: true,
        spans: [],
        commits: [
          commit([fiber(0, 'First', null, 30)], 1040),
          commit([fiber(0, 'Second', null, 30)], 1056),
        ],
      },
    });
    const answer = only(attributed(signals));

    expect(answer.notes).toEqual([
      {
        kind: 'commit-renders-exceed-script',
        scriptIndex: 0,
        renderMs: 60,
        javaScriptMs: 56,
        byMs: 4,
      },
    ]);
    expect(answer.causes.causes.some((cause) => cause.subject.kind === 'component')).toBe(
      false,
    );
  });

  it('notes a commit that landed in a script with no JavaScript of its own', () => {
    // All 56ms of the script is forced style and layout.
    const forcing = script({
      startTimeMs: 1002,
      durationMs: 56,
      forcedStyleAndLayoutDurationMs: 56,
    });
    const signals = capture({
      frames: [paintedFrame(1000, 60, [forcing], 59)],
      react: {
        hookInstalled: true,
        spans: [],
        commits: [commit([fiber(0, 'App', null, 10)], 1056)],
      },
    });
    const answer = only(attributed(signals));
    const note = only(answer.notes);

    expect(note).toEqual({
      kind: 'commit-in-script-without-javascript',
      scriptIndex: 0,
      committedAtMs: 1056,
    });
    expect(describeFrameNote(note, PROVENANCE)).toContain('ran no JavaScript of its own');
    expect(answer.causes.causes.some((cause) => cause.subject.kind === 'component')).toBe(
      false,
    );
    expect(answer.commits).toHaveLength(1);
  });

  it('names an untimed commit’s components as evidence of overlap, without a share', () => {
    /*
     * A production build with no profile: the hook says `h` rendered in a
     * commit that landed inside this script, and nothing measured it. The
     * entry keeps all of its time, and `h` is named on its evidence.
     */
    const signals = capture({
      frames: [frame],
      react: {
        hookInstalled: true,
        spans: [],
        commits: [
          commit([fiber(0, 're', null, null, BAILED_OUT), fiber(1, 'h', 0, null)], 1056),
        ],
      },
    });
    const answer = only(attributed(signals));
    const entry = ofKind(answer.causes.causes, 'script-entry');

    expect(entry.tier).toBe('loaf-script-registration');
    expect(entry.weight.fraction).toBeCloseTo(56 / 60, 10);
    expect(entry.evidence).toEqual([
      {
        kind: 'loaf-script',
        scriptIndex: 0,
        durationMs: 56,
        resolvedFromCharPosition: false,
      },
      { kind: 'fiber-rendered', componentName: 'h', participation: 'updated' },
    ]);
    expect(answer.causes.causes.some((cause) => cause.subject.kind === 'component')).toBe(
      false,
    );
  });
});

describe('sampled functions in a script slice', () => {
  const listener = (startTimeMs: number) =>
    script({ startTimeMs, durationMs: 12, sourceCharPosition: 192 });
  const frames = [
    paintedFrame(100, 60, [listener(100)], 60),
    paintedFrame(300, 60, [listener(300)], 60),
    paintedFrame(500, 60, [listener(500)], 60),
  ];
  const profile = trace(
    [served('http://localhost/app.js'), served('http://localhost/vendor.js')],
    [
      { atMs: 105, stack: [[1, 'vendorTrack', 43]] },
      { atMs: 306, stack: [[1, 'vendorTrack', 43]] },
      { atMs: 504, stack: [[0, 'somethingElse', 77]] },
    ],
  );

  it('pools the samples of one registration site across an interaction’s frames', () => {
    /*
     * `vendor-listener`'s vendor slices last 12.0-12.4ms, and the sampler's
     * median cadence was 14.2-14.7ms per capture in the v0.3 re-capture and
     * 12.2ms in the one before (4x, both build modes), so one frame holds
     * about one sample and cannot say what ran in it. The two frames of the
     * replayed interaction can, a little: each frame's candidate rests on
     * both samples, and on the one in its own slice.
     */
    const signals = capture({
      frames,
      profile,
      interactions: [
        { label: 'replay', kind: 'click', fromMs: 0, toMs: 400, actions: [] },
        { label: 'other', kind: 'click', fromMs: 401, toMs: 700, actions: [] },
      ],
    });
    const [first, second, third] = attributed(signals);

    for (const answer of [first, second]) {
      expect(answer?.interaction).toBe('replay');
      const vendor = ofKind(answer?.causes.causes ?? [], 'source-location');
      expect(vendor.subject).toMatchObject({
        scriptUrl: 'http://localhost/vendor.js',
        functionName: { text: 'vendorTrack' },
      });
      expect(vendor.tier).toBe('profiler-unmapped');
      // The slice's measured 12 of 60ms, all of it by the pool's samples.
      expect(vendor.weight.fraction).toBeCloseTo(12 / 60, 10);
      expect(vendor.weight.confidence.support).toEqual({
        kind: 'sampled',
        independentSamples: 2,
        ofIndependentSamples: 2,
        ofMeasuredShare: 12 / 60,
        inOwnWindow: 1,
      });
      // Two samples is a guess, and the weight says so.
      expect(vendor.weight.confidence.level).toBe('low');
    }

    // The same site in another interaction is another pool: React registers
    // one listener for every event, so a capture-wide pool would mix them.
    expect(third?.interaction).toBe('other');
    expect(ofKind(third?.causes.causes ?? [], 'source-location').subject).toMatchObject({
      functionName: { text: 'somethingElse' },
    });
  });
});
