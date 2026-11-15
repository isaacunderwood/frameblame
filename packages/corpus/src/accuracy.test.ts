/**
 * The accuracy suite: every fixture, in both build modes, attributed by the
 * engine to its declared culprit at its declared tier, with the confidence the
 * evidence earns.
 *
 * Every assertion is made on what `attributeCapture` returns for a capture's
 * signals, and every expectation is read from the fixture's ground truth:
 * the culprit from its `expected` block, the tier from its `declaredTier`
 * (checked against the engine's vocabulary in `corpus.test.ts`). The
 * confidence levels are the engine's own rules under the step 5 decisions,
 * asserted as they stand; see `handoff.md`'s Questions for the morning.
 *
 * Per fixture and build mode:
 *
 * | fixture, mode              | culprit (ground truth)                           | tier                             | confidence |
 * | -------------------------- | ------------------------------------------------ | -------------------------------- | ---------- |
 * | derive-in-render, dev      | component `OrderTable` (`expected.component`)    | react-fiber-timings (undeclared) | high       |
 * | derive-in-render, prod     | component `OrderTable`                           | profiler-mapped (undeclared)     | moderate   |
 * | derive-in-render, both     | function on line 36, `.sort`, in 34-36           | profiler-mapped (`lineRange`)    | moderate   |
 * | spans, dev                 | per interaction, the components that rendered    | react-fiber-timings (declared)   | high       |
 * | spans, prod                | the same names, at their declared sites          | profiler-mapped (undeclared)     | low        |
 * | innerhtml-rebuild, both    | unforced: an unattributed share above the floor  | unattributed (declared)          | moderate   |
 * | innerhtml-rebuild, both    | forced: forced style and layout, to its script   | loaf-script-registration (decl.) | high       |
 * | vendor-listener, both      | three slices in declared rank, forced layout top | (no tier declared for the rank)  | high       |
 * | vendor-listener, both      | the vendor slice's owner, `vendorTrack`          | profiler-unmapped (declared)     | low        |
 *
 * "Undeclared" means the ground truth names the culprit but no tier for it;
 * the suite asserts the tier the engine's documented rule gives, and says so
 * beside the assertion. `handoff.md`'s "Step 6 — outcome" lists those gaps.
 *
 * Beyond the culprits, the suite asserts the step 5 claims that keep the
 * answer honest: confidence degrades rather than guesses where the evidence is
 * thin (a handful of samples yields a wide range and an unresolved lead, a
 * burst of samples counts once, and an answer may only be wrong where it says
 * it is unsure); `innerhtml-rebuild` reports a large unattributed share,
 * cross-checked against the profiler's empty stacks, rather than a confident
 * wrong answer; and each degradation tier the corpus cannot show, because
 * every capture has all three signals, is produced by removing a signal from
 * a real capture.
 *
 * The narrower views live beside this file: `components.test.ts` asserts the
 * React tier commit by commit, `lines.test.ts` the profiler tier's function
 * histogram and LoAF-against-profiler disagreements, and `records.test.ts` the
 * raw signal and the frame partition the engine starts from. The ground-truth
 * readings this file shares with them are in `test-support.ts`, so every file
 * compares the engine against the same declarations.
 *
 * Nothing here walks a stack, partitions a frame or counts samples by hand,
 * and nothing asserts how many long frames a capture or an interaction holds,
 * zero included: every assertion about frames is made of each frame the
 * engine returns, however many there are. Every figure quoted is from the
 * v0.3 re-capture, Chromium 159.0.8154.6, 4x CPU throttle, with the build mode
 * given.
 */

import {
  attributeCapture,
  attributeSampledFunctions,
  type CandidateCause,
  type CaptureAttribution,
  type CapturedSignals,
  COARSENED_TIMING_TOLERANCE_MS,
  type FrameAttribution,
  type FunctionAttribution,
  type InteractionAttribution,
  isLowerConfidence,
  longFramePopulation,
  type RankedCauses,
} from '@frameblame/core';
import { describe, expect, it } from 'vitest';

import { BUILD_MODES, type BuildMode, loadGroundTruth } from './corpus.ts';
import { declaredTierAt } from './ground-truth.ts';
import { arrayAt, numberAt, stringAt } from './json.ts';
import { loadSignals } from './records.ts';
import {
  componentNamesOf,
  deriveInRenderTruth,
  fileNameOf,
  resolvedProfileOf,
  spansTruth,
  vendorListenerTruth,
} from './test-support.ts';

/** The interaction with a label, which must be in the answer. */
function interactionOf(
  answer: CaptureAttribution,
  label: string,
): InteractionAttribution {
  const found = answer.interactions.find((each) => each.interaction.label === label);
  if (found === undefined) throw new Error(`no interaction labelled ${label}`);
  return found;
}

/** An interaction's function-level answer, which needs a profile. */
function functionsOf(interaction: InteractionAttribution): FunctionAttribution {
  if (interaction.functions.kind !== 'sampled') {
    throw new Error(`${interaction.interaction.label}: no function-level answer`);
  }
  return interaction.functions.attribution;
}

/** An interaction's merged component ranking, which needs commits at one tier. */
function mergedOf(interaction: InteractionAttribution): {
  readonly tier: string;
  readonly causes: RankedCauses;
} {
  const { components } = interaction;
  if (components.kind !== 'attributed' || components.merged === null) {
    throw new Error(`${interaction.interaction.label}: no merged component ranking`);
  }
  return components.merged;
}

/** The script entry a candidate was cut from, read off its evidence. */
function scriptIndexOf(cause: CandidateCause): number | null {
  for (const evidence of cause.evidence) {
    if (evidence.kind === 'loaf-script' || evidence.kind === 'forced-style-and-layout') {
      return evidence.scriptIndex;
    }
  }
  return null;
}

/** Fails a test that reached for a value it has no way to continue without. */
function absent(what: string): never {
  throw new Error(`expected ${what}`);
}

/** The line a function candidate is defined on, or `null` for any other subject. */
function definedOnLine(cause: CandidateCause | undefined): number | null {
  return cause?.subject.kind === 'source-location'
    ? cause.subject.location.position.line
    : null;
}

describe('derive-in-render: the declared component, and the declared function', () => {
  const { truth, component, fileName, lineRange, notAtFault } = deriveInRenderTruth();
  const { from, to } = lineRange;
  /**
   * The call a declared culprit line begins with, read off its
   * `expectedSourceText`: `.sort` for line 36's `.sort((a, b) => ...)`, and
   * `null` for a line that does not begin with one.
   */
  const callTokenOnLine = (line: number | null): string | null => {
    const declared = arrayAt(truth, ['expected', 'culpritLines']).find(
      (entry) => numberAt(entry, ['line']) === line,
    );
    if (declared === undefined) return null;
    return /^\.\w+/.exec(stringAt(declared, ['expectedSourceText']).trim())?.[0] ?? null;
  };

  it('development: the component is known, at high confidence, from fiber timings', () => {
    const answer = attributeCapture(loadSignals('derive-in-render', 'development'));
    expect(answer.workingFrom).toEqual([]);

    /*
     * Over the replay's commits `OrderTable` holds 98.9% of the measured self
     * time and `App`, the declared wrong answer, 1.1% (development, 4x). A
     * measurement, so the level is high and the lead is clear.
     *
     * The ground truth declares the component and no tier for it, so the
     * tier asserted here is the engine's rule, not the fixture's claim: in a
     * development build the hook's fiber timings name the component (step 5,
     * "the component is known, at high confidence, in development").
     */
    const replay = interactionOf(answer, 'replay');
    const merged = mergedOf(replay);
    const [top] = merged.causes.causes;
    expect(merged.tier).toBe('react-fiber-timings');
    expect(top?.subject).toMatchObject({ kind: 'component', name: component });
    expect(top?.tier).toBe('react-fiber-timings');
    expect(top?.weight.confidence.level).toBe('high');
    expect(top?.weight.confidence.support.kind).toBe('measured');
    expect(merged.causes.lead).toBe('clear');

    /*
     * And in each long frame the replay produced, the component is the top
     * cause of the frame itself: 71.5-94.1% of the frame's duration, measured,
     * with the rest of React's dispatcher entry at 1.5-12.1% (development,
     * 4x). `App` is a candidate at 0.2-2.2%, never within a tenth of it.
     */
    for (const frame of replay.frames) {
      const [first] = frame.causes.causes;
      expect(first?.subject).toMatchObject({ kind: 'component', name: component });
      expect(first?.tier).toBe('react-fiber-timings');
      expect(first?.weight.basis).toBe('fiber-self-time-share');
      expect(first?.weight.confidence.level).toBe('high');
      expect(frame.causes.lead).toBe('clear');
      expect(frame.causes.totalWeight).toBeCloseTo(1, 6);
      expect(frame.notes).toEqual([]);
      for (const cause of frame.causes.causes) {
        if (cause.subject.kind !== 'component') continue;
        if (!notAtFault.includes(cause.subject.name)) continue;
        expect(cause.weight.fraction).toBeLessThan((first?.weight.fraction ?? 0) / 10);
      }
    }
  });

  it('production: the component is sampled, under the name the source map gives back', () => {
    const answer = attributeCapture(loadSignals('derive-in-render', 'production'));

    // What a production build withholds is named once, for the whole answer.
    expect(answer.workingFrom).toEqual([{ kind: 'fiber-timings-absent' }]);

    /*
     * 67 of the 69 stacked samples in the replay's commit windows are in
     * `OrderTable`: 97.1%, with a 95% range of 90.0-99.2% (production, 4x).
     * An estimate over enough samples to be one, so moderate, never high.
     *
     * No tier is declared for the component, as in development: a production
     * build withholds fiber timings, and the engine's rule is to sample the
     * component under the name the shipped map gives back.
     */
    const merged = mergedOf(interactionOf(answer, 'replay'));
    const [top] = merged.causes.causes;
    expect(merged.tier).toBe('profiler-mapped');
    expect(top?.subject).toMatchObject({
      kind: 'component',
      name: component,
      nameIsMinified: false,
    });
    expect(top?.weight.confidence.level).toBe('moderate');
    expect(top?.weight.confidence.support.kind).toBe('sampled');
    expect(top?.weight.confidence.range.low).toBeGreaterThan(0.6);
    expect(merged.causes.lead).toBe('clear');
    // The samples that reached no component are an explicit remainder.
    expect(merged.causes.totalWeight).toBeCloseTo(1, 6);
  });

  for (const mode of BUILD_MODES) {
    it(`${mode}: the function is a distribution over the replay, with the declared line first`, () => {
      const answer = attributeCapture(loadSignals('derive-in-render', mode));
      const replay = functionsOf(interactionOf(answer, 'replay'));

      /*
       * The `.sort` comparator, defined on line 36: 62 of 96 stacked samples
       * in development, a 95% range of 54.6-73.4%, and 56 of 69 in
       * production, 70.4-88.6% (4x). The population is every sample in the
       * interaction's window, which LoAF's threshold does not choose.
       */
      const [top, second] = replay.causes.causes;
      expect(replay.population.window).toBe('interaction');
      expect(top?.tier).toBe(declaredTierAt(truth, lineRange.path, mode));
      const line = definedOnLine(top);
      const token = callTokenOnLine(line);
      expect(token).not.toBeNull();
      expect(top?.subject).toMatchObject({
        kind: 'source-location',
        granularity: 'function-definition',
        enclosingCallToken: token,
      });
      expect(line).toBeGreaterThanOrEqual(from);
      expect(line).toBeLessThanOrEqual(to);
      expect(
        top?.subject.kind === 'source-location'
          ? fileNameOf(top.subject.location.file)
          : '',
      ).toBe(fileName);

      // A stable estimate: enough samples for a usable range, and a first
      // candidate whose range clears the second's.
      expect(top?.weight.confidence.level).toBe('moderate');
      expect(replay.causes.lead).toBe('clear');
      expect(top?.weight.confidence.range.low).toBeGreaterThan(
        second?.weight.confidence.range.high ?? 1,
      );

      // The statement inside the function is not on offer, and the data says so.
      expect(answer.statementLevel).toBe('unavailable-in-page');
    });
  }
});

describe('spans: the components that rendered, per interaction and per frame', () => {
  const { truth, sequence, burnMs } = spansTruth();
  const acceptable = ['expected', 'acceptableAttribution'] as const;

  it('development: every rendered component, measured, with its share of the frame', () => {
    const answer = attributeCapture(loadSignals('spans', 'development'));
    expect(answer.workingFrom).toEqual([]);

    for (const row of sequence) {
      const interaction = interactionOf(answer, row.id);
      const merged = mergedOf(interaction);

      // The declared tier, at the confidence a measurement earns.
      const declared = declaredTierAt(truth, acceptable, 'development');
      expect(declared).not.toBeNull();
      expect(merged.tier).toBe(declared);
      expect(new Set(componentNamesOf(merged.causes.causes))).toEqual(
        new Set(row.rendered),
      );
      for (const cause of merged.causes.causes) {
        expect(cause.tier).toBe(declared);
        expect(cause.weight.confidence.level).toBe('high');
      }

      /*
       * "With their share of the frame": where the interaction produced a
       * long frame, each rendered component is a candidate of the frame at
       * 14.1-19.8% of its duration (development, 4x), and that share is its
       * own burn. `state-owner-self` produced none, and is attributed from
       * its commit alone.
       */
      for (const frame of interaction.frames) {
        const components = frame.causes.causes.filter(
          (cause) => cause.subject.kind === 'component',
        );
        expect(new Set(componentNamesOf(components))).toEqual(new Set(row.rendered));
        for (const cause of components) {
          expect(cause.tier).toBe(declared);
          expect(cause.weight.confidence.level).toBe('high');
          expect(cause.weight.fraction * frame.frame.durationMs).toBeGreaterThanOrEqual(
            burnMs - COARSENED_TIMING_TOLERANCE_MS,
          );
        }
        expect(frame.causes.totalWeight).toBeCloseTo(1, 6);
        expect(frame.notes).toEqual([]);
      }
    }
  });

  it('development: says when equal components cannot be ranked', () => {
    const answer = attributeCapture(loadSignals('spans', 'development'));

    /*
     * Six components each burn the same 25ms, so after `LateMount` mounts
     * their shares are 16.4-16.9% of the commit and closer together than the
     * timing grid can separate (development, 4x). The ranking says so rather
     * than presenting 0.1ms as an order.
     */
    /*
     * These two rows were chosen from the engine's output, not declared by
     * the ground truth. The other two multi-component rows lead clearly with
     * `App`, and neither is a real difference. In `initial-mount` `App` reads
     * 35.7ms of self time against 25.5-26.5ms for each other component,
     * because host-fiber time, the DOM it creates on mount, is charged to the
     * nearest component above it (step 3, review finding 1). In `bump` it
     * reads 26.6ms against 25.0-25.2ms, a margin too small to tell apart from
     * that same charge (development, 4x). So neither is asserted either way.
     */
    for (const id of ['mount-toggle', 'bump-again']) {
      expect(mergedOf(interactionOf(answer, id)).causes.lead).toBe('within-noise');
    }
    // One component holding the whole commit is the degenerate case.
    const alone = mergedOf(interactionOf(answer, 'state-owner-self')).causes;
    expect(alone.lead).toBe('sole');
    expect(componentNamesOf(alone.causes)).toEqual(['StateOwner']);
  });

  it('production: the same names from samples, at the confidence a handful of samples earns', () => {
    const answer = attributeCapture(loadSignals('spans', 'production'));
    expect(answer.workingFrom).toEqual([{ kind: 'fiber-timings-absent' }]);

    /*
     * The ground truth declares its tier for development only, and makes no
     * claim about what a production build degrades to. `profiler-mapped` is
     * the engine's rule (step 3's done-when): the hook's minified names are
     * joined to the profiler's samples, and the shipped map names them. That
     * each is the declared component at its declared site is asserted in
     * `components.test.ts`.
     */
    expect(declaredTierAt(truth, acceptable, 'production')).toBeNull();
    for (const row of sequence) {
      const merged = mergedOf(interactionOf(answer, row.id));
      expect(merged.tier).toBe('profiler-mapped');
      expect(new Set(componentNamesOf(merged.causes.causes))).toEqual(
        new Set(row.rendered),
      );

      /*
       * 2 to 14 independent samples per commit window (production, 4x). The
       * names, sites and tier are the claim; the shares are a ranked guess
       * and every one of them says so.
       */
      for (const cause of merged.causes.causes) {
        expect(cause.weight.confidence.level).toBe('low');
        expect(cause.weight.confidence.support.kind).toBe('sampled');
      }
      expect(merged.causes.lead).not.toBe('clear');
    }
  });
});

describe('innerhtml-rebuild: a large unattributed share, not a confident wrong answer', () => {
  const truth = loadGroundTruth('innerhtml-rebuild');
  const scenario = (label: string) => {
    const found = arrayAt(truth, ['scenarios']).find(
      (each) => stringAt(each, ['label']) === label,
    );
    if (found === undefined) throw new Error(`no scenario ${label}`);
    return found;
  };
  const floor = numberAt(scenario('unforced'), [
    'correctAttribution',
    'unattributedShareFloor',
  ]);
  const tierOf = (label: string, mode: BuildMode) =>
    declaredTierAt(scenario(label), ['correctAttribution'], mode);
  const agreement = numberAt(truth, [
    'expected',
    'unattributedCrossCheck',
    'agreementToleranceShare',
  ]);
  const culpritFrom = numberAt(truth, [
    'expected',
    'acceptableAttribution',
    'lineRange',
    'from',
  ]);
  const listener = {
    name: stringAt(truth, [
      'expected',
      'acceptableAttribution',
      'sampledListener',
      'function',
    ]),
    line: numberAt(truth, [
      'expected',
      'acceptableAttribution',
      'sampledListener',
      'line',
    ]),
  };

  /** How far apart the two signals' shares are, for a frame that was checked. */
  function signalsApartBy(frame: FrameAttribution): number {
    const { check } = frame.unattributed;
    if (check.verdict === 'unchecked') throw new Error('the frame was not cross-checked');
    return Math.abs(
      check.samplesWithoutStack / check.ofSamplesInFrame - check.shareOutsideScripts,
    );
  }

  for (const mode of BUILD_MODES) {
    it(`${mode}/unforced: most of the frame is unattributed, and two signals agree on it`, () => {
      const answer = attributeCapture(loadSignals('innerhtml-rebuild', mode));
      const { frames } = interactionOf(answer, 'unforced');
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        /*
         * 88.9-90.3% of each frame is unattributed, and 80.7-89.3% of the
         * frame is the one slice between the listener and the rendering
         * update (4x, both build modes). That slice is the top-ranked cause,
         * and it is a refusal to name one.
         */
        expect(frame.unattributed.fraction).toBeGreaterThanOrEqual(floor);
        const [top] = frame.causes.causes;
        expect(top?.tier).toBe(tierOf('unforced', mode));
        expect(top?.subject).toEqual({
          kind: 'unattributed',
          reason: 'outside-script-and-rendering-update',
        });

        /*
         * The cross-check: the profiler's empty-stack share is within 2.8
         * points of the share of the frame outside every script (4x, both
         * build modes), far inside the fixture's declared tolerance. Two
         * signals agreeing is what makes this a finding rather than a bare
         * subtraction. It is `moderate`, not `high`: each frame holds 9 to 12
         * independent samples, fewer than the 21 a sampled share needs to be
         * an estimate, so the agreement says the two are not far apart and no
         * more (`confidenceLevelOf`).
         */
        expect(frame.unattributed.check.verdict).toBe('agrees');
        expect(signalsApartBy(frame)).toBeLessThanOrEqual(agreement);
        for (const cause of frame.causes.causes) {
          if (cause.subject.kind !== 'unattributed') continue;
          expect(cause.weight.confidence.level).toBe('moderate');
          const { support } = cause.weight.confidence;
          if (support.kind !== 'subtraction') throw new Error('expected a subtraction');
          expect(support).toEqual({
            kind: 'subtraction',
            check: frame.unattributed.check,
            gridShare: support.gridShare,
          });
          // The timing grid over the frame, which is what the range widens by.
          expect(support.gridShare).toBeCloseTo(
            COARSENED_TIMING_TOLERANCE_MS / frame.frame.durationMs,
            12,
          );
          expect(cause.evidence.map((evidence) => evidence.kind)).toContain(
            'empty-stack-share',
          );
        }

        /*
         * What must not happen: the remainder shared out among the scripts
         * that happen to be visible. The largest named candidate is the
         * listener's own function at 9.7-11.1% of the frame, which is its
         * 13.4-15.8ms and no more (4x, both build modes), and it rests on
         * four samples and says so. It is the function the ground truth
         * points a human at, at function level: defined at or before the
         * first culprit line, which is the write it makes, not where it is
         * defined.
         */
        for (const cause of frame.causes.causes) {
          if (cause.subject.kind === 'unattributed') continue;
          expect(cause.weight.fraction).toBeLessThan(1 - floor);
          if (cause.subject.kind === 'source-location') {
            expect(cause.weight.confidence.level).toBe('low');
            expect(cause.subject.functionName?.text).toBe(listener.name);
            expect(definedOnLine(cause)).toBe(listener.line);
            expect(definedOnLine(cause)).toBeLessThanOrEqual(culpritFrom);
          }
        }
        expect(frame.causes.totalWeight).toBeCloseTo(1, 6);
      }
    });

    it(`${mode}/forced: the same work, forced inside the script, is charged to that script`, () => {
      const answer = attributeCapture(loadSignals('innerhtml-rebuild', mode));
      const { frames } = interactionOf(answer, 'forced');
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        /*
         * One `offsetHeight` read moves the work inside the listener, where
         * LoAF names it: forced style and layout is 72.4-75.6% of the frame
         * and the top-ranked cause (4x, both build modes). It is the script
         * entry's own figure, nested in the entry and charged to it.
         */
        const [top] = frame.causes.causes;
        expect(top?.subject).toMatchObject({
          kind: 'browser-work',
          what: 'forced-style-and-layout',
        });
        expect(top?.tier).toBe(tierOf('forced', mode));
        expect(top?.weight.confidence.level).toBe('high');
        const forcingScript =
          frame.frame.scripts[scriptIndexOf(top ?? absent('a top candidate')) ?? -1];
        expect(top?.subject).toMatchObject({
          forcedBy: { sourceCharPosition: forcingScript?.sourceCharPosition },
        });
        expect((top?.weight.fraction ?? 0) * frame.frame.durationMs).toBeCloseTo(
          forcingScript?.forcedStyleAndLayoutDurationMs ?? -1,
          6,
        );

        // Never added beside the script it happened inside: the frame is
        // still exactly accounted for.
        expect(frame.causes.totalWeight).toBeCloseTo(1, 6);

        /*
         * The unattributed share falls to 14.3-16.9%, and the empty-stack
         * share falls with it, to within 14.2 points (4x, both build modes).
         */
        expect(frame.unattributed.fraction).toBeLessThan(1 - floor);
        expect(frame.unattributed.check.verdict).toBe('agrees');
        expect(signalsApartBy(frame)).toBeLessThanOrEqual(agreement);
      }
    });
  }
});

describe('vendor-listener: three slices, and the vendor at the confidence its samples support', () => {
  const { truth, slices: declared } = vendorListenerTruth();

  for (const mode of BUILD_MODES) {
    it(`${mode}: ranks the three slices as declared, and names each one's true owner`, () => {
      const answer = attributeCapture(loadSignals('vendor-listener', mode));
      const { frames } = interactionOf(answer, 'three-listeners');
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        /** The frame's candidates cut from the script entry at a LoAF offset. */
        const ofSlice = (charPosition: number): CandidateCause[] =>
          frame.causes.causes.filter((cause) => {
            const index = scriptIndexOf(cause);
            return (
              index !== null &&
              frame.frame.scripts[index]?.sourceCharPosition === charPosition
            );
          });
        const shareOf = (charPosition: number): number =>
          ofSlice(charPosition).reduce((sum, cause) => sum + cause.weight.fraction, 0);

        /*
         * Three slices, not one cause: forced layout at 66.4-74.6% of the
         * frame, first-party compute at 11.8-13.5%, the vendor at 7.7-9.0%
         * (4x, both build modes). Ranked as the ground truth declares.
         */
        const byShare = [...declared].sort(
          (a, b) => shareOf(b.charPosition) - shareOf(a.charPosition),
        );
        expect(byShare.map((slice) => slice.expectedRank)).toEqual([1, 2, 3]);
        expect(frame.causes.causes[0]?.subject).toMatchObject({
          kind: 'browser-work',
          what: 'forced-style-and-layout',
        });
        // LoAF's own figure, a measurement: high, and not the whole frame.
        expect(frame.causes.causes[0]?.weight.confidence.level).toBe('high');
        expect(frame.causes.causes[0]?.weight.fraction).toBeLessThan(1);
        expect(frame.causes.totalWeight).toBeCloseTo(1, 6);

        // Each slice's largest function is the one the ground truth says owns it.
        for (const slice of declared) {
          const [owner] = ofSlice(slice.charPosition).filter(
            (cause) => cause.subject.kind === 'source-location',
          );
          expect(owner?.subject).toMatchObject({
            functionName: { text: slice.ownerFunction },
          });
          expect(definedOnLine(owner)).toBe(slice.ownerLine);
          expect(
            owner?.subject.kind === 'source-location'
              ? fileNameOf(owner.subject.scriptUrl)
              : '',
          ).toBe(slice.ownerFileName);
        }
      }
    });

    it(`${mode}: the vendor's share rests on independent samples, not on a burst`, () => {
      const answer = attributeCapture(loadSignals('vendor-listener', mode));
      const { frames } = interactionOf(answer, 'three-listeners');
      const vendor =
        declared.find((slice) => slice.isThirdParty) ?? absent('a third-party slice');

      for (const frame of frames) {
        const [candidate] = frame.causes.causes.filter(
          (cause) =>
            cause.subject.kind === 'source-location' &&
            fileNameOf(cause.subject.scriptUrl) === vendor.ownerFileName &&
            frame.frame.scripts[scriptIndexOf(cause) ?? -1]?.sourceCharPosition ===
              vendor.charPosition,
        );
        if (candidate === undefined) throw new Error('no vendor candidate');

        // The declared tier, and the warning that goes with no source map.
        expect(candidate.tier).toBe(
          declaredTierAt(truth, [...vendor.path, 'recoverableFrom'], mode),
        );
        expect(candidate.subject).toMatchObject({
          location: { throughSourceMap: false, whyNot: 'no-source-map' },
        });

        /*
         * The trace holds 13 stacked samples in the vendor's slices in
         * development and 14 in production, and 9 of them in each are one
         * burst on the first click (4x). As independent evidence that is 5
         * of 5 and 5.9 of 6. The weight is computed from those, and at that
         * count it is a guess: low, where 13 raw samples would have passed
         * for an estimate.
         */
        const { support } = candidate.weight.confidence;
        if (support.kind !== 'sampled') throw new Error('expected a sampled weight');
        const raw = candidate.evidence.flatMap((evidence) =>
          evidence.kind === 'profiler-samples' ? [evidence] : [],
        )[0];
        expect(support.ofIndependentSamples).toBeLessThan(raw?.ofSamplesInWindow ?? 0);
        expect(support.independentSamples).toBeLessThan(raw?.samples ?? 0);
        expect(candidate.weight.confidence.level).toBe('low');
        expect(candidate.weight.confidence.range.low).toBeLessThan(
          candidate.weight.fraction,
        );
      }
      expect(answer.workingFrom).toMatchObject([{ kind: 'source-map-absent' }]);
    });
  }
});

describe('thin evidence: the answer may only be wrong where it says it is unsure', () => {
  const { from, to } = deriveInRenderTruth().lineRange;

  for (const mode of BUILD_MODES) {
    it(`derive-in-render/${mode}: inside long frames, a top function outside the declared range is never claimed`, async (context) => {
      const { signals, resolved } = resolvedProfileOf('derive-in-render', mode);
      const inFrame = attributeSampledFunctions(
        resolved,
        signals.provenance,
        longFramePopulation(signals),
      );

      /*
       * The population LoAF's threshold chooses. In development it holds 59
       * stacked samples and the `.sort` comparator leads clearly, 39 of 59.
       * In production it holds 4, and the candidate in front is the
       * component's body on line 32 with 2 of them, which is not the declared
       * culprit (4x). The model's job there is not to be right. It is to say
       * that it does not know: the lead is within noise and every share is
       * low confidence, with a range of 15-85% on the one in front.
       *
       * Asserted as the rule rather than as those counts, which move with
       * how many presses cleared the threshold: wherever the answer claims a
       * clear lead at better than low confidence, its first candidate must be
       * inside the declared range.
       */
      const [top] = inFrame.causes.causes;
      const claimed =
        top !== undefined &&
        inFrame.causes.lead === 'clear' &&
        top.weight.confidence.level !== 'low';
      const line = definedOnLine(top);
      const correct = line !== null && line >= from && line <= to;
      await context.annotate(
        `${mode}, 4x: ${String(inFrame.stackedSamples)} stacked samples inside long frames; ` +
          `first candidate defined on line ${String(line)}, lead ${inFrame.causes.lead}, ` +
          `${top?.weight.confidence.level ?? 'no'} confidence`,
      );
      if (claimed) expect(correct).toBe(true);
      if (!correct) {
        expect(inFrame.causes.lead).not.toBe('clear');
        for (const cause of inFrame.causes.causes) {
          expect(cause.weight.confidence.level).toBe('low');
        }
      }
    });
  }

  it('derive-in-render/development: a frame with too few samples to compare is left unchecked, not called agreed', () => {
    const answer = attributeCapture(loadSignals('derive-in-render', 'development'));

    /*
     * `derive-in-render`'s frames last 57.1-66.7ms and hold 0 to 6 samples
     * (development, 4x). Below five, one sample moves a share by more than 20
     * points, so the unattributed share's cross-check is not attempted, and
     * its confidence is the lower one that subtraction alone earns. Where it
     * is attempted and agrees, five or six samples are too few for agreement to
     * make it `high`. A frame after the profiler's last sample, which LoAF
     * still reports, is outside the profile rather than short of samples, and
     * says so in a note.
     */
    for (const frame of answer.frames) {
      const { check } = frame.unattributed;
      const unattributed = frame.causes.causes.filter(
        (cause) => cause.subject.kind === 'unattributed',
      );
      for (const cause of unattributed) {
        expect(cause.weight.confidence.level).toBe('moderate');
      }
      if (check.verdict === 'unchecked') {
        expect(['too-few-samples', 'frame-outside-profile']).toContain(check.reason);
        expect(frame.notes.some((note) => note.kind === 'frame-outside-profile')).toBe(
          check.reason === 'frame-outside-profile',
        );
      } else {
        expect(check.ofSamplesInFrame).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe('degraded tiers: a real capture with one signal removed', () => {
  /** A capture's signals as they would be without `Document-Policy: js-profiling`. */
  function withoutProfile(signals: CapturedSignals): CapturedSignals {
    return { ...signals, profile: null };
  }

  /** Every unattributed candidate in a capture's frames. */
  function unattributedIn(answer: CaptureAttribution): CandidateCause[] {
    return answer.frames.flatMap((frame) =>
      frame.causes.causes.filter((cause) => cause.subject.kind === 'unattributed'),
    );
  }

  for (const mode of BUILD_MODES) {
    it(`no profiler, innerhtml-rebuild/${mode}: the unattributed share stands on subtraction alone, and says so`, () => {
      const signals = loadSignals('innerhtml-rebuild', mode);
      const full = attributeCapture(signals);
      const degraded = attributeCapture(withoutProfile(signals));

      expect(degraded.workingFrom).toContainEqual({ kind: 'profiler-absent' });
      expect(full.workingFrom).not.toContainEqual({ kind: 'profiler-absent' });

      // The same shares, because the partition needs no profiler.
      expect(degraded.frames.map((frame) => frame.unattributed.fraction)).toEqual(
        full.frames.map((frame) => frame.unattributed.fraction),
      );

      /*
       * And the reason in the data for every one of them: no second signal.
       * The level is `moderate` either way, because with the profile the
       * agreement rests on 9 to 12 in-frame samples, too few to make it `high`
       * (4x, both build modes); what is lost is the check itself, and the
       * level is never higher without it.
       */
      const before = unattributedIn(full);
      const after = unattributedIn(degraded);
      expect(after).toHaveLength(before.length);
      for (const [index, cause] of after.entries()) {
        const prior =
          before[index]?.weight.confidence ??
          absent('the same candidate with the profile');
        if (prior.support.kind !== 'subtraction')
          throw new Error('expected a subtraction');
        expect(prior.support.check.verdict).toBe('agrees');
        expect(cause.weight.confidence.support).toEqual({
          kind: 'subtraction',
          check: { verdict: 'unchecked', reason: 'no-profiler' },
          gridShare: prior.support.gridShare,
        });
        expect(cause.weight.confidence.level).toBe('moderate');
        expect(isLowerConfidence(prior.level, cause.weight.confidence.level)).toBe(false);
        expect(cause.evidence.map((evidence) => evidence.kind)).not.toContain(
          'empty-stack-share',
        );
      }

      // No function is named any more: the listener is the entry LoAF named.
      for (const frame of degraded.frames) {
        expect(
          frame.causes.causes.some((cause) => cause.subject.kind === 'source-location'),
        ).toBe(false);
        expect(
          frame.causes.causes.some(
            (cause) =>
              cause.subject.kind === 'script-entry' &&
              cause.tier === 'loaf-script-registration',
          ),
        ).toBe(true);
      }
      for (const interaction of degraded.interactions) {
        expect(interaction.functions).toEqual({
          kind: 'unavailable',
          reason: 'no-profiler',
        });
      }
    });
  }

  it('no profiler, vendor-listener: the vendor can no longer be named, and the tier says why', () => {
    const degraded = attributeCapture(
      withoutProfile(loadSignals('vendor-listener', 'development')),
    );

    /*
     * LoAF alone attributes all three slices to `app.js`, where the listeners
     * were registered. Without the profiler that is all there is, and the
     * answer says it is working from the registration site instead of
     * reporting a first-party frame as though it had looked.
     */
    for (const frame of degraded.frames) {
      const entries = frame.causes.causes.filter(
        (cause) => cause.subject.kind === 'script-entry',
      );
      expect(entries).toHaveLength(frame.frame.scripts.length);
      for (const entry of entries) {
        expect(entry.tier).toBe('loaf-script-registration');
        expect(entry.subject).toMatchObject({ scope: 'whole-entry' });
        expect(
          entry.subject.kind === 'script-entry'
            ? fileNameOf(entry.subject.site.sourceUrl ?? '')
            : '',
        ).toBe('app.js');
      }
      expect(JSON.stringify(frame.causes.causes)).not.toContain('vendor.js');
      expect(frame.causes.totalWeight).toBeCloseTo(1, 6);
    }
  });

  it('no profiler, derive-in-render/development: the component is still measured, and the function is gone', () => {
    const signals = loadSignals('derive-in-render', 'development');
    const degraded = attributeCapture(withoutProfile(signals));

    // Fiber timings never depended on the profiler.
    const replay = interactionOf(degraded, 'replay');
    const merged = mergedOf(replay);
    expect(merged.tier).toBe('react-fiber-timings');
    expect(merged.causes.causes[0]?.subject).toMatchObject({ name: 'OrderTable' });
    expect(merged.causes.causes[0]?.weight.confidence.level).toBe('high');
    expect(replay.functions.kind).toBe('unavailable');

    // What is left of each dispatcher entry is named as LoAF named it.
    for (const frame of replay.frames) {
      expect(frame.causes.causes[0]?.subject).toMatchObject({ name: 'OrderTable' });
      expect(
        frame.causes.causes.find((cause) => cause.subject.kind === 'script-entry')
          ?.subject,
      ).toMatchObject({
        scope: 'outside-component-renders',
        site: { sourceFunctionName: 'dispatchDiscreteEvent' },
      });
      expect(frame.unattributed.check).toEqual({
        verdict: 'unchecked',
        reason: 'no-profiler',
      });
    }
  });

  it('no profiler, derive-in-render/production: components are named from the overlap and given no share', () => {
    const degraded = attributeCapture(
      withoutProfile(loadSignals('derive-in-render', 'production')),
    );
    expect(degraded.workingFrom).toEqual([
      { kind: 'profiler-absent' },
      { kind: 'fiber-timings-absent' },
    ]);

    /*
     * No timings and no samples: the hook says which components rendered in
     * each commit, under their minified names, and nothing measured them. The
     * whole of every commit is one unattributed candidate with those names as
     * its evidence, at the confidence of a subtraction nothing checked.
     */
    const merged = mergedOf(interactionOf(degraded, 'replay'));
    expect(merged.tier).toBe('unattributed');
    const [whole, ...others] = merged.causes.causes;
    expect(others).toEqual([]);
    expect(whole?.subject).toEqual({ kind: 'unattributed', reason: 'no-profiler' });
    expect(whole?.weight.fraction).toBe(1);
    expect(whole?.weight.confidence.level).toBe('moderate');
    expect(whole?.evidence.every((evidence) => evidence.kind === 'fiber-rendered')).toBe(
      true,
    );

    /*
     * In a frame a commit landed in, the script entry keeps its measured
     * time at the registration tier, and the commit's components are on its
     * evidence: inferred from the overlap, named, and not weighed.
     */
    for (const frame of degraded.frames) {
      if (frame.commits.length === 0) continue;
      const entry = frame.causes.causes.find(
        (cause) => cause.subject.kind === 'script-entry',
      );
      expect(entry?.tier).toBe('loaf-script-registration');
      expect(entry?.evidence.map((evidence) => evidence.kind)).toContain(
        'fiber-rendered',
      );
      expect(
        frame.causes.causes.some((cause) => cause.subject.kind === 'component'),
      ).toBe(false);
    }
  });

  it('no React hook, derive-in-render/development: source-level attribution, from the profiler', () => {
    const signals = loadSignals('derive-in-render', 'development');
    const degraded = attributeCapture({
      ...signals,
      react: { hookInstalled: false, commits: [], spans: [] },
    });

    expect(degraded.workingFrom).toEqual([{ kind: 'react-hook-absent' }]);
    const replay = interactionOf(degraded, 'replay');
    expect(replay.components).toMatchObject({
      kind: 'no-commit',
      reason: 'react-hook-absent',
    });

    /*
     * No component can be named, so each frame's script is divided among the
     * functions the profiler saw, pooled over the replay's frames: 59 stacked
     * samples, 39 of them in the `.sort` comparator (development, 4x). The
     * pool names the function; each frame's own slice holds 3 to 6 of those
     * samples, so how that frame split is a guess, and the level is `low`.
     */
    for (const frame of replay.frames) {
      const [top] = frame.causes.causes;
      expect(top?.tier).toBe('profiler-mapped');
      expect(top?.weight.basis).toBe('frame-slice-sample-share');
      expect(top?.subject).toMatchObject({
        kind: 'source-location',
        enclosingCallToken: '.sort',
      });
      expect(definedOnLine(top)).toBe(36);
      expect(top?.weight.confidence.level).toBe('low');
      expect(top?.weight.confidence.support).toMatchObject({
        kind: 'sampled',
        ofIndependentSamples: 59,
      });
      expect(
        frame.causes.causes.some((cause) => cause.subject.kind === 'component'),
      ).toBe(false);
    }
    expect(definedOnLine(functionsOf(replay).causes.causes[0])).toBe(36);
  });

  it('no source map, derive-in-render/production: a minified name, with the warning', () => {
    const signals = loadSignals('derive-in-render', 'production');
    if (signals.profile === null) throw new Error('no profile');
    const degraded = attributeCapture({
      ...signals,
      profile: {
        ...signals.profile,
        resources: signals.profile.resources.map((resource) => ({
          ...resource,
          sourceMap: null,
        })),
      },
    });

    expect(degraded.workingFrom).toMatchObject([
      { kind: 'fiber-timings-absent' },
      { kind: 'source-map-absent' },
    ]);

    /*
     * The same samples, so the same shares, under the names the bundle
     * shipped: `h` where the map would have said `OrderTable`, at the
     * unmapped tier, with the position in generated code and the reason no
     * map applied.
     */
    const merged = mergedOf(interactionOf(degraded, 'replay'));
    const [top] = merged.causes.causes;
    expect(merged.tier).toBe('profiler-unmapped');
    expect(top?.tier).toBe('profiler-unmapped');
    expect(top?.subject).toMatchObject({
      kind: 'component',
      name: 'h',
      nameIsMinified: true,
      definedAt: { throughSourceMap: false, whyNot: 'no-source-map' },
    });

    const withMap = mergedOf(interactionOf(attributeCapture(signals), 'replay')).causes
      .causes[0];
    expect(top?.weight.fraction).toBe(withMap?.weight.fraction);

    const [topFunction] = functionsOf(interactionOf(degraded, 'replay')).causes.causes;
    expect(topFunction?.tier).toBe('profiler-unmapped');
    expect(topFunction?.subject).toMatchObject({
      location: { throughSourceMap: false, whyNot: 'no-source-map' },
    });
  });
});
