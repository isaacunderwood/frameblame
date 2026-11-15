/**
 * The frame arithmetic, against frames built by hand.
 *
 * These are the cases the captured corpus cannot provide: a frame with no
 * scripts, a frame whose reported figures contradict its own boundaries, a
 * rendering update that overflows. `packages/corpus` asserts the same
 * arithmetic against all 56 real frames, which is the part that says the model
 * fits the browser; this is the part that says it survives inputs the browser
 * has not happened to produce yet.
 *
 * Every figure quoted in a comment here is from the corpus and carries the
 * build mode and throttle rate it was measured under, because a millisecond
 * figure without them is indefensible even in a test.
 */

import { describe, expect, it } from 'vitest';

import {
  chargesOfSlice,
  decomposeFrame,
  denominatorMs,
  shareOfFrame,
} from './frame-decomposition.ts';
import {
  COARSENED_TIMING_TOLERANCE_MS,
  type FrameScript,
  type LongAnimationFrame,
} from './loaf.ts';

/** A script entry with nothing interesting in it, for overriding field by field. */
function script(overrides: Partial<FrameScript>): FrameScript {
  return {
    startTimeMs: 0,
    durationMs: 10,
    executionStartMs: 0,
    invoker: 'BUTTON.onclick',
    invokerType: 'event-listener',
    sourceUrl: 'http://localhost/app.js',
    sourceFunctionName: null,
    sourceCharPosition: 0,
    sourceLine: null,
    sourceColumn: null,
    pauseDurationMs: 0,
    forcedStyleAndLayoutDurationMs: 0,
    forcedStyleDurationMs: null,
    forcedLayoutDurationMs: null,
    windowAttribution: 'self',
    ...overrides,
  };
}

/** A painted frame, with the rendering update collapsed to a point unless overridden. */
function frame(overrides: Partial<LongAnimationFrame>): LongAnimationFrame {
  const base: LongAnimationFrame = {
    startTimeMs: 100,
    durationMs: 60,
    blockingDurationMs: 10,
    firstUIEventTimestampMs: 100,
    renderingUpdate: {
      kind: 'rendered',
      renderStartMs: 160,
      styleAndLayoutStartMs: 160,
      styleDurationMs: 0,
      layoutDurationMs: 0,
      paintTimeMs: 160,
      presentationTimeMs: 190,
    },
    scripts: [],
    navigationId: 1,
  };
  return { ...base, ...overrides };
}

function totalSliced(decomposition: ReturnType<typeof decomposeFrame>): number {
  return decomposition.slices.reduce((sum, slice) => sum + slice.durationMs, 0);
}

describe('the partition', () => {
  it('accounts for every millisecond of a frame with one script', () => {
    const decomposition = decomposeFrame(
      frame({ scripts: [script({ startTimeMs: 102, durationMs: 55 })] }),
    );

    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
    expect(decomposition.unaccountedMs).toBeCloseTo(0, 10);
    expect(decomposition.notes).toEqual([]);
    expect(decomposition.slices.map((slice) => slice.kind)).toEqual([
      'before-first-script',
      'script',
      'script-to-render',
    ]);
  });

  it('accounts for a frame that reported no script at all', () => {
    /*
     * Not in the corpus: every one of its 56 frames carries at least one script
     * entry. It is reachable — a frame whose work was all browser-side, or all
     * in tasks under LoAF's 5ms attribution threshold — and the whole frame is
     * then unattributed, which is the honest answer rather than a failure.
     */
    const decomposition = decomposeFrame(frame({ scripts: [] }));

    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
    expect(decomposition.charges.javaScriptMs).toBe(0);
    expect(decomposition.charges.unattributedMs).toBeCloseTo(60, 10);
    expect(decomposition.slices.map((slice) => slice.kind)).toEqual(['script-to-render']);
  });

  it('accounts for a frame that never painted', () => {
    /*
     * Two of the corpus's 56 frames are like this: a bare `Promise.resolve`
     * task that ran for the whole frame, with `renderStart` and
     * `styleAndLayoutStart` reporting the spec's 0 sentinel and no `paintTime`
     * or `presentationTime` at all. Measured at 66.1ms and 106.9ms
     * (development and production respectively, 4x CPU throttle).
     */
    const decomposition = decomposeFrame(
      frame({
        renderingUpdate: { kind: 'none' },
        scripts: [script({ startTimeMs: 100, durationMs: 60 })],
      }),
    );

    expect(decomposition.frameEndMs).toBe(160);
    expect(decomposition.unaccountedMs).toBeCloseTo(0, 10);
    expect(decomposition.slices.map((slice) => slice.kind)).toEqual(['script']);
    expect(denominatorMs(decomposition.frame, 'start-to-presentation')).toBeNull();
  });

  it('emits one slice per script and charges the gaps between them', () => {
    /*
     * The `vendor-listener` shape: three sibling listeners on one click, which
     * LoAF reports as three script entries in one frame (development and
     * production, 4x). The engine must come out with three script slices, not
     * one merged blob, because the middle one is a third party's.
     */
    const decomposition = decomposeFrame(
      frame({
        scripts: [
          script({ startTimeMs: 102, durationMs: 18 }),
          script({ startTimeMs: 121, durationMs: 13 }),
          script({ startTimeMs: 135, durationMs: 22 }),
        ],
      }),
    );

    const scripts = decomposition.slices.filter((slice) => slice.kind === 'script');
    expect(scripts).toHaveLength(3);
    expect(
      decomposition.slices.filter((slice) => slice.kind === 'between-scripts'),
    ).toHaveLength(2);
    expect(decomposition.unaccountedMs).toBeCloseTo(0, 10);
  });
});

describe('forced style and layout', () => {
  it('is charged to the script that forced it, inside the script, not beside it', () => {
    /*
     * Measured on `innerhtml-rebuild`'s forced scenario (development, 4x): a
     * 120.4ms script entry containing 105.5ms of forced style and layout, in a
     * 140.3ms frame. Adding the forced figure as a sibling slice would make the
     * frame 245.8ms long, which is the first mistake `findings.md` warns about.
     */
    const decomposition = decomposeFrame(
      frame({
        durationMs: 140.3,
        scripts: [
          script({
            startTimeMs: 100.7,
            durationMs: 120.4,
            forcedStyleAndLayoutDurationMs: 105.5,
            forcedStyleDurationMs: 25.8,
            forcedLayoutDurationMs: 79.8,
          }),
        ],
        renderingUpdate: {
          kind: 'rendered',
          renderStartMs: 240.3,
          styleAndLayoutStartMs: 240.3,
          styleDurationMs: 0,
          layoutDurationMs: 0,
          paintTimeMs: 240.3,
          presentationTimeMs: 276,
        },
      }),
    );

    expect(totalSliced(decomposition)).toBeCloseTo(140.3, 6);
    expect(decomposition.charges.browserRenderingMs).toBeCloseTo(105.5, 6);
    expect(decomposition.charges.javaScriptMs).toBeCloseTo(14.9, 6);
    // The rest is the 19.2ms between the script's end and the rendering update.
    expect(decomposition.charges.unattributedMs).toBeCloseTo(19.9, 6);
    expect(decomposition.notes).toEqual([]);
  });

  it('does not note a split that disagrees with its total by one grid step', () => {
    /*
     * The spec defines the combined figure as the sum of the two halves but
     * coarsens each half independently, specifically so that summing them
     * cannot recover resolution. Measured: exactly +/-0.1ms on 6 of the
     * corpus's 20 forced script entries. A note on each of those would train
     * everyone to ignore the notes.
     */
    const decomposition = decomposeFrame(
      frame({
        scripts: [
          script({
            startTimeMs: 100,
            durationMs: 50,
            // Sums to 25.6 against a reported 25.5: one grid step apart.
            forcedStyleAndLayoutDurationMs: 25.5,
            forcedStyleDurationMs: 5.8,
            forcedLayoutDurationMs: 19.8,
          }),
        ],
      }),
    );

    expect(decomposition.notes).toEqual([]);
  });

  it('clamps forced work to the script that reported it, and says so', () => {
    const decomposition = decomposeFrame(
      frame({
        scripts: [
          script({
            startTimeMs: 100,
            durationMs: 20,
            forcedStyleAndLayoutDurationMs: 50,
          }),
        ],
      }),
    );

    expect(decomposition.charges.browserRenderingMs).toBe(20);
    expect(decomposition.charges.javaScriptMs).toBe(0);
    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
    expect(decomposition.notes).toEqual([
      { kind: 'forced-exceeds-script-duration', scriptIndex: 0, byMs: 30 },
    ]);
  });
});

describe('the rendering update', () => {
  it('carves style and layout out of its window and calls the rest paint', () => {
    /*
     * Measured on the first frame of `spans` (development, 4x): styleDuration
     * 0.6ms and layoutDuration 24.3ms inside a 180.9ms frame. Only three of the
     * corpus's 54 painted frames report either as non-zero, because style and
     * layout performed while no script is running — before the rendering update
     * — are not counted in these fields at all.
     */
    const decomposition = decomposeFrame(
      frame({
        durationMs: 60,
        scripts: [script({ startTimeMs: 100, durationMs: 30 })],
        renderingUpdate: {
          kind: 'rendered',
          renderStartMs: 130,
          styleAndLayoutStartMs: 132,
          styleDurationMs: 0.6,
          layoutDurationMs: 24.3,
          paintTimeMs: 160,
          presentationTimeMs: 195,
        },
      }),
    );

    const durations = new Map(
      decomposition.slices.map((slice) => [slice.kind, slice.durationMs]),
    );
    expect(durations.get('pre-style-and-layout')).toBeCloseTo(2, 6);
    expect(durations.get('style')).toBeCloseTo(0.6, 6);
    expect(durations.get('layout')).toBeCloseTo(24.3, 6);
    expect(durations.get('paint')).toBeCloseTo(3.1, 6);
    expect(decomposition.unaccountedMs).toBeCloseTo(0, 6);
    expect(decomposition.charges.browserRenderingMs).toBeCloseTo(28, 6);
  });

  it('clamps style and layout that overflow their window, and says so', () => {
    const decomposition = decomposeFrame(
      frame({
        renderingUpdate: {
          kind: 'rendered',
          renderStartMs: 150,
          styleAndLayoutStartMs: 150,
          styleDurationMs: 8,
          layoutDurationMs: 8,
          paintTimeMs: 160,
          presentationTimeMs: 190,
        },
      }),
    );

    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
    const durations = new Map(
      decomposition.slices.map((slice) => [slice.kind, slice.durationMs]),
    );
    expect(durations.get('style')).toBe(8);
    expect(durations.get('layout')).toBe(2);
    expect(durations.has('paint')).toBe(false);
    expect(decomposition.notes).toEqual([
      { kind: 'style-and-layout-exceed-rendering-update', byMs: 6 },
    ]);
  });
});

describe('contradictory inputs', () => {
  it('charges overlapping scripts once and says they overlapped', () => {
    /*
     * The spec merges nested entry points — a new script is not started while
     * one is pending — so overlap should be impossible, and none of the
     * corpus's 80 script entries overlaps. If it happens anyway the partition
     * must not double-charge: a frame that is 120% script is a frame nobody
     * will believe the rest of.
     */
    const decomposition = decomposeFrame(
      frame({
        scripts: [
          script({ startTimeMs: 100, durationMs: 40 }),
          script({ startTimeMs: 120, durationMs: 30 }),
        ],
      }),
    );

    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
    expect(decomposition.charges.javaScriptMs).toBeCloseTo(50, 10);
    expect(decomposition.notes).toEqual([
      { kind: 'scripts-overlap', scriptIndex: 1, byMs: 20 },
    ]);
  });

  it('tolerates a script that overruns its frame by a float hair', () => {
    /*
     * Two of the corpus's script entries end 1.5e-9 and 2.2e-9ms past the end
     * of their frame's duration — float64 noise on a value that passed through
     * a 100us coarsening grid. A strict comparison reports them as a broken
     * capture.
     */
    const decomposition = decomposeFrame(
      frame({
        durationMs: 60,
        renderingUpdate: { kind: 'none' },
        scripts: [script({ startTimeMs: 100, durationMs: 60 + 2.2e-9 })],
      }),
    );

    expect(decomposition.notes).toEqual([]);
    expect(Math.abs(decomposition.unaccountedMs)).toBeLessThan(
      COARSENED_TIMING_TOLERANCE_MS,
    );
  });

  it('notes a rendering update that begins before the last script ended', () => {
    const decomposition = decomposeFrame(
      frame({
        scripts: [script({ startTimeMs: 100, durationMs: 55 })],
        renderingUpdate: {
          kind: 'rendered',
          renderStartMs: 150,
          styleAndLayoutStartMs: 155,
          styleDurationMs: 0,
          layoutDurationMs: 0,
          paintTimeMs: 160,
          presentationTimeMs: 190,
        },
      }),
    );

    expect(decomposition.notes).toEqual([
      { kind: 'render-start-before-last-script-end', byMs: 5 },
    ]);
    // Still a complete partition: the cursor never moves backwards, so the
    // overlap is charged to the script and the rendering update gets what is
    // left.
    expect(totalSliced(decomposition)).toBeCloseTo(60, 10);
  });
});

describe('charges and shares', () => {
  it('splits a script slice between JavaScript and the browser work inside it', () => {
    const decomposition = decomposeFrame(
      frame({
        scripts: [
          script({
            startTimeMs: 100,
            durationMs: 50,
            forcedStyleAndLayoutDurationMs: 20,
          }),
        ],
      }),
    );

    const slice = decomposition.slices.find((candidate) => candidate.kind === 'script');
    expect(slice).toBeDefined();
    if (slice === undefined) return;

    expect(chargesOfSlice(slice)).toEqual({
      javaScriptMs: 30,
      browserRenderingMs: 20,
      unattributedMs: 0,
    });
  });

  it('names the denominator it used, and refuses to invent one', () => {
    /*
     * `presentationTime` sits 24-42ms past the end of `duration` in every frame
     * measured across the corpus, so the same milliseconds are a materially
     * different share depending on which total they are quoted against:
     * roughly 70% of `duration` is roughly 45% of input-to-pixels. A share that
     * did not carry its denominator would be unquotable.
     */
    const decomposition = decomposeFrame(
      frame({ scripts: [script({ startTimeMs: 100, durationMs: 45 })] }),
    );

    const ofDuration = shareOfFrame(decomposition, 45, 'frame-duration');
    expect(ofDuration).toEqual({
      ms: 45,
      denominator: 'frame-duration',
      denominatorMs: 60,
      fraction: 0.75,
    });

    const ofPresentation = shareOfFrame(decomposition, 45, 'start-to-presentation');
    expect(ofPresentation?.denominatorMs).toBe(90);
    expect(ofPresentation?.fraction).toBeCloseTo(0.5, 10);

    const unpainted = decomposeFrame(frame({ renderingUpdate: { kind: 'none' } }));
    expect(shareOfFrame(unpainted, 10, 'start-to-presentation')).toBeNull();
  });
});
