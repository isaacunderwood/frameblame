/**
 * Where a long frame's time went: an exact, unsampled partition of the frame,
 * with an explicit unattributed remainder.
 *
 * This is the denominator everything else is a share of. It uses only LoAF's
 * own fields, so it needs no profiler, no React and no source map — which makes
 * it the one part of the engine that works in every tier, and the part that
 * decides whether the sampled signals are explaining 95% of a frame or 7% of
 * it.
 *
 * ## The partition, and why it cannot sum past the frame
 *
 * The slices are not independent measurements that are then added up. They are
 * the intervals *between consecutive boundary timestamps* the frame already
 * reports — `startTime`, each script's start and end, `renderStart`,
 * `styleAndLayoutStart`, `paintTime` — so they tile the frame by construction.
 * That is the whole reason this is built from boundaries rather than from
 * durations: a partition assembled by adding up reported durations can exceed
 * the thing it partitions, and the *first* mistake `findings.md` names is
 * exactly that, adding `forcedStyleAndLayoutDuration` as a sibling slice when
 * it is browser work nested *inside* a script's own duration.
 *
 * Two quantities cannot be derived from boundaries, because LoAF reports them
 * as durations without boundaries: the rendering update's `styleDuration` and
 * `layoutDuration`, and each script's forced style and layout. Both are
 * therefore *carved out of* an interval that is already bounded — the rendering
 * update window, and the script's own duration — and the result is clamped so
 * the carve-out cannot exceed its container. Where a clamp fires, a note says
 * so. That is the only place in this module where a reported figure and the
 * frame's own boundaries can disagree, and it is where the coarsening shows up.
 *
 * `unaccountedMs` is the signed residual of all of it. It is zero to within
 * float noise on all 53 frames in the corpus, which is the arithmetic honesty
 * check rather than a discovery: a non-zero value means the clamps absorbed a
 * real disagreement, and the notes say which.
 *
 * ## Named is not the same as attributed
 *
 * Every millisecond lands in a slice, and most of those slices name *when*
 * something happened without naming *what* it was. The 110-131ms between the
 * last script and `renderStart` on the corpus's unforced `innerHTML` frames
 * (4x, both build modes) is a named slice and an unattributed one: LoAF says no
 * script was running, the profiler says no JavaScript was on the stack, and the
 * fixture's own probe says the thread was busy throughout — a `MessageChannel`
 * message it posted to itself took 116.7-148.8ms to be delivered. So the honest
 * answer is "we know when, not what", and `charges` is the split that says so:
 * JavaScript, browser rendering, and unattributed.
 *
 * Note what that is *not*: it is not the residual. A frame can be fully
 * accounted for and almost entirely unattributed, which is precisely the case
 * this module exists to report rather than hide.
 *
 * ## What this module does not do
 *
 * It does not split the script slices among causes — that needs the profiler —
 * and it does not know what a component is. It takes one frame record and
 * returns arithmetic about it.
 */

import {
  exceedsByMoreThanCoarsening,
  exceedsCoarsenedTolerance,
  frameEndMs,
  type FrameScript,
  type LongAnimationFrame,
} from './loaf.ts';

/**
 * Who a slice's time is charged to.
 *
 * Three categories, because that is how many the browser's own signals support.
 * Anything finer — which component, which vendor — needs the profiler and
 * belongs to a later stage.
 */
export type SliceCharge =
  /** Script the browser named, minus the browser work nested inside it. */
  | 'javascript'
  /** Style, layout and paint, whether forced by a script or part of the rendering update. */
  | 'browser-rendering'
  /** Accounted for in time, but with no cause claimed. */
  | 'unattributed';

/**
 * Browser work and pauses nested inside one script's `duration`.
 *
 * Nested, never adjacent: `selfJavaScriptMs + forcedStyleAndLayoutMs` is the
 * script's whole duration, and adding the forced figure to the frame as its own
 * slice would count those milliseconds twice.
 */
export interface ScriptInterior {
  /**
   * The script's duration minus the browser work it forced.
   *
   * `pausedMs` is **inside** this figure, not carved out of it. A script that
   * blocks the thread in a synchronous dialog is the cause of that delay, and
   * the unit here is frame time rather than CPU time, so the frame's time is
   * charged to the script that stopped it. The field is 0 on all 77 script
   * entries in the corpus, so this is a reasoned default rather than a measured
   * one.
   */
  readonly selfJavaScriptMs: number;
  /** Style and layout the script forced synchronously, inside its own duration. */
  readonly forcedStyleAndLayoutMs: number;
  /** The same figure split, where the collector recorded the split. */
  readonly forcedStyleMs: number | null;
  readonly forcedLayoutMs: number | null;
  /** Time the script spent blocked in a synchronous dialog or request. */
  readonly pausedMs: number;
}

/**
 * One slice of a frame.
 *
 * A union on `kind` rather than a record with optional fields, so that the
 * impossible combinations cannot be written: a `script` slice always has a
 * script and an index, and a `style` slice never has a start time, because LoAF
 * reports style and layout as durations inside the rendering update without
 * saying when either began.
 */
export type FrameSlice =
  /**
   * From the frame's start to its first reported script.
   *
   * Input delay on an interaction frame, plus any script that ran for under
   * LoAF's 5ms attribution threshold and so was never reported. Not named
   * "input delay" here because a frame need not have an input: two frames in
   * the corpus are a bare `Promise.resolve` task with no UI event at all.
   */
  | {
      readonly kind: 'before-first-script';
      readonly startMs: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'script';
      readonly startMs: number;
      readonly durationMs: number;
      /** Index into `LongAnimationFrame.scripts`. */
      readonly scriptIndex: number;
      readonly script: FrameScript;
      readonly interior: ScriptInterior;
    }
  /** Between two reported scripts: more sub-5ms work, or more waiting. */
  | {
      readonly kind: 'between-scripts';
      readonly startMs: number;
      readonly durationMs: number;
    }
  /**
   * From the last script's end to `renderStart`.
   *
   * The slice that holds the frame's worst case. On the corpus's unforced
   * `innerHTML` frames this is 110-131ms of a 125-160ms frame (4x, both build
   * modes): real main-thread work, which LoAF cannot name because style and
   * layout performed while no script is running — before the rendering update —
   * are not counted in `styleDuration` or `layoutDuration`. That is specified
   * behaviour, not a Chrome bug.
   */
  | {
      readonly kind: 'script-to-render';
      readonly startMs: number;
      readonly durationMs: number;
    }
  /** `renderStart` to `styleAndLayoutStart`: rAF callbacks, resize and intersection observers. */
  | {
      readonly kind: 'pre-style-and-layout';
      readonly startMs: number;
      readonly durationMs: number;
    }
  /**
   * Style, layout and the rest of the rendering update.
   *
   * No start time: LoAF reports `styleDuration` and `layoutDuration` as
   * durations within `[styleAndLayoutStart, paintTime]` and does not say when
   * either began. `paint` is that window minus the two, so it is "everything
   * else in the rendering update" rather than paint strictly.
   */
  | { readonly kind: 'style'; readonly durationMs: number }
  | { readonly kind: 'layout'; readonly durationMs: number }
  | { readonly kind: 'paint'; readonly durationMs: number }
  /**
   * Frame time after the last script on a frame that never painted.
   *
   * Reachable only when there was no rendering update to name the tail. Both
   * such frames in the corpus end exactly at their script's end, so this slice
   * is zero-width and never emitted there.
   */
  | {
      readonly kind: 'after-last-script';
      readonly startMs: number;
      readonly durationMs: number;
    };

/** The frame's time split by who it is charged to. Sums to the frame's duration. */
export interface FrameCharges {
  readonly javaScriptMs: number;
  readonly browserRenderingMs: number;
  readonly unattributedMs: number;
}

/**
 * A disagreement between a figure the frame reported and the frame's own
 * boundaries, with the signed size of it.
 *
 * Emitted only past `COARSENED_TIMING_TOLERANCE_MS`, and every one of these
 * checks goes through `exceedsByMoreThanCoarsening` so that the boundary is
 * inclusive and float-safe in the same way at each site. Below that the
 * disagreement is the coarsening — every field is quantised onto a randomised
 * 100us grid, and the spec quantises the style and layout durations
 * individually on purpose so that summing them cannot recover more resolution
 * — and a note on every frame is a note nobody reads.
 *
 * None of these fire on any frame in the corpus. They exist because the
 * alternative to reporting a disagreement is silently absorbing it into a
 * clamp, which is how a frame comes to be 140% explained.
 */
export type FrameConsistencyNote =
  | {
      readonly kind: 'script-starts-before-frame';
      readonly scriptIndex: number;
      readonly byMs: number;
    }
  | {
      readonly kind: 'script-ends-after-frame';
      readonly scriptIndex: number;
      readonly byMs: number;
    }
  | {
      readonly kind: 'scripts-overlap';
      readonly scriptIndex: number;
      readonly byMs: number;
    }
  | {
      readonly kind: 'forced-exceeds-script-duration';
      readonly scriptIndex: number;
      readonly byMs: number;
    }
  | {
      readonly kind: 'forced-split-disagrees-with-total';
      readonly scriptIndex: number;
      readonly byMs: number;
    }
  | { readonly kind: 'style-and-layout-exceed-rendering-update'; readonly byMs: number }
  | { readonly kind: 'render-start-before-last-script-end'; readonly byMs: number };

/**
 * One frame, partitioned.
 *
 * `frame` is carried rather than copied from: the frame's duration is read off
 * the record it came from, so there is no second copy of it for the slices to
 * disagree with. There is also no way to obtain one of these except from
 * `decomposeFrame`, which derives every slice from that same record.
 */
export interface FrameDecomposition {
  readonly frame: LongAnimationFrame;
  /** `paintTime`, or the end of `duration` on a frame that never painted. */
  readonly frameEndMs: number;
  /** In time order; the rendering update's three come last. Zero-width slices are omitted. */
  readonly slices: readonly FrameSlice[];
  readonly charges: FrameCharges;
  /**
   * The frame's duration minus the sum of its slices, signed.
   *
   * Zero by construction and in practice: 0 to within 2e-9ms on every frame in
   * the corpus. A value past the coarsening tolerance means a clamp absorbed a
   * real disagreement, and `notes` says which one.
   */
  readonly unaccountedMs: number;
  readonly notes: readonly FrameConsistencyNote[];
}

/** Which total a share is quoted against. Naming it is not optional. */
export type FrameDenominator =
  /** The frame's own `duration`, which ends at `paintTime`. */
  | 'frame-duration'
  /**
   * The frame's start to its `presentationTime` — when the pixels actually
   * changed.
   *
   * The honest denominator for "how much of what the user felt was this", and
   * 23.8-42.5ms larger than `duration` in every frame in the corpus (4x):
   * roughly 70% of `duration` is roughly 45% of this.
   */
  | 'start-to-presentation';

/** A millisecond figure as a share of a named total. */
export interface FrameShare {
  readonly ms: number;
  readonly denominator: FrameDenominator;
  readonly denominatorMs: number;
  /** `ms / denominatorMs`, in [0, 1]. */
  readonly fraction: number;
}

function clampNonNegative(ms: number): number {
  return ms > 0 ? ms : 0;
}

/**
 * Splits the part of a script the partition charges to it into the JavaScript
 * that ran and the browser work it forced.
 *
 * `chargeableMs` is the slice's duration, which is the script's own duration in
 * every case the corpus contains and less than it only where two scripts
 * overlap — the spec's merging of nested entry points should make that
 * impossible, and no capture shows it. The two figures returned always sum to
 * `chargeableMs` exactly, which is what keeps the charge totals equal to the
 * slice totals: a script whose interior were split against its full duration
 * while its slice had been trimmed would charge the frame for milliseconds the
 * partition had already given to someone else.
 *
 * The clamp order is forced work first, then JavaScript takes what is left.
 * `forcedStyleAndLayoutDuration` is supposed to be a subset of the script's own
 * duration and is on all 77 entries in the corpus — the tightest is 101.9ms of
 * forced work inside a 103.8ms script (`vendor-listener`, development, 4x) —
 * and where it is not, the boundary-derived figure wins, because that is the
 * one the partition is built from. The overshoot is reported as a note rather
 * than quietly inflating the frame.
 */
function scriptInterior(script: FrameScript, chargeableMs: number): ScriptInterior {
  const chargeable = clampNonNegative(chargeableMs);
  const forced = Math.min(
    clampNonNegative(script.forcedStyleAndLayoutDurationMs),
    chargeable,
  );
  const selfJavaScriptMs = chargeable - forced;

  return {
    selfJavaScriptMs,
    forcedStyleAndLayoutMs: forced,
    forcedStyleMs: script.forcedStyleDurationMs,
    forcedLayoutMs: script.forcedLayoutDurationMs,
    // Inside `selfJavaScriptMs`, so it cannot exceed it. See the field's note.
    pausedMs: Math.min(clampNonNegative(script.pauseDurationMs), selfJavaScriptMs),
  };
}

/**
 * What one slice contributes to each charge.
 *
 * A script slice contributes to two of them, which is why charges are totalled
 * from a function rather than read off a `charge` field on the slice: a field
 * would have to be `'mixed'` for exactly the case that matters most.
 */
export function chargesOfSlice(slice: FrameSlice): FrameCharges {
  switch (slice.kind) {
    case 'script':
      return {
        javaScriptMs: slice.interior.selfJavaScriptMs,
        browserRenderingMs: slice.interior.forcedStyleAndLayoutMs,
        unattributedMs: 0,
      };
    case 'style':
    case 'layout':
    case 'paint':
      return { javaScriptMs: 0, browserRenderingMs: slice.durationMs, unattributedMs: 0 };
    case 'before-first-script':
    case 'between-scripts':
    case 'script-to-render':
    case 'pre-style-and-layout':
    case 'after-last-script':
      return { javaScriptMs: 0, browserRenderingMs: 0, unattributedMs: slice.durationMs };
  }
}

/**
 * Partitions one long animation frame.
 *
 * Returns every millisecond of `[startTime, frameEnd]` in exactly one slice,
 * the three-way charge split, the signed residual, and a note for every
 * reported figure that disagreed with the frame's own boundaries by more than
 * the timing grid. Always returns a decomposition: a frame with no scripts, no
 * rendering update, or figures that contradict each other still produces one,
 * because "always produce something, and state what it was working from" is the
 * rule the degradation model runs on.
 *
 * Assumes the frame's scripts are in start order, which is how the API reports
 * them and how all 77 entries in the corpus arrive. Out-of-order scripts do not
 * throw — they produce a `scripts-overlap` note and a partition that charges
 * the overlap once.
 *
 * All inputs and outputs are page-clock `performance.now()` milliseconds.
 */
export function decomposeFrame(frame: LongAnimationFrame): FrameDecomposition {
  const slices: FrameSlice[] = [];
  const notes: FrameConsistencyNote[] = [];
  const end = frameEndMs(frame);

  /*
   * The cursor is the partition. It only ever moves forward, so two scripts
   * that overlap — which the spec's merging of nested entry points should
   * prevent, and which no capture has shown — charge their overlap once rather
   * than twice. Everything below either advances the cursor or emits the
   * interval the cursor has just crossed.
   */
  let cursor = frame.startTimeMs;

  const push = (slice: FrameSlice): void => {
    if (slice.durationMs > 0) slices.push(slice);
  };

  for (const [scriptIndex, script] of frame.scripts.entries()) {
    const scriptEnd = script.startTimeMs + script.durationMs;

    if (exceedsByMoreThanCoarsening(frame.startTimeMs, script.startTimeMs)) {
      notes.push({
        kind: 'script-starts-before-frame',
        scriptIndex,
        byMs: frame.startTimeMs - script.startTimeMs,
      });
    }
    if (exceedsByMoreThanCoarsening(scriptEnd, end)) {
      notes.push({ kind: 'script-ends-after-frame', scriptIndex, byMs: scriptEnd - end });
    }
    if (exceedsByMoreThanCoarsening(cursor, script.startTimeMs)) {
      notes.push({
        kind: 'scripts-overlap',
        scriptIndex,
        byMs: cursor - script.startTimeMs,
      });
    }
    if (
      exceedsByMoreThanCoarsening(
        script.forcedStyleAndLayoutDurationMs,
        script.durationMs,
      )
    ) {
      notes.push({
        kind: 'forced-exceeds-script-duration',
        scriptIndex,
        byMs: script.forcedStyleAndLayoutDurationMs - script.durationMs,
      });
    }

    /*
     * The spec defines `forcedStyleAndLayoutDuration` as exactly the sum of the
     * two halves, but Chrome 159 reports three values that disagree on the
     * 100us grid: by one step on 8 of the corpus's 20 forced entries and by two
     * on 1 (v0.3 re-capture, 4x). Only a disagreement larger than the
     * coarsening is worth reporting, and two steps is exactly the tolerance,
     * which `exceedsCoarsenedTolerance` treats as inside it — a bare `>` would
     * report that entry, whose drift computes as -0.20000000000000284.
     */
    const { forcedStyleDurationMs: forcedStyle, forcedLayoutDurationMs: forcedLayout } =
      script;
    if (forcedStyle !== null && forcedLayout !== null) {
      const drift = forcedStyle + forcedLayout - script.forcedStyleAndLayoutDurationMs;
      if (exceedsCoarsenedTolerance(drift)) {
        notes.push({
          kind: 'forced-split-disagrees-with-total',
          scriptIndex,
          byMs: drift,
        });
      }
    }

    const gap = script.startTimeMs - cursor;
    push({
      kind: scriptIndex === 0 ? 'before-first-script' : 'between-scripts',
      startMs: cursor,
      durationMs: gap,
    });

    const sliceStart = Math.max(cursor, script.startTimeMs);
    // Trimmed to the part of the script the cursor has not already charged,
    // which matters only in the overlap case noted above.
    const chargeableMs = clampNonNegative(scriptEnd - sliceStart);
    push({
      kind: 'script',
      startMs: sliceStart,
      durationMs: chargeableMs,
      scriptIndex,
      script,
      interior: scriptInterior(script, chargeableMs),
    });

    cursor = Math.max(cursor, scriptEnd);
  }

  const update = frame.renderingUpdate;
  if (update.kind === 'rendered') {
    if (exceedsByMoreThanCoarsening(cursor, update.renderStartMs)) {
      notes.push({
        kind: 'render-start-before-last-script-end',
        byMs: cursor - update.renderStartMs,
      });
    }

    push({
      kind: 'script-to-render',
      startMs: cursor,
      durationMs: update.renderStartMs - cursor,
    });
    cursor = Math.max(cursor, update.renderStartMs);

    push({
      kind: 'pre-style-and-layout',
      startMs: cursor,
      durationMs: update.styleAndLayoutStartMs - cursor,
    });
    cursor = Math.max(cursor, update.styleAndLayoutStartMs);

    /*
     * The rendering update's window is bounded; its contents are not. Style and
     * layout are carved out of the window in the order the browser performs
     * them, and whatever is left is paint and everything else. The clamping
     * cascade is what keeps the carve-out inside its container when the
     * reported durations and the boundaries disagree: `findings.md` records
     * that `paintTime - styleAndLayoutStart - style - layout` can come out
     * slightly negative purely from the coarsening.
     */
    const window = clampNonNegative(update.paintTimeMs - cursor);
    const style = Math.min(update.styleDurationMs, window);
    const layout = Math.min(update.layoutDurationMs, window - style);
    const reported = update.styleDurationMs + update.layoutDurationMs;
    if (exceedsByMoreThanCoarsening(reported, window)) {
      notes.push({
        kind: 'style-and-layout-exceed-rendering-update',
        byMs: reported - window,
      });
    }

    // These three exhaust the window, so the cursor is at `paintTime` — which
    // is the end of the frame, and the reason it is not advanced again here.
    push({ kind: 'style', durationMs: style });
    push({ kind: 'layout', durationMs: layout });
    push({ kind: 'paint', durationMs: window - style - layout });
  } else {
    push({ kind: 'after-last-script', startMs: cursor, durationMs: end - cursor });
  }

  const charges = slices.reduce<FrameCharges>(
    (total, slice) => {
      const charged = chargesOfSlice(slice);
      return {
        javaScriptMs: total.javaScriptMs + charged.javaScriptMs,
        browserRenderingMs: total.browserRenderingMs + charged.browserRenderingMs,
        unattributedMs: total.unattributedMs + charged.unattributedMs,
      };
    },
    { javaScriptMs: 0, browserRenderingMs: 0, unattributedMs: 0 },
  );

  const sliced = slices.reduce((sum, slice) => sum + slice.durationMs, 0);

  return {
    frame,
    frameEndMs: end,
    slices,
    charges,
    unaccountedMs: frame.durationMs - sliced,
    notes,
  };
}

/**
 * The total a share would be quoted against, or `null` when the frame cannot
 * support it.
 *
 * `start-to-presentation` is `null` on a frame that never painted or whose
 * presentation time the browser did not report — two of the corpus's 53 frames.
 * Returning `null` rather than falling back to `duration` is the point: a share
 * silently quoted against a different denominator than the caller asked for is
 * exactly the kind of number this project exists not to print.
 */
export function denominatorMs(
  frame: LongAnimationFrame,
  denominator: FrameDenominator,
): number | null {
  if (denominator === 'frame-duration') return frame.durationMs;

  const update = frame.renderingUpdate;
  if (update.kind !== 'rendered' || update.presentationTimeMs === null) return null;
  return update.presentationTimeMs - frame.startTimeMs;
}

/**
 * Expresses a millisecond figure from this decomposition as a share of a named
 * denominator.
 *
 * Returns `null` when the denominator is unavailable or zero, rather than
 * dividing. The fraction is clamped into [0, 1]: a figure larger than its
 * denominator is only reachable by quoting a `duration`-based figure against
 * the presentation denominator or vice versa, and reporting 1.04 of a frame
 * would be worse than reporting all of it.
 */
export function shareOfFrame(
  decomposition: FrameDecomposition,
  ms: number,
  denominator: FrameDenominator,
): FrameShare | null {
  const total = denominatorMs(decomposition.frame, denominator);
  if (total === null || total <= 0) return null;

  return {
    ms,
    denominator,
    denominatorMs: total,
    fraction: Math.min(Math.max(ms / total, 0), 1),
  };
}

/** One line of prose for a consistency note, for a report that must say what it saw. */
export function describeConsistencyNote(note: FrameConsistencyNote): string {
  const by = `${note.byMs.toFixed(1)}ms`;

  switch (note.kind) {
    case 'script-starts-before-frame':
      return `script ${String(note.scriptIndex)} starts ${by} before the frame it is attached to`;
    case 'script-ends-after-frame':
      return `script ${String(note.scriptIndex)} ends ${by} after the end of the frame's duration`;
    case 'scripts-overlap':
      return `script ${String(note.scriptIndex)} overlaps the previous one by ${by}; the overlap is charged once`;
    case 'forced-exceeds-script-duration':
      return `script ${String(note.scriptIndex)} reports ${by} more forced style and layout than it ran for; the script's duration was used`;
    case 'forced-split-disagrees-with-total':
      return `script ${String(note.scriptIndex)}'s forced style and layout split differs from its total by ${by}, which is more than the timing grid explains`;
    case 'style-and-layout-exceed-rendering-update':
      return `style and layout report ${by} more than the rendering update lasted; both were clamped to it`;
    case 'render-start-before-last-script-end':
      return `the rendering update begins ${by} before the last script ended`;
  }
}
