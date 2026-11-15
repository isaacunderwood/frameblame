/**
 * Builders for synthetic profiles, shared by the profiler tier's unit tests.
 *
 * Test-only, and not exported from the package. Positions and timings here are
 * not measurements; the tests that use them quote corpus figures where they
 * rely on one, with build mode and throttle rate.
 */

import type { CandidateCause } from './attribution.ts';
import type { FunctionSubject } from './line-attribution.ts';
import type { ProfiledFrame, ProfileTrace, ScriptResource } from './profiler.ts';
import type { CaptureProvenance } from './provenance.ts';

export const PROVENANCE: CaptureProvenance = {
  runId: 'synthetic',
  subject: 'synthetic',
  buildMode: 'production',
  buildModeDescription: 'synthetic',
  cpuThrottleRate: 4,
  browser: 'chromium 159.0.8154.6',
  collectedAt: '2026-11-15T00:00:00.000Z',
};

export /** A script served as written, with no map: the vanilla fixtures' shape. */
function served(url: string): ScriptResource {
  return { url, servedLength: null, sourceMap: null, fetchError: null };
}

export interface SampleSpec {
  readonly atMs: number;
  /** Leaf first, as `[resourceId, name, 1-based column]`, or `null` for no JavaScript. */
  readonly stack: readonly (readonly [number, string | null, number])[] | null;
}

export function trace(
  resources: readonly ScriptResource[],
  samples: readonly SampleSpec[],
): ProfileTrace {
  const frames: ProfiledFrame[] = [];
  const stacks: { frameId: number; parentId: number | null }[] = [];
  const frameIdOf = ([resourceId, name, column]: readonly [
    number,
    string | null,
    number,
  ]) => {
    const found = frames.findIndex(
      (frame) => frame.resourceId === resourceId && frame.column === column,
    );
    if (found !== -1) return found;
    frames.push({ name, resourceId, line: 1, column });
    return frames.length - 1;
  };
  const traced = samples.map(({ atMs, stack }) => {
    if (stack === null) return { atMs, stackId: null };
    let parentId: number | null = null;
    for (const entry of [...stack].reverse()) {
      stacks.push({ frameId: frameIdOf(entry), parentId });
      parentId = stacks.length - 1;
    }
    return { atMs, stackId: parentId };
  });
  return {
    resources,
    frames,
    stacks,
    samples: traced,
    sampling: { requestedIntervalMs: 5, effectiveIntervalMs: 10, maxBufferSize: null },
    startedAtMs: 0,
    stoppedAtMs: 1000,
  };
}

/** The source-location subjects of a ranking, which is every subject this tier emits. */
export function subjects(causes: readonly CandidateCause[]): FunctionSubject[] {
  return causes.flatMap((cause) =>
    cause.subject.kind === 'source-location' ? [cause.subject] : [],
  );
}
