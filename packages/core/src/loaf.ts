/**
 * Long Animation Frames, as Chrome 159 actually reports them.
 *
 * This is the cheap trigger: which frames were bad, how bad, and an exact
 * unsampled partition of each one. It is the frame's *denominator* and the
 * engine's spine — every other signal is correlated against a window this
 * module describes.
 *
 * These types are derived from the eight captures in `corpus/`, then checked
 * against the specification, in that order. That ordering is deliberate and it
 * caught something: the spec defines `sourceLine` and `sourceColumn`, which
 * Chrome hides behind Blink features that are off by default, and it defines
 * `forcedStyleDuration` and `forcedLayoutDuration`, which Chrome *does* ship
 * and which this project had written off as unavailable. A type written from
 * either source alone would have been wrong in a different direction.
 *
 * What this module does not do: decompose a frame (`frame-decomposition.ts`),
 * resolve a `sourceCharPosition` to a line (`char-position.ts`), or parse
 * anything. It is the record and the arithmetic facts about it.
 *
 * **Clock.** Every timestamp here is `performance.now()` milliseconds relative
 * to the document's `timeOrigin` — the same clock as the profiler's samples and
 * React's spans, which is what makes the join possible at all. Measured: the
 * profiler's first sample lands 0.1-0.9ms after the `performance.now()` reading
 * taken immediately before `new Profiler(...)` (0.0-0.7ms in the capture before
 * the v0.3 re-capture), so no reconciliation is needed.
 *
 * **Absence.** Absence is spelled `null` throughout, never an omitted property.
 * Chrome reports several of these fields with a zero sentinel and omits others
 * entirely, and both mean "there was none" rather than "there were zero
 * milliseconds of it" — a distinction the whole degradation model rests on. One
 * spelling for absence, because two spellings is how one of them gets
 * forgotten.
 *
 * https://w3c.github.io/long-animation-frames/
 */

/**
 * Half the smallest difference two of these fields can meaningfully have.
 *
 * Every LoAF timestamp and duration is coarsened onto a randomised 100us grid
 * (5us when the document is cross-origin isolated, which none of the corpus
 * is). Two independently coarsened values can therefore disagree by up to one
 * grid step each, so a residual below ~0.2ms carries no information and
 * `paintTime - styleAndLayoutStart - styleDuration - layoutDuration` can come
 * out slightly negative.
 *
 * The spec coarsens deliberately and says so: the style and layout durations
 * are accumulated only from "coarsened shared current time", so that summing
 * many short periods cannot expose more precision than a timestamp does. It
 * also defines `forcedStyleAndLayoutDuration` as exactly the sum of the two
 * halves — which Chrome 159 does not honour: it reports the three as values
 * that disagree on the grid. Measured on the corpus's 20 forced script
 * entries, `forcedStyleDuration + forcedLayoutDuration -
 * forcedStyleAndLayoutDuration` was 0 on 11, one grid step (+/-0.1ms) on 8,
 * and two steps (-0.2ms) on 1 (v0.3 re-capture, 4x, both build modes). The
 * capture before it had 11 at one step and none at two; the "6 of 20" this
 * comment quoted then was a miscount. Two steps is this tolerance exactly, so
 * the boundary is inclusive — see `exceedsCoarsenedTolerance`.
 *
 * https://w3c.github.io/long-animation-frames/ ("accumulate style and layout
 * time", and the `forcedStyleAndLayoutDuration` getter)
 */
export const COARSENED_TIMING_TOLERANCE_MS = 0.2;

/**
 * Float slack on the tolerance, in milliseconds: five orders of magnitude below
 * the 0.1ms grid, and well above the ~2e-9ms of float error page-clock values
 * carry (see `isWithinFrame`).
 *
 * Needed because a disagreement of exactly two grid steps does not come out as
 * exactly 0.2 in floating point. The corpus's one such forced entry computes
 * `23.2 + 71.5 - 94.9` as `-0.20000000000000284`, and a bare `> 0.2` reports
 * that as larger than the coarsening explains.
 */
const FLOAT_SLACK_MS = 1e-6;

/**
 * Whether `deltaMs`, a signed difference in milliseconds between coarsened
 * LoAF figures, is larger than the coarsening alone can explain. Clock-free:
 * it is a difference of durations or of page-clock timestamps, never a
 * timestamp itself.
 *
 * Inclusive at the tolerance, plus the float slack above: a difference of two
 * grid steps is inside the coarsening and must not be reported as a
 * disagreement just because the subtraction that produced it rounded a hair
 * past 0.2.
 */
export function exceedsCoarsenedTolerance(deltaMs: number): boolean {
  return Math.abs(deltaMs) > COARSENED_TIMING_TOLERANCE_MS + FLOAT_SLACK_MS;
}

/**
 * One script attribution inside a frame: an entry point that ran for at least
 * 5ms, with where it came from.
 *
 * Nested entry points are merged by spec — if a frame already has a pending
 * script, a new one is not started — which is why React's entire render arrives
 * as a single 55ms entry rather than as a tree, and why there are at most a
 * handful of these per frame. The corpus's frames carry either one or three.
 */
export interface FrameScript {
  readonly startTimeMs: number;
  /**
   * Wall-clock time from entry to exit, *including* browser work this script
   * forced and any time it was paused. See `forcedStyleAndLayoutDurationMs`.
   */
  readonly durationMs: number;
  /**
   * When the script's code actually began running, as opposed to when the entry
   * point was reached. Identical to `startTimeMs` on all 77 script entries in
   * the corpus; the gap would be compile time.
   */
  readonly executionStartMs: number;
  /** What ran it, e.g. `DIV#root.oninput`, `BUTTON.onclick`, `Promise.resolve`. */
  readonly invoker: string;
  /**
   * The category of invoker, e.g. `event-listener` or `resolve-promise`. An
   * open set in the spec, and only those two values appear in the corpus — so
   * it is a string rather than a union, because a union written from the spec
   * would be a list of guesses about what Chrome emits.
   */
  readonly invokerType: string;
  /**
   * The script resource the entry point was defined in, or `null` when Chrome
   * reported no URL (the empty string, on both of the corpus's
   * `resolve-promise` entries).
   */
  readonly sourceUrl: string | null;
  /**
   * `null` for an anonymous function — 54 of the corpus's 77 entries, because
   * every listener in the two vanilla fixtures is an anonymous arrow and the two
   * `resolve-promise` entries name no function at all. (This read "36 of 80"
   * until the v0.3 re-capture; the capture it described had 54 of 80.) Chrome
   * reports the empty string, and the distinction matters: when this is absent
   * the character offset below is doing all of the attribution work.
   */
  readonly sourceFunctionName: string | null;
  /**
   * 0-based UTF-16 offset into the script resource of the function's
   * definition, or `null` when unknown (Chrome's `-1` sentinel).
   *
   * This is LoAF's only position, and it is the registration site rather than
   * the expensive code: `findings.md` records a vendor library's 12ms being
   * attributed to the first-party line that called `addEventListener`, with the
   * vendor's own file named nowhere in the entry. So this cannot produce a
   * third-party share; it can locate non-framework jank precisely. Resolve it
   * with `lineColumnAt` from `char-position.ts`.
   */
  readonly sourceCharPosition: number | null;
  /**
   * The line and column of the same position, 1-based, or `null`.
   *
   * Specified, implemented in Chromium behind the
   * `LongAnimationFrameSourceLineColumn` Blink features, and off by default —
   * `null` on all 77 entries in the corpus. Their absence is the entire reason
   * `sourceCharPosition` has to be resolved by hand, which is the one thing no
   * RUM vendor collecting this signal currently bothers to do.
   */
  readonly sourceLine: number | null;
  readonly sourceColumn: number | null;
  /**
   * Time this script spent blocked in a synchronous dialog or request.
   *
   * Inside `durationMs`, like the forced work below. `0` on all 77 entries in
   * the corpus, so nothing here is measured against a non-zero value.
   */
  readonly pauseDurationMs: number;
  /**
   * Style recalculation and layout the browser performed **inside** this
   * script's `durationMs`, because the script read a layout-dependent property
   * and forced them to happen synchronously.
   *
   * Nested, not adjacent. Adding this to a frame's decomposition as a sibling
   * slice is the single easiest way to produce a frame that sums past its own
   * duration, and `findings.md` names it as the first thing an engine must get
   * right. Measured: a 117.7ms script entry containing 103.8ms of it
   * (`innerhtml-rebuild`, production, 4x; 120.4ms containing 105.5ms in the
   * capture before the v0.3 re-capture).
   */
  readonly forcedStyleAndLayoutDurationMs: number;
  /**
   * The same figure split into its two halves, or `null` when the collector did
   * not record them.
   *
   * Worth a note, because this project concluded the opposite and wrote it
   * down. `findings.md` carries an open item saying the forced scenario's
   * style-versus-layout split "cannot have come from the LoAF entry - the entry
   * exposes only the combined `forcedStyleAndLayoutDuration`". It can: both
   * fields are in the specification, Chrome 159 ships both, and both are in all
   * eight captures. The reason nobody saw them is that the project's ambient
   * declarations were transcribed from the spec by hand and these two were
   * missed, while the collector's own field-by-field projection copied that
   * list. They survived in the captures made before the v0.3 run's collector
   * change only because the collector also stores whatever Chrome's `toJSON()`
   * chooses to serialise, verbatim, next to its hand-picked projection — which
   * is the entire argument for having done that. The projection now carries
   * them too.
   *
   * `null` rather than required because the combined figure is the load-bearing
   * one, and a browser predating the split, or a thinner collector, may carry
   * only that; a zero would claim the browser measured no style work.
   */
  readonly forcedStyleDurationMs: number | null;
  readonly forcedLayoutDurationMs: number | null;
  /**
   * Which window the script ran in, relative to the reporting one: `self`,
   * `descendant`, `ancestor`, and so on. `self` on all 77 corpus entries, so
   * the cross-frame cases are entirely untested here.
   */
  readonly windowAttribution: string;
}

/**
 * The rendering update at the end of a frame, if there was one.
 *
 * A union rather than a record of nullable fields, because Chrome reports the
 * "no rendering update" case with a zero sentinel in `renderStart` and
 * `styleAndLayoutStart` — and a `renderStart` of 0 on a frame that began at
 * 60943.7ms is not a timestamp, it is a flag that happens to be typed as a
 * number. Two of the corpus's 53 frames are like this, both a single
 * `Promise.resolve` task with no paint, and arithmetic that treated the
 * sentinel as a boundary would compute a gap of minus sixty seconds.
 */
export type FrameRenderingUpdate =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'rendered';
      /** When the rendering update began: rAF callbacks, observers, then style and layout. */
      readonly renderStartMs: number;
      /** When style and layout began, after the callbacks. `>= renderStartMs` in all 53 frames. */
      readonly styleAndLayoutStartMs: number;
      /**
       * Style recalculation performed as part of the rendering update — and
       * *only* that.
       *
       * Style and layout performed while no script is running, before the
       * rendering update, are not counted. That is specified behaviour, not a
       * Chrome bug, and it is why these two fields are `0` on the corpus's
       * `innerhtml-rebuild` frames, which are almost entirely style and layout:
       * 48 of the 51 painted frames report 0 for both. The three that do not
       * are all the first frame of their run. (This read "50 of the 54" until
       * the v0.3 re-capture; the capture it described had 51 of 54.)
       */
      readonly styleDurationMs: number;
      readonly layoutDurationMs: number;
      /**
       * The end of `durationMs`, exactly: `startTimeMs + durationMs ===
       * paintTimeMs` held bit-for-bit on all 51 painted frames in the corpus,
       * as the spec requires.
       */
      readonly paintTimeMs: number;
      /**
       * When the frame was actually put on screen, which is **after** the end
       * of `durationMs` — 23.8 to 42.5ms after it, in every frame in the corpus
       * (4x, both build modes; 24.2 to 42.5ms in the capture before).
       *
       * So the denominator has to be named: roughly 70% of `durationMs` is
       * roughly 45% of input-to-pixels. `null` when the browser did not report
       * one.
       */
      readonly presentationTimeMs: number | null;
    };

/**
 * One long animation frame.
 *
 * All long frames are ingested, not only interaction-driven ones: scroll and
 * animation jank has no Core Web Vital and no tooling, and it arrives on the
 * same observer for free.
 *
 * Deliberately absent: anything resembling a frame count. The corpus's
 * `derive-in-render` frames sit either side of LoAF's fixed 50ms reporting
 * threshold, so the number of long frames one replay produces came back as 14,
 * 14, 14, 23 and 14 on one machine within an hour. The count measures where a
 * duration distribution happens to fall relative to a constant, which moves
 * with how warm the machine is — it is not a property of the app at all, and no
 * suite may assert on it. The stable quantity is the aggregate distribution
 * over replayed frames.
 */
export interface LongAnimationFrame {
  readonly startTimeMs: number;
  /** Ends at `paintTime`, not at presentation. See `FrameRenderingUpdate`. */
  readonly durationMs: number;
  /**
   * Roughly the longest task in the frame plus the rendering update, minus 50.
   *
   * Little independent information for a single-task frame, but it does let the
   * longest task's length be recovered, which `duration` alone does not give
   * when a frame holds several scripts.
   */
  readonly blockingDurationMs: number;
  /**
   * When the first UI event in this frame was created, or `null` if there was
   * none — Chrome's zero sentinel, and `null` on 5 of the corpus's 53 frames.
   *
   * Absent, not zero: a frame with no UI event is not a frame whose UI event
   * happened at time zero, and the difference decides whether a frame is
   * interaction-driven at all.
   */
  readonly firstUIEventTimestampMs: number | null;
  readonly renderingUpdate: FrameRenderingUpdate;
  /**
   * Script entry points of at least 5ms, in start order, non-overlapping.
   *
   * May be empty: a frame whose time went entirely to browser work carries no
   * script attribution at all. No frame in the corpus is empty — the shortest
   * path to that state is a long frame with no script over 5ms — so the
   * zero-attribution path is reasoned rather than measured.
   */
  readonly scripts: readonly FrameScript[];
  /** Which navigation the frame belongs to, for discarding frames across one. */
  readonly navigationId: number | null;
}

/**
 * The end of the frame's own `duration`, on the page clock.
 *
 * `paintTime` where the frame painted, and `startTimeMs + durationMs`
 * otherwise. The two are identical where both exist — verified bit-for-bit on
 * every painted frame in the corpus — so this is a single definition rather
 * than a choice between two.
 */
export function frameEndMs(frame: LongAnimationFrame): number {
  return frame.renderingUpdate.kind === 'rendered'
    ? frame.renderingUpdate.paintTimeMs
    : frame.startTimeMs + frame.durationMs;
}

/**
 * Whether `atMs`, a page-clock timestamp, falls inside the frame.
 *
 * Inclusive at both ends and tolerant by one coarsening step, because a script
 * entry's own end can land a float-rounding hair past its frame's: one of the
 * corpus's script entries overshoots by 1.5e-9ms (two, by 1.5e-9 and 2.2e-9ms,
 * in the capture before), which a strict comparison rejects. The tolerance is
 * the grid, not the float error, since anything finer than the grid is
 * meaningless anyway.
 */
export function isWithinFrame(frame: LongAnimationFrame, atMs: number): boolean {
  const tolerance = COARSENED_TIMING_TOLERANCE_MS;
  return atMs >= frame.startTimeMs - tolerance && atMs <= frameEndMs(frame) + tolerance;
}
