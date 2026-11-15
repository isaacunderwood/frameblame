/**
 * The entry point, against captures built by hand.
 *
 * `packages/corpus` asserts what `attributeCapture` says about the real
 * captures. These are the two things it adds to the modules beneath it: that
 * it answers whatever signals are missing, naming each absence, and that it
 * lays the per-frame and per-interaction answers side by side without losing
 * a commit or a frame between them. Durations in the builders are not
 * measurements.
 */

import { describe, expect, it } from 'vitest';

import { attributeCapture, describeDegradation } from './capture-attribution.ts';
import {
  capture,
  commit,
  fiber,
  paintedFrame,
  script,
} from './synthetic-capture.test-support.ts';
import { served, trace } from './synthetic-profile.test-support.ts';

const frame = paintedFrame(1000, 60, [script({ startTimeMs: 1002, durationMs: 56 })], 59);
const click = { label: 'click', kind: 'click', fromMs: 990, toMs: 1100, actions: [] };

describe('attributeCapture', () => {
  it('answers with every signal missing but the frames, and says what was missing', () => {
    const answer = attributeCapture(capture({ frames: [frame], interactions: [click] }));

    expect(answer.workingFrom).toEqual([
      { kind: 'profiler-absent' },
      { kind: 'react-hook-absent' },
    ]);
    for (const degradation of answer.workingFrom) {
      expect(describeDegradation(degradation).length).toBeGreaterThan(20);
    }

    // The frame is still partitioned and still attributed, at the tier that
    // needs nothing but LoAF.
    const [only] = answer.frames;
    expect(only?.causes.totalWeight).toBeCloseTo(1, 10);
    expect(only?.causes.causes[0]?.tier).toBe('loaf-script-registration');

    const [interaction] = answer.interactions;
    expect(interaction?.frames).toEqual(answer.frames);
    expect(interaction?.functions).toEqual({
      kind: 'unavailable',
      reason: 'no-profiler',
    });
    expect(interaction?.components).toMatchObject({
      kind: 'no-commit',
      reason: 'react-hook-absent',
    });
  });

  it('says a statement is out of reach, whatever was captured', () => {
    expect(attributeCapture(capture({})).statementLevel).toBe('unavailable-in-page');
  });

  it('names missing fiber timings and missing source maps as what they are', () => {
    const answer = attributeCapture(
      capture({
        frames: [frame],
        interactions: [click],
        profile: trace(
          [served('http://localhost/app.js')],
          [{ atMs: 1020, stack: [[0, 'h', 10]] }],
        ),
        react: {
          hookInstalled: true,
          spans: [],
          commits: [commit([fiber(0, 'h', null, null)], 1056)],
        },
      }),
    );

    expect(answer.workingFrom).toEqual([
      { kind: 'fiber-timings-absent' },
      { kind: 'source-map-absent', scriptUrls: ['http://localhost/app.js'] },
    ]);

    // The function level is the interaction's samples, at the unmapped tier.
    const [interaction] = answer.interactions;
    expect(interaction?.functions.kind).toBe('sampled');
    if (interaction?.functions.kind !== 'sampled') return;
    const [top] = interaction.functions.attribution.causes.causes;
    expect(top?.tier).toBe('profiler-unmapped');
    expect(interaction.functions.attribution.population.window).toBe('interaction');
  });

  it('degrades nothing when nothing is missing', () => {
    const answer = attributeCapture(
      capture({
        react: {
          hookInstalled: true,
          spans: [],
          commits: [commit([fiber(0, 'App', null, 20)], 1056)],
        },
        interactions: [click],
      }),
    );
    // No profile is a degradation; timings present and a hook present are not.
    expect(answer.workingFrom).toEqual([{ kind: 'profiler-absent' }]);
  });

  it('keeps a commit that no interaction and no frame contains', () => {
    // A commit is evidence on its own: one before the drive began is still
    // attributed, and is the same object wherever it is listed.
    const stray = commit([fiber(0, 'Early', null, 20)], 500);
    const inside = commit([fiber(0, 'App', null, 30)], 1040);
    const answer = attributeCapture(
      capture({
        frames: [frame],
        interactions: [click],
        react: { hookInstalled: true, spans: [], commits: [stray, inside] },
      }),
    );

    expect(answer.commits.map((each) => each.commit)).toEqual([stray, inside]);
    expect(answer.commits[0]?.frame).toBeNull();
    expect(answer.commits[0]?.causes.causes[0]?.subject).toMatchObject({ name: 'Early' });

    const [interaction] = answer.interactions;
    expect(interaction?.components.kind).toBe('attributed');
    if (interaction?.components.kind !== 'attributed') return;
    expect(interaction.components.commits[0]).toBe(answer.commits[1]);
    expect(answer.frames[0]?.commits).toEqual([answer.commits[1]]);
  });
});
