/**
 * One capture's worth of signal records, bundled with what produced them.
 *
 * This is the engine's input type: everything the three collectors said, on one
 * timeline, with the build mode and throttle rate that produced it. A caller
 * that replayed a dump from disk and a caller attached to a live page hand over
 * the same thing, which is what keeps `core` free of I/O and makes the corpus a
 * real test input rather than a fixture-shaped special case.
 *
 * It also holds the interaction windows, which are what tie a frame, a commit
 * and a sample back to the click or keypress that caused them. Several of the
 * claims this engine must reproduce are claims *per interaction* rather than
 * per frame — "the initial mount renders five components and React names none
 * of them" is not a statement about any frame — and an interaction that
 * produced no frame at all is one of the findings, not a gap in the data.
 *
 * **Clock.** Every `…Ms` field in this module and the three it bundles is
 * `performance.now()` milliseconds relative to the document's `timeOrigin`. The
 * only wall-clock value in the whole model is `CaptureProvenance.collectedAt`,
 * which is an ISO string so that it cannot be mistaken for one of these.
 */

import type { LongAnimationFrame } from './loaf.ts';
import type { ProfileTrace } from './profiler.ts';
import type { CaptureProvenance } from './provenance.ts';
import type { ReactSignals } from './react.ts';

/** One press or click inside an interaction. */
export interface InteractionAction {
  /** 0-based within the interaction. */
  readonly index: number;
  /** The key pressed, or `click`. */
  readonly what: string;
  readonly atMs: number;
  /**
   * Whether a long animation frame was reported after this action.
   *
   * `false` is data, not an error, and it is the only honest way to count the
   * jank the trigger cannot see: on one fixture in a production build, 18 of 24
   * interactions that each burned ~45ms of main thread produced no entry,
   * because LoAF's reporting threshold is a fixed 50ms and the distribution
   * sits across it. An aggregate that counts frames under-counts exactly the
   * near-threshold offenders a user feels.
   */
  readonly sawLongFrame: boolean;
}

/**
 * The page-clock window one interaction occupied, with what was done in it.
 *
 * The window is two absolute timestamps rather than a start and a duration,
 * because that is what a consumer needs: slicing frames, commits and samples by
 * `fromMs <= t <= toMs` is the join.
 *
 * Deliberately absent: how many long frames the interaction produced. The
 * captures record a cumulative count before and after each step, and it is not
 * usable — a frame arriving after the final reading made the last step's count
 * disagree with the run's own total in four of eight captures, and the count
 * itself moves with how warm the machine is. `sawLongFrame` per action is the
 * quantity that survives, because it counts interactions rather than frames.
 */
export interface InteractionWindow {
  /** The interaction's name, which is what a claim about it is keyed on. */
  readonly label: string;
  /** What kind of interaction it was: `press`, `click`, `settle`. */
  readonly kind: string;
  /**
   * Start of the window.
   *
   * May be 0, meaning "from the document's beginning". A claim about a page's
   * first mount needs that: React's mount commit lands while the navigation is
   * still in progress — in `spans`' development run (4x), at 239.4ms against
   * the driver's first page-clock reading at 307.1ms — so a window that opened
   * when the driver got control would find the frame, the samples and the
   * commit all just outside it and conclude the mount produced nothing.
   */
  readonly fromMs: number;
  readonly toMs: number;
  /** Empty for a window that only waited. */
  readonly actions: readonly InteractionAction[];
}

/**
 * Everything one capture collected.
 *
 * `profile` is `null` when the profiler was unavailable — no
 * `Document-Policy: js-profiling` on the document response means no
 * `window.Profiler` at all. That is a legitimate runtime state and the first
 * degradation tier: with no stacks, a frame can still be decomposed and its
 * script entries still resolve to their registration sites, at lower
 * confidence. Every capture in the corpus has one, so the degraded path is
 * reasoned rather than measured.
 */
export interface CapturedSignals {
  readonly provenance: CaptureProvenance;
  /** In `startTimeMs` order. */
  readonly frames: readonly LongAnimationFrame[];
  readonly profile: ProfileTrace | null;
  readonly react: ReactSignals;
  /** In plan order, which is also `fromMs` order. */
  readonly interactions: readonly InteractionWindow[];
}

/**
 * Whether a frame began inside an interaction's window, inclusive at both
 * ends. The one rule for which interaction a frame belongs to; see
 * `framesOfInteraction` for why it is the start that decides.
 */
export function frameBeganIn(
  frame: LongAnimationFrame,
  window: InteractionWindow,
): boolean {
  return frame.startTimeMs >= window.fromMs && frame.startTimeMs <= window.toMs;
}

/**
 * The frames that began inside an interaction's window.
 *
 * Keyed on the frame's *start*, not on any overlap: a frame that began inside
 * the window belongs to it even if it ran past the end, and a frame already in
 * progress when the window opened belongs to whatever caused it. The
 * alternative — overlap — would attribute one frame to two interactions, which
 * is indistinguishable in a report from an app that janked twice.
 */
export function framesOfInteraction(
  signals: CapturedSignals,
  label: string,
): readonly LongAnimationFrame[] {
  const window = signals.interactions.find((candidate) => candidate.label === label);
  if (window === undefined) return [];

  return signals.frames.filter((frame) => frameBeganIn(frame, window));
}
