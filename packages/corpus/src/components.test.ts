/**
 * The React tier, against the captured corpus.
 *
 * Step 3's three claims, each asserted per interaction against the fixture's
 * own ground truth:
 *
 * 1. Every interaction in `spans` names the components that rendered, with
 *    self times that sum to the commit's own total.
 * 2. `state-owner-self` names `StateOwner` from its commit alone, which is
 *    the only signal that saw it: no long frame surrounds it in the v0.3
 *    capture, and nothing here depends on whether one does.
 * 3. The production run degrades to the profiler tier and says so, rather than
 *    reporting nothing because `actualDuration` is null and the names are
 *    minified. Since step 4 the shipped source map gives the names back, so
 *    the tier it degrades to is `profiler-mapped`, and each component is
 *    checked against the source file and line its ground truth declares.
 *
 * Nothing here walks a fiber tree, subtracts a duration or counts samples by
 * hand: the engine does that, and these tests check its answer. Nothing here
 * counts long frames either, zero included: whether a 25ms render crosses
 * LoAF's 50ms threshold is the quantity a re-capture moves, so "no frame" for
 * `state-owner-self` is recorded in a comment, not asserted.
 *
 * Every figure quoted below is from the v0.3 re-capture, Chromium
 * 159.0.8154.6, 4x CPU throttle, with the build mode given. `spans` burns
 * wall-clock time, so its figures are the same at any throttle rate; see its
 * ground truth's `reproduction.throttleSensitivity`.
 */

import {
  type AttributedInteraction,
  attributeInteractionComponents,
  COARSENED_TIMING_TOLERANCE_MS,
  type CapturedSignals,
  type CommitAttribution,
  describeCommitBasis,
  didRender,
  exceedsCoarsenedTolerance,
  type RankedCauses,
} from '@frameblame/core';
import { describe, expect, it } from 'vitest';

import { loadGroundTruth } from './corpus.ts';
import { arrayAt, asArray, asString, get, numberAt, recordAt, stringAt } from './json.ts';
import { loadSignals } from './records.ts';

/** One row of `spans`' `expected.sequence`, as the React tier reads it. */
interface SequenceRow {
  readonly id: string;
  /** `componentsThatRender` minus `listedButBailedOut`. */
  readonly rendered: readonly string[];
  readonly givenASpan: readonly string[];
}

function sequenceOf(): SequenceRow[] {
  const truth = loadGroundTruth('spans');
  return arrayAt(truth, ['expected', 'sequence']).map((row, index) => {
    const path = ['expected', 'sequence', index];
    const names = (key: string): string[] => {
      const value = get(row, [key]);
      return value === undefined
        ? []
        : asArray(value, [...path, key]).map((name, at) => asString(name, [...path, key, at]));
    };
    const bailedOut = new Set(names('listedButBailedOut'));
    return {
      id: stringAt(row, ['id']),
      rendered: names('componentsThatRender').filter((name) => !bailedOut.has(name)),
      givenASpan: names('componentsGivenASpan'),
    };
  });
}

const SEQUENCE = sequenceOf();

/**
 * What every `spans` component burns in its render body: `BURN_MS = 25` in
 * `fixtures/spans/src/burn.ts`, declared in the ground truth as
 * `bug.declaredBurnMsPerComponent`. Wall-clock time, so the same at any
 * throttle rate.
 */
const BURN_MS = numberAt(loadGroundTruth('spans'), ['bug', 'declaredBurnMsPerComponent']);

/** The interaction's attribution, which must exist and have commits. */
function attributed(signals: CapturedSignals, label: string): AttributedInteraction {
  const result = attributeInteractionComponents(signals, label);
  if (result?.kind !== 'attributed') {
    throw new Error(`${label}: expected an attributed interaction, got ${String(result?.kind)}`);
  }
  return result;
}

/** The one commit an interaction in `spans` produces. */
function onlyCommit(result: AttributedInteraction): CommitAttribution {
  expect(result.commits).toHaveLength(1);
  return result.commits[0];
}

function namesOf(causes: RankedCauses): string[] {
  return causes.causes.flatMap((cause) =>
    cause.subject.kind === 'component' ? [cause.subject.name] : [],
  );
}

describe('spans/development: the React tier names what rendered', () => {
  const signals = loadSignals('spans', 'development');

  it('reads every row of the ground truth', () => {
    expect(SEQUENCE.map((row) => row.id)).toEqual(
      signals.interactions.map((interaction) => interaction.label),
    );
  });

  for (const row of SEQUENCE) {
    it(`${row.id}: names the components that rendered, with self times summing to the commit's total`, () => {
      const result = attributed(signals, row.id);
      const commit = onlyCommit(result);
      const { basis } = commit;

      expect(basis.tier).toBe('react-fiber-timings');
      if (basis.tier !== 'react-fiber-timings') return;
      expect(result.merged?.tier).toBe('react-fiber-timings');

      expect(new Set(namesOf(commit.causes))).toEqual(new Set(row.rendered));
      for (const cause of commit.causes.causes) {
        expect(cause.tier).toBe('react-fiber-timings');
        expect(cause.weight.basis).toBe('fiber-self-time-share');
      }

      /*
       * The self times telescope to the commit's own total: the top-level
       * fiber's `actualDuration`. Measured exactly equal on all five commits
       * (development, 4x): 139.5, 127.0, 25.2, 151.2 and 152.9ms. Nothing is
       * left over for bailed-out fibers, so the ranked weights sum to 1.
       */
      const { times } = basis;
      expect(exceedsCoarsenedTolerance(times.renderedSelfMs - times.totalMs)).toBe(false);
      expect(exceedsCoarsenedTolerance(times.bailedOutSelfMs)).toBe(false);
      expect(commit.notes).toEqual([]);
      expect(commit.causes.totalWeight).toBeCloseTo(1, 6);

      /*
       * The trap the subtraction exists for. Summing every fiber's
       * `actualDuration` counts each component once per ancestor: 243.3,
       * 227.4, 50.4, 277.2 and 280.3ms for these commits (development, 4x),
       * which is 1.7-2.0x the commit's real render time.
       */
      const naiveMs = times.fibers.reduce((sum, entry) => sum + entry.actualDurationMs, 0);
      expect(naiveMs).toBeGreaterThan(times.totalMs * 1.5);

      /*
       * The sum above is an identity: self times telescope to the total
       * whatever the subtraction charged to whom. This is the independent
       * oracle. Every component burns the same `BURN_MS`, so a rendered
       * fiber whose self time came out below it has had some of its own
       * render charged elsewhere. The smallest is 25.0ms, `StateOwner` in
       * `bump` (development, 4x).
       */
      for (const entry of times.fibers) {
        if (!didRender(entry.participation)) continue;
        expect(entry.selfMs).toBeGreaterThanOrEqual(BURN_MS - COARSENED_TIMING_TOLERANCE_MS);
      }

      /*
       * Spans corroborate and never decide. The candidates carrying one are
       * exactly the ones the gate admits, and the weights are what they are
       * with the spans removed from the input entirely.
       */
      const corroborated = commit.causes.causes.flatMap((cause) =>
        cause.subject.kind === 'component' &&
        cause.evidence.some((evidence) => evidence.kind === 'react-component-span')
          ? [cause.subject.name]
          : [],
      );
      expect(new Set(corroborated)).toEqual(new Set(row.givenASpan));

      const spanless = attributed({ ...signals, react: { ...signals.react, spans: [] } }, row.id);
      expect(spanless.commits[0].causes.causes.map((cause) => cause.weight)).toEqual(
        commit.causes.causes.map((cause) => cause.weight),
      );
    });
  }

  it('state-owner-self: names StateOwner from its commit alone', () => {
    const result = attributed(signals, 'state-owner-self');
    const commit = onlyCommit(result);

    /*
     * ~25ms of render is under LoAF's 50ms threshold, so in the v0.3 capture
     * no long frame surrounds this commit and none began in the interaction's
     * window (development, 4x). The commit is the only evidence, and the
     * answer is built from it alone. Whether a frame surrounds it is not
     * asserted: that is a long-frame count of zero, and the claim does not
     * depend on it.
     */

    /*
     * `StateOwner` holds all of the commit: 25.2ms (development, 4x). `App`
     * reads the same 25.2ms of subtree time with `PerformedWork` clear. React
     * bailed out of it, so it is in the commit, not a candidate.
     */
    const [top, ...rest] = commit.causes.causes;
    expect(top?.subject).toMatchObject({ kind: 'component', name: 'StateOwner' });
    expect(top?.weight.fraction).toBeCloseTo(1, 6);
    expect(rest).toEqual([]);

    const app = commit.components.find((component) => component.name === 'App');
    expect(app?.participation).toBe('bailed-out');
  });
});

describe('spans/production: the profiler tier, named as such', () => {
  const development = loadSignals('spans', 'development');
  const production = loadSignals('spans', 'production');

  /**
   * The production names of the components the ground truth says rendered,
   * by their position in the commit's fiber list. Both builds render the same
   * tree in the same walk order, so a development fiber's index is the join
   * between a declared name and its minified counterpart. The expected names
   * come from the ground truth's `rendered`, not from the engine's reading of
   * the development commit, so an engine that misread participation in both
   * builds the same way would still fail here. That join is a test-side
   * check, not something the engine does.
   */
  function productionNamesFor(row: SequenceRow): Set<string> {
    const dev = onlyCommit(attributed(development, row.id)).commit.components.fibers;
    const prod = onlyCommit(attributed(production, row.id)).commit.components.fibers;
    return new Set(
      row.rendered.flatMap((name) => {
        const indices = dev.flatMap((fiber, index) => (fiber.name === name ? [index] : []));
        if (indices.length === 0) {
          throw new Error(`${row.id}: no development fiber named ${name}`);
        }
        return indices.map((index) => {
          const counterpart = prod[index];
          if (counterpart === undefined) {
            throw new Error(`${row.id}: no production fiber at ${String(index)}`);
          }
          return counterpart.name;
        });
      }),
    );
  }

  /** Where the ground truth says each component is defined. */
  const DECLARED_SITES = new Map(
    arrayAt(loadGroundTruth('spans'), ['expected', 'components']).map((component) => [
      stringAt(component, ['name']),
      {
        fileName: stringAt(component, ['sourceFile']).split('/').pop() ?? '',
        line: numberAt(component, ['line']),
      },
    ]),
  );

  for (const row of SEQUENCE) {
    it(`${row.id}: degrades to the profiler tier and says so`, () => {
      const result = attributed(production, row.id);
      const commit = onlyCommit(result);

      // The precondition: the React tier's input is not there.
      for (const component of commit.commit.components.fibers) {
        expect(component.actualDurationMs).toBeNull();
      }

      const { basis } = commit;
      expect(basis.tier).toBe('profiler-mapped');
      if (basis.tier !== 'profiler-mapped') return;
      expect(basis.shortfall).toBe('fiber-timings-absent');
      expect(result.merged?.tier).toBe('profiler-mapped');

      const said = describeCommitBasis(basis);
      expect(said).toContain('degraded from');
      expect(said).toContain('actualDuration is null');
      expect(said).toContain('come from the source map');

      /*
       * Not an empty answer: every component the hook says rendered is a
       * candidate, weighted by its share of the samples in the commit's
       * window. 2 to 15 stacked samples per window (production, 4x), so
       * per-commit shares are coarse; the claim is the names, the sites and
       * the tier, not the percentages. Each weight must be above 0, though: a
       * candidate the stack join matched no sample to would be a name from
       * the hook alone, with no measurement behind it.
       *
       * The join still runs on the minified identifiers, which is what the
       * hook and the profiler share, so each candidate's `fiber-rendered`
       * evidence names a fiber the development join maps to a declared
       * component. The name the candidate carries is the source map's, and it
       * must be the declared one, defined at the declared file and line.
       */
      expect(commit.causes.causes.length).toBeGreaterThan(0);
      expect(new Set(namesOf(commit.causes))).toEqual(new Set(row.rendered));
      const minified = productionNamesFor(row);

      /*
       * Since step 5 the samples that reached no rendered component are in
       * the ranking as an explicit `unattributed` candidate, so the weights
       * sum to 1. `initial-mount` and `mount-toggle` have one, at 2 of 12 and
       * 1 of 14 independent samples (production, 4x); the other three
       * commits have none.
       */
      const remainders = commit.causes.causes.filter(
        (cause) => cause.subject.kind === 'unattributed',
      );
      expect(remainders.length).toBeLessThanOrEqual(1);
      for (const remainder of remainders) {
        expect(remainder.tier).toBe('unattributed');
        expect(remainder.subject).toEqual({
          kind: 'unattributed',
          reason: 'no-rendered-component-on-stack',
        });
      }
      expect(remainders.length).toBe(basis.unchargedSamples > 0 ? 1 : 0);
      expect(commit.causes.totalWeight).toBeCloseTo(1, 6);

      for (const cause of commit.causes.causes) {
        if (cause.subject.kind === 'unattributed') continue;
        expect(cause.tier).toBe('profiler-mapped');
        expect(cause.weight.basis).toBe('sample-share');
        expect(cause.weight.fraction).toBeGreaterThan(0);
        expect(cause.subject).toMatchObject({ kind: 'component', nameIsMinified: false });
        if (cause.subject.kind !== 'component') continue;

        const joinedOn = cause.evidence.flatMap((evidence) =>
          evidence.kind === 'fiber-rendered' ? [evidence.componentName] : [],
        );
        expect(joinedOn.length).toBeGreaterThan(0);
        for (const name of joinedOn) expect(minified).toContain(name);

        const declared = DECLARED_SITES.get(cause.subject.name);
        const site = cause.subject.definedAt;
        expect(declared, `no declared site for ${cause.subject.name}`).toBeDefined();
        expect(site?.throughSourceMap).toBe(true);
        expect(site?.file.endsWith(`/${declared?.fileName ?? ''}`)).toBe(true);
        expect(site?.position.line).toBe(declared?.line);
      }
      expect(commit.notes).toEqual([]);
    });
  }

  it('state-owner-self: names StateOwner, from its commit alone', () => {
    // No long frame surrounds the commit in the v0.3 capture (production,
    // 4x), and, as in development, that is not asserted.
    const result = attributed(production, 'state-owner-self');
    const commit = onlyCommit(result);

    // `g` in this bundle, named `StateOwner` by the map. Every stacked sample
    // in the window lands in it: 2 of 2 (production, 4x).
    expect(namesOf(commit.causes)).toEqual(['StateOwner']);
    expect(commit.causes.causes[0]?.weight.fraction).toBeGreaterThan(0.5);
  });
});

describe('derive-in-render: the React tier names the declared component', () => {
  const declared = stringAt(recordAt(loadGroundTruth('derive-in-render'), ['expected']), [
    'component',
  ]);

  it('development: the declared component carries most of the replay’s render time', () => {
    const result = attributed(loadSignals('derive-in-render', 'development'), 'replay');
    /*
     * Over the replay's 24 commits, `OrderTable` holds 98.9% of the self time
     * and `App`, which owns the state and is the fixture's declared wrong
     * answer, 1.1% (development, 4x).
     */
    expect(result.merged?.tier).toBe('react-fiber-timings');
    const [top] = result.merged?.causes.causes ?? [];
    expect(top?.subject).toMatchObject({ kind: 'component', name: declared });
    expect(top?.weight.fraction).toBeGreaterThan(0.9);
    for (const commit of result.commits) expect(commit.notes).toEqual([]);
  });

  it('production: so does the profiler, under the name the source map gives back', () => {
    const prod = attributed(loadSignals('derive-in-render', 'production'), 'replay');

    /*
     * `h` in this bundle, resolved through the shipped map to
     * `OrderTable.tsx:32:16` with the name `OrderTable`, holding 97.1% of the
     * 69 stacked samples in the replay's commit windows (production, 4x).
     */
    expect(prod.merged?.tier).toBe('profiler-mapped');
    const [top] = prod.merged?.causes.causes ?? [];
    expect(top?.subject).toMatchObject({ kind: 'component', name: declared, nameIsMinified: false });
    expect(top?.weight.fraction).toBeGreaterThan(0.6);
    if (top?.subject.kind !== 'component') return;
    expect(top.subject.definedAt?.throughSourceMap).toBe(true);
    expect(top.subject.definedAt?.file.endsWith('/OrderTable.tsx')).toBe(true);
    expect(top.subject.definedAt?.position.line).toBe(32);
  });
});
