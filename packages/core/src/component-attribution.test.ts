/**
 * The React tier, against commits built by hand.
 *
 * These are the cases the corpus cannot supply. Its two React fixtures are one
 * root over flat siblings, so it has no carried-over fiber, no nested
 * component, no negative self time and no truncated walk. `packages/corpus`
 * asserts the same arithmetic against every real commit, which says the model
 * fits React 19.3.1. This file says it survives the inputs React has not
 * happened to produce in the corpus yet.
 *
 * Both halves of the tier are tested here, because they share these
 * builders: `fiber-self-time.ts`'s participation and self-time arithmetic, and
 * `component-attribution.ts`'s ranking on top of it.
 *
 * Figures quoted in comments are from the corpus, with the build mode and
 * throttle rate they were measured under. The synthetic durations in the
 * builders are not measurements.
 */

import { describe, expect, it } from 'vitest';

import {
  attributeCommit,
  attributeInteractionComponents,
  describeCommitBasis,
} from './component-attribution.ts';
import { commitRenderTimes, fiberParticipation } from './fiber-self-time.ts';
import type { LongAnimationFrame } from './loaf.ts';
import type { ProfileTrace } from './profiler.ts';
import type { BuildMode } from './provenance.ts';
import type { LinkedFiber, ReactCommit, ReactSpan, RenderedFiber } from './react.ts';
import type { CapturedSignals } from './signals.ts';

/** Render evidence for the four participations, as React 19.3.1 leaves them. */
const UPDATED = { flags: 1, hasAlternate: true, carriedOver: false };
const MOUNTED = { flags: 1, hasAlternate: false, carriedOver: false };
const BAILED_OUT = { flags: 0, hasAlternate: true, carriedOver: false };
const CARRIED_OVER = { flags: 1, hasAlternate: true, carriedOver: true };

function fiber(
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

function commit(
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

function signals(overrides: {
  commits: readonly ReactCommit[];
  spans?: readonly ReactSpan[];
  frames?: readonly LongAnimationFrame[];
  profile?: ProfileTrace | null;
  buildMode?: BuildMode;
}): CapturedSignals {
  return {
    provenance: {
      runId: 'synthetic',
      subject: 'synthetic',
      buildMode: overrides.buildMode ?? 'development',
      buildModeDescription: 'synthetic',
      cpuThrottleRate: 4,
      browser: 'chromium 159.0.8154.6',
      collectedAt: '2026-11-15T00:00:00.000Z',
    },
    frames: overrides.frames ?? [],
    profile: overrides.profile ?? null,
    react: {
      hookInstalled: true,
      commits: overrides.commits,
      spans: overrides.spans ?? [],
    },
    interactions: [
      { label: 'click', kind: 'click', fromMs: 900, toMs: 1100, actions: [] },
    ],
  };
}

/**
 * A trace with one bundle and the given stacks, each a leaf-first list of
 * function names. Every function is defined at its own column on line 9, the
 * way a minified bundle lays them out, unless `sites` moves one.
 */
function trace(
  samples: readonly { atMs: number; stack: readonly string[] | null }[],
  sites: Readonly<Record<string, number>> = {},
): ProfileTrace {
  const frames: { name: string; resourceId: number; line: number; column: number }[] = [];
  const stacks: { frameId: number; parentId: number | null }[] = [];

  const frameIdOf = (name: string, column: number): number => {
    const found = frames.findIndex(
      (frame) => frame.name === name && frame.column === column,
    );
    if (found !== -1) return found;
    frames.push({ name, resourceId: 0, line: 9, column });
    return frames.length - 1;
  };

  const traced = samples.map(({ atMs, stack }) => {
    if (stack === null) return { atMs, stackId: null };
    let parentId: number | null = null;
    // Root first, so that every parent's index is lower than its child's, as
    // in every capture.
    for (const [depth, name] of [...stack].reverse().entries()) {
      const column = sites[`${name}@${String(atMs)}`] ?? 100 + depth;
      stacks.push({ frameId: frameIdOf(name, column), parentId });
      parentId = stacks.length - 1;
    }
    return { atMs, stackId: parentId };
  });

  return {
    resources: [
      {
        url: 'http://localhost/assets/index.js',
        servedLength: null,
        sourceMap: null,
        fetchError: null,
      },
    ],
    frames,
    stacks,
    samples: traced,
    sampling: { requestedIntervalMs: 5, effectiveIntervalMs: 10, maxBufferSize: null },
    startedAtMs: 0,
    stoppedAtMs: 2000,
  };
}

function names(attribution: {
  causes: { causes: readonly { subject: unknown }[] };
}): string[] {
  return attribution.causes.causes.flatMap(({ subject }) =>
    typeof subject === 'object' && subject !== null && 'name' in subject
      ? [String(subject.name)]
      : [],
  );
}

describe('fiberParticipation', () => {
  it('decides "rendered" as React DevTools does', () => {
    expect(fiberParticipation(fiber(0, 'A', null, 1, UPDATED))).toBe('updated');
    expect(fiberParticipation(fiber(0, 'A', null, 1, MOUNTED))).toBe('mounted');
    expect(fiberParticipation(fiber(0, 'A', null, 0, BAILED_OUT))).toBe('bailed-out');
    expect(fiberParticipation(fiber(0, 'A', null, 9, CARRIED_OVER))).toBe('carried-over');
  });

  it('reads a carried-over fiber with no alternate as carried over, not as mounting again', () => {
    /*
     * A fiber that mounted in an earlier commit and was carried over into this
     * one is that commit's object, which was never cloned, so it still has no
     * alternate. Testing `hasAlternate` first would call it a fresh mount and
     * charge it a stale render.
     */
    const stale = fiber(0, 'A', null, 9, {
      flags: 1,
      hasAlternate: false,
      carriedOver: true,
    });
    expect(fiberParticipation(stale)).toBe('carried-over');
  });
});

describe('commitRenderTimes', () => {
  it('subtracts the children, so the self times sum to the commit total and not past it', () => {
    /*
     * The shape of `spans`' `mount-toggle` commit: a root over siblings that
     * each burn ~25ms. In the corpus the root reads 151.2ms and the naive sum
     * of every `actualDuration` is 277.2ms (development, 4x).
     */
    const timing = commitRenderTimes(
      commit([
        fiber(0, 'App', null, 100),
        fiber(1, 'A', 0, 25),
        fiber(2, 'B', 0, 25),
        fiber(3, 'C', 0, 25),
      ]),
    );
    expect(timing.kind).toBe('timed');
    if (timing.kind !== 'timed') return;

    expect(timing.times.totalMs).toBe(100);
    expect(timing.times.fibers.map((entry) => entry.selfMs)).toEqual([25, 25, 25, 25]);
    expect(timing.times.renderedSelfMs).toBe(100);
    expect(timing.times.notes).toEqual([]);
  });

  it('subtracts only direct children, through any depth of nesting', () => {
    const timing = commitRenderTimes(
      commit([
        fiber(0, 'App', null, 60),
        fiber(1, 'List', 0, 50),
        fiber(2, 'Row', 1, 40),
      ]),
    );
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.fibers.map((entry) => entry.selfMs)).toEqual([10, 10, 40]);
    expect(timing.times.totalMs).toBe(60);
  });

  it('keeps a bailed-out parent in the subtraction and out of the rendered total', () => {
    /*
     * `state-owner-self` (development, 4x): `App` reads 25.2ms with
     * `PerformedWork` clear, and all of it is `StateOwner`'s. Its self time is
     * zero, and it did not render.
     */
    const timing = commitRenderTimes(
      commit([
        fiber(0, 'App', null, 25, BAILED_OUT),
        fiber(1, 'Sibling', 0, 0, BAILED_OUT),
        fiber(2, 'StateOwner', 0, 25),
      ]),
    );
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.totalMs).toBe(25);
    expect(timing.times.renderedSelfMs).toBe(25);
    expect(timing.times.bailedOutSelfMs).toBe(0);
  });

  it('skips a carried-over subtree both as a candidate and as a child of its parent', () => {
    /*
     * React leaves a carried-over child out of its parent's `actualDuration`,
     * so subtracting the child's stale 50ms would make the parent's self time
     * -40ms. Its descendant is carried over too, whatever its own flag says,
     * because it is part of the same uncloned subtree.
     */
    const timing = commitRenderTimes(
      commit([
        fiber(0, 'App', null, 20),
        fiber(1, 'Fresh', 0, 10),
        fiber(2, 'Stale', 0, 50, CARRIED_OVER),
        fiber(3, 'StaleChild', 2, 45, UPDATED),
      ]),
    );
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.fibers.map((entry) => entry.fiber.name)).toEqual([
      'App',
      'Fresh',
    ]);
    expect(timing.times.fibers.map((entry) => entry.selfMs)).toEqual([10, 10]);
    expect(timing.times.totalMs).toBe(20);
    expect(timing.times.carriedOverFibers).toBe(2);
    expect(timing.times.notes).toEqual([]);
  });

  it('reports a materially negative self time instead of clamping it', () => {
    const timing = commitRenderTimes(
      commit([fiber(0, 'App', null, 20), fiber(1, 'A', 0, 15), fiber(2, 'B', 0, 15)]),
    );
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.fibers[0]?.selfMs).toBe(-10);
    expect(timing.times.notes).toEqual([
      { kind: 'negative-self-time', fiberId: 0, componentName: 'App', byMs: 10 },
    ]);
  });

  it('lets a self time two grid steps below zero pass as coarsening', () => {
    // Inclusive at the tolerance, as every coarsened comparison in the engine is.
    const timing = commitRenderTimes(
      commit([fiber(0, 'App', null, 25), fiber(1, 'A', 0, 25.2)]),
    );
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.notes).toEqual([]);

    const beyond = commitRenderTimes(
      commit([fiber(0, 'App', null, 25), fiber(1, 'A', 0, 25.3)]),
    );
    if (beyond.kind !== 'timed') throw new Error('expected a timed commit');
    expect(beyond.times.notes.map((note) => note.kind)).toEqual(['negative-self-time']);
  });

  it('says when the walk was truncated', () => {
    const timing = commitRenderTimes(commit([fiber(0, 'App', null, 20)], 1000, true));
    if (timing.kind !== 'timed') throw new Error('expected a timed commit');
    expect(timing.times.notes).toEqual([{ kind: 'walk-truncated' }]);
  });

  it('refuses partial timings and unlinked captures rather than guessing', () => {
    expect(
      commitRenderTimes(commit([fiber(0, 'App', null, 20), fiber(1, 'A', 0, null)])),
    ).toEqual({ kind: 'untimed', shortfall: 'fiber-timings-absent' });

    const flat: RenderedFiber = {
      name: 'App',
      tag: 0,
      lanes: 0,
      actualDurationMs: 20,
      selfBaseDurationMs: 20,
    };
    const unlinked: ReactCommit = {
      ...commit([]),
      components: { linkage: 'unrecorded', fibers: [flat] },
    };
    expect(commitRenderTimes(unlinked)).toEqual({
      kind: 'untimed',
      shortfall: 'fiber-linkage-unrecorded',
    });
  });

  it('does not let a carried-over fiber’s null timing block the commit', () => {
    // Only fibers in the commit need a timing; a stale one is never read.
    const timing = commitRenderTimes(
      commit([fiber(0, 'App', null, 20), fiber(1, 'Stale', 0, null, CARRIED_OVER)]),
    );
    expect(timing.kind).toBe('timed');
  });
});

describe('attributeCommit at the fiber tier', () => {
  it('names only the components that rendered, weighted by self time', () => {
    const input = signals({
      commits: [
        commit([
          fiber(0, 'App', null, 30, BAILED_OUT),
          fiber(1, 'Idle', 0, 0, BAILED_OUT),
          fiber(2, 'Busy', 0, 30),
        ]),
      ],
    });
    const [only] = input.react.commits;
    if (only === undefined) throw new Error('no commit');

    const attribution = attributeCommit(input, only, 900);
    expect(attribution.basis.tier).toBe('react-fiber-timings');
    expect(names(attribution)).toEqual(['Busy']);
    expect(attribution.causes.causes[0]?.weight).toEqual({
      fraction: 1,
      basis: 'fiber-self-time-share',
    });
  });

  it('attributes a commit that no long frame surrounds', () => {
    const input = signals({ commits: [commit([fiber(0, 'StateOwner', null, 25)])] });
    const [only] = input.react.commits;
    if (only === undefined) throw new Error('no commit');

    const attribution = attributeCommit(input, only, 900);
    expect(attribution.frame).toBeNull();
    expect(names(attribution)).toEqual(['StateOwner']);
  });

  it('merges same-named fibers into one candidate, with one evidence entry each', () => {
    const input = signals({
      commits: [
        commit([
          fiber(0, 'List', null, 30),
          fiber(1, 'Row', 0, 10),
          fiber(2, 'Row', 0, 10),
        ]),
      ],
    });
    const [only] = input.react.commits;
    if (only === undefined) throw new Error('no commit');

    const row = attributeCommit(input, only, 900).causes.causes.find(
      (cause) => cause.subject.kind === 'component' && cause.subject.name === 'Row',
    );
    expect(row?.weight.fraction).toBeCloseTo(2 / 3, 10);
    expect(row?.evidence.map((evidence) => evidence.kind)).toEqual([
      'fiber-render-time',
      'fiber-render-time',
    ]);
  });

  it('attaches a span as corroboration without moving any weight', () => {
    const fibers = [fiber(0, 'App', null, 50), fiber(1, 'Named', 0, 25)];
    const span: ReactSpan = {
      kind: 'component',
      componentName: 'Named',
      startTimeMs: 950,
      durationMs: 25,
      changedProps: [],
    };
    const withSpan = signals({ commits: [commit(fibers)], spans: [span] });
    const without = signals({ commits: [commit(fibers)] });
    const [a] = withSpan.react.commits;
    const [b] = without.react.commits;
    if (a === undefined || b === undefined) throw new Error('no commit');

    const corroborated = attributeCommit(withSpan, a, 900).causes;
    const plain = attributeCommit(without, b, 900).causes;
    expect(corroborated.causes.map((cause) => cause.weight)).toEqual(
      plain.causes.map((cause) => cause.weight),
    );

    const named = corroborated.causes.find(
      (cause) => cause.subject.kind === 'component' && cause.subject.name === 'Named',
    );
    expect(named?.evidence.map((evidence) => evidence.kind)).toEqual([
      'fiber-render-time',
      'react-component-span',
    ]);
  });

  it('ignores a span from outside the commit’s window', () => {
    const span: ReactSpan = {
      kind: 'component',
      componentName: 'A',
      startTimeMs: 100,
      durationMs: 25,
      changedProps: [],
    };
    const input = signals({
      commits: [commit([fiber(0, 'A', null, 25)])],
      spans: [span],
    });
    const [only] = input.react.commits;
    if (only === undefined) throw new Error('no commit');
    const [cause] = attributeCommit(input, only, 900).causes.causes;
    expect(cause?.evidence.map((evidence) => evidence.kind)).toEqual([
      'fiber-render-time',
    ]);
  });

  it('keeps weights inside the commit when a self time goes negative', () => {
    const input = signals({
      commits: [
        commit([fiber(0, 'App', null, 20), fiber(1, 'A', 0, 15), fiber(2, 'B', 0, 15)]),
      ],
    });
    const [only] = input.react.commits;
    if (only === undefined) throw new Error('no commit');

    const attribution = attributeCommit(input, only, 900);
    expect(attribution.causes.totalWeight).toBeLessThanOrEqual(1);
    expect(attribution.notes.map((note) => note.kind)).toEqual(['negative-self-time']);
  });
});

describe('attributeCommit without fiber timings', () => {
  /** A production commit: render evidence present, every timing null. */
  const production = commit([
    fiber(0, 'b', null, null),
    fiber(1, 'm', 0, null, BAILED_OUT),
    fiber(2, 'g', 0, null),
  ]);

  it('degrades to the profiler, joined to the hook’s names, and says why', () => {
    const input = signals({
      commits: [production],
      buildMode: 'production',
      profile: trace([
        { atMs: 950, stack: ['d', 'g', 'os', 'Fd'] },
        { atMs: 960, stack: ['d', 'g', 'os', 'Fd'] },
        { atMs: 970, stack: ['d', 'b', 'os', 'Fd'] },
        { atMs: 980, stack: ['vu', 'Fd'] },
        { atMs: 985, stack: null },
        // Outside the window on either side.
        { atMs: 850, stack: ['d', 'b', 'os', 'Fd'] },
        { atMs: 1050, stack: ['d', 'g', 'os', 'Fd'] },
      ]),
    });

    const attribution = attributeCommit(input, production, 900);
    expect(attribution.basis).toEqual({
      tier: 'profiler-unmapped',
      shortfall: 'fiber-timings-absent',
      samplesInWindow: 4,
    });
    expect(describeCommitBasis(attribution.basis)).toContain(
      'fiber actualDuration is null',
    );

    // `m` bailed out, so it is no candidate even though the hook reported it.
    expect(names(attribution)).toEqual(['g', 'b']);
    const [g, b] = attribution.causes.causes;
    expect(g?.weight).toEqual({ fraction: 0.5, basis: 'sample-share' });
    expect(b?.weight.fraction).toBe(0.25);
    expect(g?.tier).toBe('profiler-unmapped');
    expect(g?.subject).toMatchObject({
      kind: 'component',
      name: 'g',
      nameIsMinified: true,
    });
    expect(g?.subject.kind === 'component' && g.subject.definedAt?.throughSourceMap).toBe(
      false,
    );
    // The commit-phase sample is in the denominator and charged to nobody.
    expect(attribution.causes.totalWeight).toBeCloseTo(0.75, 10);
  });

  it('charges nothing to a minified name that two functions share', () => {
    const input = signals({
      commits: [production],
      buildMode: 'production',
      profile: trace(
        [
          { atMs: 950, stack: ['d', 'g', 'os'] },
          { atMs: 960, stack: ['g', 'helper'] },
        ],
        // The second `g` is a different function, defined somewhere else.
        { 'g@960': 900 },
      ),
    });

    const attribution = attributeCommit(input, production, 900);
    expect(attribution.notes).toContainEqual({
      kind: 'ambiguous-minified-name',
      componentName: 'g',
      definitionSites: 2,
    });
    const g = attribution.causes.causes.find(
      (cause) => cause.subject.kind === 'component' && cause.subject.name === 'g',
    );
    expect(g?.weight.fraction).toBe(0);
  });

  it('says when the window holds no samples instead of dividing by zero', () => {
    const input = signals({
      commits: [production],
      buildMode: 'production',
      profile: trace([{ atMs: 950, stack: null }]),
    });
    const attribution = attributeCommit(input, production, 900);
    expect(attribution.causes.causes).toEqual([]);
    expect(attribution.notes).toEqual([{ kind: 'no-samples-in-window' }]);
  });

  it('still lists the components the hook saw when there is no profiler either', () => {
    const input = signals({
      commits: [production],
      buildMode: 'production',
      profile: null,
    });
    const attribution = attributeCommit(input, production, 900);
    expect(attribution.basis).toEqual({
      tier: 'unattributed',
      shortfall: 'fiber-timings-absent',
      reason: 'no-profiler',
    });
    expect(attribution.causes.causes).toEqual([]);
    expect(
      attribution.components
        .filter((component) => component.participation === 'updated')
        .map((component) => component.name),
    ).toEqual(['b', 'g']);
  });
});

describe('attributeInteractionComponents', () => {
  it('merges an interaction’s commits by name, as shares of their summed totals', () => {
    const input = signals({
      commits: [
        commit([fiber(0, 'App', null, 40), fiber(1, 'Table', 0, 30)], 950),
        commit([fiber(0, 'App', null, 60), fiber(1, 'Table', 0, 50)], 1050),
        // Outside the interaction's window.
        commit([fiber(0, 'App', null, 500)], 1500),
      ],
    });

    const result = attributeInteractionComponents(input, 'click');
    expect(result?.kind).toBe('attributed');
    if (result?.kind !== 'attributed') return;

    expect(result.commits).toHaveLength(2);
    // The second commit's window opens at the first commit, not at the interaction.
    expect(result.commits[1]?.sampleWindow).toEqual({ fromMs: 950, toMs: 1050 });
    expect(result.merged?.tier).toBe('react-fiber-timings');
    const [table, app] = result.merged?.causes.causes ?? [];
    expect(table?.subject).toMatchObject({ name: 'Table' });
    expect(table?.weight.fraction).toBeCloseTo(80 / 100, 10);
    expect(app?.weight.fraction).toBeCloseTo(20 / 100, 10);
  });

  it('says why an interaction has no commit', () => {
    const none = signals({ commits: [] });
    expect(attributeInteractionComponents(none, 'click')).toMatchObject({
      kind: 'no-commit',
      reason: 'no-commit-in-window',
    });
    const hookless: CapturedSignals = {
      ...none,
      react: { ...none.react, hookInstalled: false },
    };
    expect(attributeInteractionComponents(hookless, 'click')).toMatchObject({
      kind: 'no-commit',
      reason: 'react-hook-absent',
    });
    expect(attributeInteractionComponents(none, 'no-such-interaction')).toBeNull();
  });
});
