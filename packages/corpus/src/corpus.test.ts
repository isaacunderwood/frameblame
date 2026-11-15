/**
 * Is the corpus intact, and is each ground truth still about its fixture?
 *
 * The questions underneath the accuracy suite, asked before it: every fixture
 * has a capture in both build modes, every file in a capture states the build
 * it was measured under, every line a ground truth declares still holds the
 * text it declares, and every tier a ground truth declares is one the engine
 * has. If any of these fails, an accuracy failure means nothing, so they live
 * apart from it and fail first in the report.
 *
 * What this file used to hold besides, and where it went. Until step 6 it
 * also checked each fixture's claim against the captured files with local
 * readers written for the purpose: a stack walk to the deepest first-party
 * frame, a partition of a frame's duration by summing its script entries, a
 * filter of samples by frame window and a filter of React's spans by prefix.
 * Those readers existed only so the corpus could be checked before the
 * engine's shape was decided, and they are deleted. Each claim is now asserted
 * through the engine:
 *
 * - The attribution claims, per fixture and build mode, in
 *   `accuracy.test.ts`, with the narrower step 3 and 4 views in
 *   `components.test.ts` and `lines.test.ts`.
 * - The claims about the raw signal — what LoAF reports in which field, what
 *   the fixture's own probe recorded, what a production build withholds — in
 *   `records.test.ts`, beside the readers that parse them.
 */

import { describe, expect, it } from 'vitest';

import {
  BUILD_MODES,
  envelopeOf,
  hasCorpusRun,
  listFixtures,
  loadCorpusRun,
  loadGroundTruth,
} from './index.ts';
import {
  checkSourceAnchor,
  checkTierDeclaration,
  collectSourceAnchors,
  collectTierDeclarations,
} from './ground-truth.ts';

const FIXTURES = listFixtures();

describe('the corpus', () => {
  it('holds at least the four promoted fixtures', () => {
    // Named rather than counted, so that adding a fixture does not fail this
    // and removing one of these does.
    expect(FIXTURES).toEqual(
      expect.arrayContaining([
        'derive-in-render',
        'innerhtml-rebuild',
        'spans',
        'vendor-listener',
      ]),
    );
  });

  for (const fixture of FIXTURES) {
    for (const mode of BUILD_MODES) {
      it(`covers ${fixture} in ${mode}`, () => {
        expect(
          hasCorpusRun(fixture, mode),
          `missing: recapture with \`pnpm spike:corpus ${fixture}\``,
        ).toBe(true);
      });
    }
  }

  for (const fixture of FIXTURES) {
    for (const mode of BUILD_MODES) {
      it(`${fixture}/${mode}: every file states the build it was measured under`, () => {
        const run = loadCorpusRun(fixture, mode);

        /*
         * The invariant this enforces is the project's loudest: a millisecond
         * figure quoted without its build mode and CPU throttle rate is
         * indefensible. Every one of the five files repeats the envelope so
         * that one of them read alone still carries it, and they must agree —
         * a mismatch would mean two captures had been mixed in one directory.
         */
        const envelopes = (['run', 'loaf', 'profile', 'react', 'sourceWindows'] as const).map(
          (key) => envelopeOf(run, key),
        );

        for (const envelope of envelopes) {
          expect(envelope.fixture).toBe(fixture);
          expect(envelope.mode).toBe(mode);
          expect(envelope.cpuThrottleRate).toBeGreaterThan(0);
          expect(envelope.buildMode).toContain(mode);
          expect(envelope.browser).toMatch(/^chromium \d/);
          expect(envelope.runId).toBe(envelopes[0]?.runId);
        }
      });
    }
  }
});

describe('ground truth', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture}: every declared line still contains its declared text`, () => {
      /*
       * Asserted before anything about the tool, because a drifted line number
       * fails as a wrong attribution rather than as a broken fixture — which
       * sends the next reader looking for a bug in the engine. See
       * `ground-truth.ts`.
       */
      const anchors = collectSourceAnchors(loadGroundTruth(fixture));
      expect(anchors.length, 'a ground truth with no anchored lines').toBeGreaterThan(0);

      const drifted = anchors.map(checkSourceAnchor).filter((issue) => issue !== null);
      expect(drifted.join('\n')).toBe('');
    });

    it(`${fixture}: declares the tier its claim is made at, in the engine's vocabulary`, () => {
      /*
       * The same reasoning for tiers. The accuracy suite asserts each
       * fixture's culprit at the tier its ground truth declares, so a
       * declaration naming no tier the engine has would fail there as a wrong
       * answer. And a fixture with no declaration at all would have nothing
       * to be attributed "at its declared tier" against.
       */
      const declarations = collectTierDeclarations(loadGroundTruth(fixture));
      expect(declarations.length, 'a ground truth that declares no tier').toBeGreaterThan(0);

      const malformed = declarations.map(checkTierDeclaration).filter((issue) => issue !== null);
      expect(malformed.join('\n')).toBe('');
    });
  }
});
