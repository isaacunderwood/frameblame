/**
 * The profiler tier for lines, against profiles built by hand.
 *
 * `packages/corpus` asserts the tier's answers on the real captures. These
 * are the rules underneath, each on the smallest input that shows it: which
 * frame a sample is charged to, and what a population includes at its edges.
 * How a LoAF entry's registration site and the profiler's answer are kept
 * apart is `script-entry-attribution.test.ts`. Positions in the builders are
 * not measurements; figures quoted in comments are from the corpus, with
 * their build mode and throttle rate.
 */

import { describe, expect, it } from 'vitest';

import { describeTier } from './attribution.ts';
import {
  attributeSampledFunctions,
  chargedSamples,
  describeFunctionAttribution,
  describeSourceLocation,
  type FunctionSubject,
  type SamplePopulation,
} from './line-attribution.ts';
import type { ScriptResource } from './profiler.ts';
import { resolveProfile } from './source-map.ts';
import { PROVENANCE, served, trace } from './synthetic-profile.test-support.ts';

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

const EVERYTHING: SamplePopulation = {
  window: 'interaction',
  ranges: [{ kind: 'interval', fromMs: 0, toMs: 1000, end: 'inclusive' }],
};

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
    // Both candidates resolved through the map, so the unmapped tier, which
    // no candidate stands on, is not named.
    expect(describeFunctionAttribution(result)).toContain(
      describeTier('profiler-mapped'),
    );
    expect(describeFunctionAttribution(result)).not.toContain(
      describeTier('profiler-unmapped'),
    );
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
