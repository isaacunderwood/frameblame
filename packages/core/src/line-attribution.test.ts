/**
 * The profiler tier for lines, against profiles built by hand.
 *
 * `packages/corpus` asserts the tier's answers on the real captures. These
 * are the rules underneath, each on the smallest input that shows it: which
 * frame a sample is charged to, what a population includes at its edges, and
 * how a LoAF entry's registration site and the profiler's answer are kept
 * apart. Positions in the builders are not measurements; figures quoted in
 * comments are from the corpus, with their build mode and throttle rate.
 */

import { describe, expect, it } from 'vitest';

import type { CandidateCause } from './attribution.ts';
import {
  attributeSampledFunctions,
  attributeScriptEntries,
  chargedSamples,
  describeFunctionAttribution,
  describeScriptEntry,
  describeSourceLocation,
  type FunctionSubject,
  type SamplePopulation,
} from './line-attribution.ts';
import type { FrameScript, LongAnimationFrame } from './loaf.ts';
import type { ProfiledFrame, ProfileTrace, ScriptResource } from './profiler.ts';
import type { CaptureProvenance } from './provenance.ts';
import type { CapturedSignals } from './signals.ts';
import { resolveProfile } from './source-map.ts';

const PROVENANCE: CaptureProvenance = {
  runId: 'synthetic',
  subject: 'synthetic',
  buildMode: 'production',
  buildModeDescription: 'synthetic',
  cpuThrottleRate: 4,
  browser: 'chromium 159.0.8154.6',
  collectedAt: '2026-11-15T00:00:00.000Z',
};

/** A script served as written, with no map: the vanilla fixtures' shape. */
function served(url: string): ScriptResource {
  return { url, servedLength: null, sourceMap: null, fetchError: null };
}

/*
 * A one-line bundle whose map sends generated columns from 0 to the app's
 * source and from 50 to an ignore-listed library. `AAAAA` is generated
 * column 0 to source 0, 0:0, name 0; `kDCAAC` steps 50 columns, one source,
 * and one name. The original positions all fold to line 1, which is enough to
 * tell the two sources apart.
 */
const BUNDLE: ScriptResource = {
  url: 'http://localhost/assets/index.js',
  servedLength: null,
  sourceMap: {
    origin: { kind: 'external', url: 'index.js.map' },
    map: {
      version: 3,
      sources: ['src/App.tsx', 'node_modules/react/jsx-runtime.js'],
      names: ['App', 'jsx'],
      ignoreList: [1],
      mappings: 'AAAAA,kDCAAC',
    },
  },
  fetchError: null,
};

interface SampleSpec {
  readonly atMs: number;
  /** Leaf first, as `[resourceId, name, 1-based column]`, or `null` for no JavaScript. */
  readonly stack: readonly (readonly [number, string | null, number])[] | null;
}

function trace(
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

const EVERYTHING: SamplePopulation = {
  window: 'interaction',
  ranges: [{ kind: 'interval', fromMs: 0, toMs: 1000, end: 'inclusive' }],
};

/** The source-location subjects of a ranking, which is every subject this tier emits. */
function subjects(causes: readonly CandidateCause[]): FunctionSubject[] {
  return causes.flatMap((cause) =>
    cause.subject.kind === 'source-location' ? [cause.subject] : [],
  );
}

describe('attributeSampledFunctions', () => {
  it('charges library code to the innermost function the map does not ignore, and counts the fold', () => {
    const profile = resolveProfile(
      trace(
        [BUNDLE],
        [
          // `jsx` (ignore-listed) called from `App`: charged to `App`.
          {
            atMs: 10,
            stack: [
              [0, 'jsx', 51],
              [0, 'h', 1],
            ],
          },
          { atMs: 20, stack: [[0, 'h', 1]] },
          // Only library code on the stack: charged to its leaf.
          { atMs: 30, stack: [[0, 'jsx', 51]] },
          { atMs: 40, stack: null },
        ],
      ),
    );
    const result = attributeSampledFunctions(profile, PROVENANCE, EVERYTHING);

    expect(result).toMatchObject({
      samples: 4,
      samplesWithoutStack: 1,
      stackedSamples: 3,
    });
    expect(describeFunctionAttribution(result)).toContain('function-level attribution');
    const [app, library] = result.causes.causes;
    expect(app?.weight).toEqual({ fraction: 2 / 3, basis: 'sample-share' });
    expect(app?.tier).toBe('profiler-mapped');
    expect(app?.subject).toMatchObject({
      kind: 'source-location',
      granularity: 'function-definition',
      functionName: { text: 'App', from: 'source-map' },
      location: { file: 'src/App.tsx', throughSourceMap: true },
    });
    expect(app?.evidence).toEqual([
      {
        kind: 'profiler-samples',
        samples: 2,
        ofSamplesInWindow: 3,
        window: 'interaction',
      },
      { kind: 'ignore-listed-callees', samples: 1 },
    ]);
    expect(library?.subject).toMatchObject({
      functionName: { text: 'jsx', from: 'source-map' },
    });
    expect(library === undefined ? 0 : chargedSamples(library)).toBe(1);
  });

  it('never skips a frame no map vouches for as library code', () => {
    /*
     * The vendor case. `vendor.js` ships no map, so nothing says it is
     * library code, and its function is charged as itself rather than folded
     * into the first-party listener that called it. Folding it would report
     * the third party as having done nothing, which is the failure
     * `vendor-listener` exists to catch.
     */
    const profile = resolveProfile(
      trace(
        [served('http://localhost/app.js'), served('http://localhost/vendor.js')],
        [
          {
            atMs: 10,
            stack: [
              [1, 'vendorTrack', 43],
              [0, null, 35],
            ],
          },
        ],
      ),
    );
    const [only] = attributeSampledFunctions(profile, PROVENANCE, EVERYTHING).causes
      .causes;
    expect(only?.tier).toBe('profiler-unmapped');
    expect(only?.subject).toMatchObject({
      scriptUrl: 'http://localhost/vendor.js',
      functionName: { text: 'vendorTrack', from: 'served-script' },
      location: { throughSourceMap: false, whyNot: 'no-source-map' },
    });
  });

  it('counts a sample on a half-open boundary once, in the later range', () => {
    const profile = resolveProfile(
      trace([served('http://localhost/app.js')], [{ atMs: 50, stack: [[0, 'f', 1]] }]),
    );
    const slice = (fromMs: number, toMs: number): SamplePopulation => ({
      window: 'script-slice',
      ranges: [{ kind: 'interval', fromMs, toMs, end: 'exclusive' }],
    });
    expect(attributeSampledFunctions(profile, PROVENANCE, slice(40, 50)).samples).toBe(0);
    expect(attributeSampledFunctions(profile, PROVENANCE, slice(50, 60)).samples).toBe(1);
  });
});

describe('describeSourceLocation', () => {
  const location = (throughSourceMap: boolean) =>
    throughSourceMap
      ? ({
          file: 'OrderTable.tsx',
          position: { line: 36, column: 5 },
          throughSourceMap,
        } as const)
      : ({
          file: 'http://localhost/vendor.js',
          position: { line: 42, column: 41 },
          throughSourceMap,
          whyNot: 'no-source-map',
        } as const);

  it('words a callback as the call it was passed to, and never as a slow line', () => {
    const subject: FunctionSubject = {
      kind: 'source-location',
      location: location(true),
      granularity: 'function-definition',
      scriptUrl: 'http://localhost/src/OrderTable.tsx',
      functionName: null,
      enclosingCallToken: '.sort',
    };
    expect(describeSourceLocation(subject)).toBe(
      'OrderTable.tsx:36, in the callback passed to .sort',
    );
  });

  it('warns that an unmapped name and line are as the script was served', () => {
    const subject: FunctionSubject = {
      kind: 'source-location',
      location: location(false),
      granularity: 'function-definition',
      scriptUrl: 'http://localhost/vendor.js',
      functionName: { text: 'vendorTrack', from: 'served-script' },
      enclosingCallToken: null,
    };
    const said = describeSourceLocation(subject);
    expect(said).toMatch(
      /^http:\/\/localhost\/vendor\.js:42, in vendorTrack \(not through/,
    );
    expect(said).toContain('the script shipped no source map');
    expect(said).toContain('may be minified');
  });
});

describe('attributeScriptEntries', () => {
  function script(overrides: Partial<FrameScript>): FrameScript {
    return {
      startTimeMs: 0,
      durationMs: 10,
      executionStartMs: 0,
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

  function frame(startTimeMs: number): LongAnimationFrame {
    return {
      startTimeMs,
      durationMs: 60,
      blockingDurationMs: 10,
      firstUIEventTimestampMs: startTimeMs,
      renderingUpdate: { kind: 'none' },
      scripts: [
        script({ startTimeMs, durationMs: 20, sourceCharPosition: 100 }),
        script({
          startTimeMs: startTimeMs + 20,
          durationMs: 20,
          sourceCharPosition: 200,
        }),
      ],
      navigationId: 1,
    };
  }

  function signals(profile: ProfileTrace | null): CapturedSignals {
    return {
      provenance: PROVENANCE,
      frames: [frame(100), frame(300)],
      profile,
      react: { hookInstalled: false, commits: [], spans: [] },
      interactions: [],
    };
  }

  const resources = [
    served('http://localhost/app.js'),
    served('http://localhost/vendor.js'),
  ];
  const profile = trace(resources, [
    // Two clicks. The first listener runs first-party code, the second calls
    // into the vendor. The sample at 120 is on the boundary, and belongs to
    // the second listener's slice.
    {
      atMs: 105,
      stack: [
        [0, 'computeTotals', 10],
        [0, null, 90],
      ],
    },
    {
      atMs: 120,
      stack: [
        [1, 'vendorTrack', 43],
        [0, null, 95],
      ],
    },
    {
      atMs: 130,
      stack: [
        [1, 'vendorTrack', 43],
        [0, null, 95],
      ],
    },
    {
      atMs: 305,
      stack: [
        [0, 'computeTotals', 10],
        [0, null, 90],
      ],
    },
    { atMs: 325, stack: [[0, null, 95]] },
    {
      atMs: 330,
      stack: [
        [1, 'vendorTrack', 43],
        [0, null, 95],
      ],
    },
  ]);

  it('groups slices by the site LoAF named, across frames', () => {
    const entries = attributeScriptEntries(signals(profile), resolveProfile(profile));
    expect(entries.map((entry) => entry.site.sourceCharPosition)).toEqual([100, 200]);
    expect(entries.map((entry) => entry.slices.length)).toEqual([2, 2]);
    expect(entries.map((entry) => entry.durationMs)).toEqual([40, 40]);
  });

  it('flags the profiler naming a different script than LoAF did, with both named', () => {
    const [firstParty, vendor] = attributeScriptEntries(
      signals(profile),
      resolveProfile(profile),
    );
    expect(firstParty?.disagreement).toBeNull();
    expect(vendor?.disagreement).toEqual({
      loafScriptUrl: 'http://localhost/app.js',
      profilerScriptUrl: 'http://localhost/vendor.js',
      samplesElsewhere: 3,
    });
    expect(
      subjects(vendor?.profiler?.causes.causes ?? []).map((s) => s.scriptUrl),
    ).toEqual(['http://localhost/vendor.js', 'http://localhost/app.js']);
    if (vendor === undefined) throw new Error('no vendor entry');
    const said = describeScriptEntry(vendor);
    expect(said).toContain('LoAF named http://localhost/app.js at offset 200');
    expect(said).toContain('40.0ms (production, 4x CPU throttle');
    expect(said).toContain(
      '3 of 4 stacked samples in http://localhost/vendor.js:1, in vendorTrack',
    );
    expect(said).toContain('a different script');
  });

  it("reports LoAF's site alone when there is no profile", () => {
    const entries = attributeScriptEntries(signals(null), null);
    expect(entries.map((entry) => [entry.profiler, entry.disagreement])).toEqual([
      [null, null],
      [null, null],
    ]);
    const [first] = entries;
    expect(first === undefined ? '' : describeScriptEntry(first)).toContain(
      'no profile was captured',
    );
  });
});
