/**
 * LoAF's script entries against the profiler, against frames and profiles
 * built by hand.
 *
 * `packages/corpus` asserts the answers on the real captures, `vendor-listener`
 * above all. These are the rules underneath: how slices are grouped by the
 * site LoAF named, and how a disagreement about the script is recorded and
 * worded. Positions in the builders are not measurements.
 */

import { describe, expect, it } from 'vitest';

import type { FrameScript, LongAnimationFrame } from './loaf.ts';
import type { ProfileTrace } from './profiler.ts';
import {
  attributeScriptEntries,
  describeScriptEntry,
} from './script-entry-attribution.ts';
import type { CapturedSignals } from './signals.ts';
import { resolveProfile } from './source-map.ts';
import { PROVENANCE, served, subjects, trace } from './synthetic-profile.test-support.ts';

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
