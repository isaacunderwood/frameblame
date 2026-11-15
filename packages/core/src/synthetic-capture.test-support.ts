/**
 * Builders for synthetic captures: frames, commits and the signals that bundle
 * them, shared by the unit tests of the modules that join the three signals.
 *
 * Test-only, and not exported from the package. Durations and positions here
 * are not measurements; the tests that use them quote corpus figures where
 * they rely on one, with build mode and throttle rate.
 */

import type { FrameScript, LongAnimationFrame } from './loaf.ts';
import type { LinkedFiber, ReactCommit } from './react.ts';
import type { CapturedSignals } from './signals.ts';
import { PROVENANCE } from './synthetic-profile.test-support.ts';

/** A script entry: an anonymous click listener in `app.js` unless overridden. */
export function script(overrides: Partial<FrameScript>): FrameScript {
  return {
    startTimeMs: 0,
    durationMs: 10,
    executionStartMs: overrides.startTimeMs ?? 0,
    invoker: 'BUTTON.onclick',
    invokerType: 'event-listener',
    sourceUrl: 'http://localhost/app.js',
    sourceFunctionName: null,
    sourceCharPosition: 100,
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

/**
 * A painted frame whose rendering update begins `renderAfterMs` into it and
 * paints at its end, with no style or layout of its own.
 */
export function paintedFrame(
  startTimeMs: number,
  durationMs: number,
  scripts: readonly FrameScript[],
  renderAfterMs: number = durationMs,
): LongAnimationFrame {
  return {
    startTimeMs,
    durationMs,
    blockingDurationMs: Math.max(durationMs - 50, 0),
    firstUIEventTimestampMs: startTimeMs,
    renderingUpdate: {
      kind: 'rendered',
      renderStartMs: startTimeMs + renderAfterMs,
      styleAndLayoutStartMs: startTimeMs + renderAfterMs,
      styleDurationMs: 0,
      layoutDurationMs: 0,
      paintTimeMs: startTimeMs + durationMs,
      presentationTimeMs: startTimeMs + durationMs + 30,
    },
    scripts,
    navigationId: 1,
  };
}

/** Render evidence for the four participations, as React 19.3.1 leaves them. */
export const UPDATED = { flags: 1, hasAlternate: true, carriedOver: false };
export const MOUNTED = { flags: 1, hasAlternate: false, carriedOver: false };
export const BAILED_OUT = { flags: 0, hasAlternate: true, carriedOver: false };
export const CARRIED_OVER = { flags: 1, hasAlternate: true, carriedOver: true };

/** A component fiber. `actualDurationMs` of `null` is what a production build reports. */
export function fiber(
  id: number,
  name: string,
  parentId: number | null,
  actualDurationMs: number | null,
  render: LinkedFiber['render'] = UPDATED,
): LinkedFiber {
  return {
    id,
    parentId,
    name,
    tag: 0,
    lanes: 0,
    actualDurationMs,
    selfBaseDurationMs: actualDurationMs,
    render,
  };
}

/** A commit with its fibers linked, from a walk that reached them all unless `truncated`. */
export function commit(
  fibers: readonly LinkedFiber[],
  committedAtMs = 1000,
  truncated = false,
): ReactCommit {
  return {
    committedAtMs,
    postCommitAtMs: null,
    rendererId: 1,
    didError: false,
    priorityLevel: null,
    collectionCostMs: 0,
    components: { linkage: 'recorded', truncated, fibers },
  };
}

/** A capture with nothing in it but what is overridden, and no DevTools hook. */
export function capture(overrides: Partial<CapturedSignals>): CapturedSignals {
  return {
    provenance: PROVENANCE,
    frames: [],
    profile: null,
    react: { hookInstalled: false, commits: [], spans: [] },
    interactions: [],
    ...overrides,
  };
}
