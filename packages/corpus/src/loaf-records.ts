/**
 * The Long Animation Frame half of the corpus adapter: `loaf.json` into
 * `LongAnimationFrame` records.
 *
 * Of the three jobs `records.ts` describes, the frame is where two of them are
 * heaviest. Chrome spells absence as a number here more than anywhere — a
 * `sourceCharPosition` of -1, a `firstUIEventTimestamp` of 0, a `renderStart`
 * of 0 — and the capture stores each entry twice, from two projections that are
 * each incomplete. Both are resolved below, so the engine receives one frame
 * record with every absence spelled `null`.
 *
 * It deliberately does no arithmetic on the frame. Partitioning it into slices
 * is `decomposeFrame` in `@frameblame/core`; this module only makes sure the
 * fields that partition is computed from mean what their names say.
 */

import type { FrameRenderingUpdate, FrameScript, LongAnimationFrame } from '@frameblame/core';

import type { CorpusRun } from './corpus.ts';
import {
  arrayAt,
  asRecord,
  get,
  type Json,
  type JsonObject,
  type JsonPath,
  nonEmptyStringAt,
  nullableNumberAt,
  numberAt,
  stringAt,
} from './json.ts';

/**
 * One script attribution, assembled from the two copies the capture stores.
 *
 * The capture writes each LoAF entry twice: whatever Chrome's own `toJSON()`
 * serialised, and a field-by-field projection the collector wrote by hand. They
 * agree on every shared field across all 77 entries in the corpus, and neither
 * is complete:
 *
 * - In captures made before step 0.2 of the v0.3 run, only `toJSON` carries
 *   `forcedStyleDuration` and `forcedLayoutDuration`. The hand-written
 *   projection predated the discovery that Chrome ships them — `findings.md`
 *   long had an open item saying the split was unavailable from the entry —
 *   because it was written from the same hand-transcribed ambient declarations
 *   that missed them. The collector now projects both, as `null` where the
 *   browser lacks them.
 * - Only the projection carries `sourceLine` and `sourceColumn`, which Chrome's
 *   `toJSON` omits entirely and which are `null` in every capture anyway,
 *   because the Blink features that populate them are off by default.
 *
 * So the authoritative copy is `toJSON`, and the projection is consulted for
 * the two fields it alone has, and for the forced split where `toJSON` lacks
 * it. Passing `projected` as `undefined` is fine: every field read from it
 * becomes `null`, which is what it is.
 */
function readScript(serialised: JsonObject, projected: Json | undefined): FrameScript {
  // Chrome's "unknown" sentinel is -1, and it is the only negative number
  // anywhere in the captured frames. Left as -1 it would be rejected by
  // `lineColumnAt` as a position outside the script, which is a true statement
  // about the wrong thing: the offset is absent, not out of range.
  const charPosition = numberAt(serialised, ['sourceCharPosition']);
  // Absent from both copies means the browser did not report the split, and
  // stays `null`: a zero would claim it measured no forced style work.
  const forcedSplitHalf = (key: string): number | null =>
    nullableNumberAt(serialised, [key]) ?? nullableNumberAt(projected, [key]);

  return {
    startTimeMs: numberAt(serialised, ['startTime']),
    durationMs: numberAt(serialised, ['duration']),
    executionStartMs: numberAt(serialised, ['executionStart']),
    invoker: stringAt(serialised, ['invoker']),
    invokerType: stringAt(serialised, ['invokerType']),
    sourceUrl: nonEmptyStringAt(serialised, ['sourceURL']),
    sourceFunctionName: nonEmptyStringAt(serialised, ['sourceFunctionName']),
    sourceCharPosition: charPosition < 0 ? null : charPosition,
    sourceLine: nullableNumberAt(projected, ['sourceLine']),
    sourceColumn: nullableNumberAt(projected, ['sourceColumn']),
    pauseDurationMs: numberAt(serialised, ['pauseDuration']),
    forcedStyleAndLayoutDurationMs: numberAt(serialised, ['forcedStyleAndLayoutDuration']),
    forcedStyleDurationMs: forcedSplitHalf('forcedStyleDuration'),
    forcedLayoutDurationMs: forcedSplitHalf('forcedLayoutDuration'),
    windowAttribution: stringAt(serialised, ['windowAttribution']),
  };
}

/**
 * The rendering update, or the fact that there was not one.
 *
 * `renderStart` is Chrome's flag as much as its timestamp: the spec says it and
 * `styleAndLayoutStart` return 0 when there was no rendering update, and the
 * two frames in the corpus that report 0 are both a bare `Promise.resolve` task
 * that never painted — one of them beginning at 60943.7ms, where a 0 could only
 * be a sentinel.
 *
 * Throws on a frame that reports a rendering update with no `paintTime`. That
 * combination does not occur in any capture and has no sensible arithmetic: the
 * end of `duration` is `paintTime` by definition, so a frame claiming to have
 * rendered without one is a frame whose boundaries cannot be established. A
 * loud failure in the adapter is the right place for it; the alternative is an
 * engine quietly deciding which half of the record to disbelieve.
 */
function readRenderingUpdate(frame: JsonObject, path: JsonPath): FrameRenderingUpdate {
  const renderStartMs = numberAt(frame, ['renderStart']);
  const paintTimeMs = nullableNumberAt(frame, ['paintTime']);

  if (renderStartMs === 0) {
    if (paintTimeMs !== null) {
      throw new Error(
        `${path.join('.')}: renderStart is 0, the spec's "no rendering update" sentinel, ` +
          'but the frame reports a paintTime',
      );
    }
    return { kind: 'none' };
  }

  if (paintTimeMs === null) {
    throw new Error(
      `${path.join('.')}: the frame reports a rendering update at ${String(renderStartMs)}ms ` +
        'but no paintTime, so the end of its duration cannot be established',
    );
  }

  return {
    kind: 'rendered',
    renderStartMs,
    styleAndLayoutStartMs: numberAt(frame, ['styleAndLayoutStart']),
    styleDurationMs: numberAt(frame, ['styleDuration']),
    layoutDurationMs: numberAt(frame, ['layoutDuration']),
    paintTimeMs,
    presentationTimeMs: nullableNumberAt(frame, ['presentationTime']),
  };
}

/** Every long animation frame in a run, in capture order. */
export function framesOf(run: CorpusRun): LongAnimationFrame[] {
  return arrayAt(run.files.loaf, ['entries']).map((entry, index) => {
    const path = ['entries', index] as const;
    const serialised = asRecord(get(entry, ['toJSON']), [...path, 'toJSON']);
    const projected = arrayAt(entry, ['scripts']);
    const scripts = arrayAt(serialised, ['scripts']);

    const firstUIEventTimestampMs = numberAt(serialised, ['firstUIEventTimestamp']);

    return {
      startTimeMs: numberAt(serialised, ['startTime']),
      durationMs: numberAt(serialised, ['duration']),
      blockingDurationMs: numberAt(serialised, ['blockingDuration']),
      // Zero means "there was no UI event", not "the UI event happened at time
      // zero" — and whether a frame is interaction-driven turns on it.
      firstUIEventTimestampMs:
        firstUIEventTimestampMs === 0 ? null : firstUIEventTimestampMs,
      renderingUpdate: readRenderingUpdate(serialised, [...path, 'toJSON']),
      scripts: scripts.map((script, scriptIndex) =>
        readScript(
          asRecord(script, [...path, 'toJSON', 'scripts', scriptIndex]),
          projected[scriptIndex],
        ),
      ),
      navigationId: nullableNumberAt(serialised, ['navigationId']),
    };
  });
}
