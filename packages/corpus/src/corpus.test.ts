/**
 * Does the corpus support the claims the fixtures declare?
 *
 * This is not the accuracy suite. The accuracy suite — step 4 — asks whether
 * the *engine* attributes each fixture's frames to its declared culprit. These
 * tests ask the question underneath it: is the captured evidence faithful, is
 * each fixture still the app its ground truth describes, and do the four
 * findings these fixtures were promoted to make actually reproduce from files
 * in this repo with no browser running?
 *
 * That ordering is deliberate. `findings.md` records that three of the v0.1
 * spike's conclusions were reversed on review, and that the evidence for
 * several of the surviving ones could not be re-run at all. An engine built
 * against a corpus nobody had checked would be the same mistake with more code
 * on top.
 *
 * **The readers in this file are deliberately local and deliberately
 * throwaway.** Walking a sample's stack to its deepest first-party frame, or
 * partitioning a frame's duration, is the engine's job, and doing it here is
 * duplication with a short life: when `packages/core` grows the join, these
 * helpers should be deleted and these tests rewritten against it. They exist
 * only so that the corpus can be checked *before* the engine's shape is
 * decided, which is the one thing that cannot be done afterwards.
 *
 * Every threshold asserted below is loose on purpose, and the comment beside it
 * says what was measured and why the margin is what it is. A suite that
 * asserted the measured value to the millisecond would fail on the next warm
 * machine and teach everyone to ignore it.
 */

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { createScriptLineIndex, lineColumnAt } from '@frameblame/core';
import { describe, expect, it } from 'vitest';

import {
  BUILD_MODES,
  type CorpusRun,
  envelopeOf,
  hasCorpusRun,
  type Json,
  type JsonObject,
  listFixtures,
  loadCorpusRun,
  loadGroundTruth,
  readRepoFile,
} from './index.ts';
import { checkSourceAnchor, collectSourceAnchors } from './ground-truth.ts';
import { arrayAt, asNumber, asRecord, asString, get, numberAt, recordAt } from './json.ts';

const FIXTURES = listFixtures();

// --- local, throwaway readers ----------------------------------------------

/** The LoAF entries of a run, as the flat `toJSON` records Chrome produced. */
function longFrames(run: CorpusRun): JsonObject[] {
  return arrayAt(run.files.loaf, ['entries']).map((entry, index) =>
    // Navigated from the entry; the path is passed only so a failure names
    // where in the file it was.
    asRecord(get(entry, ['toJSON']), ['entries', index, 'toJSON']),
  );
}

/** The script attributions of the nth LoAF entry. */
function scriptsOfFrame(run: CorpusRun, index: number): JsonObject[] {
  return arrayAt(run.files.loaf, ['entries', index, 'scripts']).map((script, i) =>
    asRecord(script, ['entries', index, 'scripts', i]),
  );
}

interface TraceView {
  readonly resources: readonly string[];
  readonly frames: readonly JsonObject[];
  readonly stacks: readonly JsonObject[];
  readonly samples: readonly JsonObject[];
}

function traceOf(run: CorpusRun): TraceView {
  const base = ['profile', 'trace'] as const;
  return {
    resources: arrayAt(run.files.profile, [...base, 'resources']).map((url, i) =>
      asString(url, [...base, 'resources', i]),
    ),
    frames: arrayAt(run.files.profile, [...base, 'frames']).map((frame, i) =>
      asRecord(frame, [...base, 'frames', i]),
    ),
    stacks: arrayAt(run.files.profile, [...base, 'stacks']).map((stack, i) =>
      asRecord(stack, [...base, 'stacks', i]),
    ),
    samples: arrayAt(run.files.profile, [...base, 'samples']).map((sample, i) =>
      asRecord(sample, [...base, 'samples', i]),
    ),
  };
}

/** Source maps captured with the run, keyed by the URL they describe. */
function sourceMapsOf(run: CorpusRun): Map<string, TraceMap> {
  const maps = new Map<string, TraceMap>();
  const sources = recordAt(run.files.profile, ['resourceSources']);

  for (const [url, source] of Object.entries(sources)) {
    const map = get(source, ['sourceMap']);
    if (map === null || map === undefined) continue;
    // Handed over as text because `TraceMap` accepts a JSON string, which
    // avoids casting loosely-typed parsed JSON into its input type.
    maps.set(url, new TraceMap(JSON.stringify(map)));
  }

  return maps;
}

/** Whether a timestamp falls inside any of the run's long frames. */
function inAnyFrame(frames: readonly JsonObject[], timestamp: number): boolean {
  return frames.some((frame) => {
    const start = asNumber(frame.startTime, ['startTime']);
    return timestamp >= start && timestamp <= start + asNumber(frame.duration, ['duration']);
  });
}

/**
 * Walks a sample's stack from the leaf outwards and returns the original line
 * of the deepest frame that maps into a file matching `sourceMatches`.
 *
 * Deepest-first because the leaf is where the time was actually spent. The
 * profiler's `line` and `column` are both 1-based and a source map's column is
 * 0-based, which is the minus one below and the single most likely place for
 * this to be silently wrong.
 */
function deepestOriginalLine(
  trace: TraceView,
  maps: ReadonlyMap<string, TraceMap>,
  stackId: number,
  sourceMatches: (source: string) => boolean,
): number | null {
  let current: number | undefined = stackId;

  while (current !== undefined) {
    /*
     * Both annotations in this loop are load-bearing rather than decorative.
     * Without them TypeScript infers `current` from `parentId`, which is read
     * out of a `stack` indexed by `current` — a circular inference it resolves
     * to `any` (TS7022), which would silently turn the whole stack walk
     * unchecked.
     */
    const stack: JsonObject | undefined = trace.stacks[current];
    if (!stack) return null;

    const frame = trace.frames[asNumber(stack.frameId, ['frameId'])];
    if (!frame) return null;

    const resourceId = frame.resourceId;
    const line = frame.line;
    if (typeof resourceId === 'number' && typeof line === 'number') {
      const url = trace.resources[resourceId];
      const map = url === undefined ? undefined : maps.get(url);
      if (map) {
        const column = typeof frame.column === 'number' ? frame.column : 1;
        const original = originalPositionFor(map, { line, column: column - 1 });
        if (original.source !== null && sourceMatches(original.source)) {
          return original.line;
        }
      }
    }

    const parentId: Json | undefined = stack.parentId;
    current = typeof parentId === 'number' ? parentId : undefined;
  }

  return null;
}

/** Samples inside a long frame, split by whether any JS was on the stack. */
function inFrameSamples(run: CorpusRun): {
  readonly withStack: readonly number[];
  readonly emptyCount: number;
  readonly total: number;
} {
  const frames = longFrames(run);
  const trace = traceOf(run);
  const withStack: number[] = [];
  let emptyCount = 0;

  for (const sample of trace.samples) {
    if (!inAnyFrame(frames, asNumber(sample.timestamp, ['timestamp']))) continue;
    const stackId = sample.stackId;
    if (typeof stackId === 'number') withStack.push(stackId);
    else emptyCount += 1;
  }

  return { withStack, emptyCount, total: withStack.length + emptyCount };
}

/**
 * Component spans only.
 *
 * React emits two kinds of `performance.measure`: phase markers like `Update`,
 * `Mount` and `Update Blocked`, and one span per component — and it prefixes
 * the component ones with a zero-width space, which is how they can be told
 * apart at all. Written as an escape rather than a literal, because an
 * invisible character in a comparison is the kind of thing that survives
 * review and then costs an afternoon.
 */
const COMPONENT_SPAN_PREFIX = '​';

function componentSpanNames(run: CorpusRun, from: number, to: number): string[] {
  return arrayAt(run.files.react, ['measures'])
    .map((measure, index) => asRecord(measure, ['measures', index]))
    .filter((measure) => {
      const start = asNumber(measure.startTime, ['startTime']);
      return start >= from && start <= to;
    })
    .map((measure) => asString(measure.name, ['name']))
    .filter((name) => name.startsWith(COMPONENT_SPAN_PREFIX))
    .map((name) => name.slice(COMPONENT_SPAN_PREFIX.length));
}

/** The drive steps of a run, as recorded by the driver. */
function stepsOf(run: CorpusRun): JsonObject[] {
  return arrayAt(run.files.run, ['steps']).map((step, index) =>
    asRecord(step, ['steps', index]),
  );
}

/**
 * The stack ids of samples taken inside any drive step, whether or not a long
 * frame was reported around them.
 *
 * The population to use when the claim is about the interaction rather than
 * about a frame LoAF happened to report: it does not depend on how many
 * interactions cleared the 50ms threshold, which is the long-frame count no
 * suite may assert on.
 */
function inStepSamples(run: CorpusRun): number[] {
  const windows = stepsOf(run).map((step) => ({
    from: asNumber(step.startedAtPageClock, ['startedAtPageClock']),
    to: asNumber(step.endedAtPageClock, ['endedAtPageClock']),
  }));

  return traceOf(run).samples.flatMap((sample) => {
    const timestamp = asNumber(sample.timestamp, ['timestamp']);
    const stackId = sample.stackId;
    const inStep = windows.some(({ from, to }) => timestamp >= from && timestamp <= to);
    return inStep && typeof stackId === 'number' ? [stackId] : [];
  });
}

// --- the corpus itself ------------------------------------------------------

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

// --- ground truth against the source it describes ---------------------------

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
  }
});

// --- the claims the fixtures were promoted to make --------------------------

describe('derive-in-render: the profiler names the declared culprit', () => {
  for (const mode of BUILD_MODES) {
    it(`${mode}: most sampled lines fall in the declared culprit range`, () => {
      const run = loadCorpusRun('derive-in-render', mode);
      const groundTruth = loadGroundTruth('derive-in-render');
      const from = numberAt(groundTruth, [
        'expected',
        'acceptableAttribution',
        'lineRange',
        'from',
      ]);
      const to = numberAt(groundTruth, [
        'expected',
        'acceptableAttribution',
        'lineRange',
        'to',
      ]);

      const trace = traceOf(run);
      const maps = sourceMapsOf(run);
      const histogram = new Map<number, number>();

      /*
       * Every sample taken during the replay, not only those inside a long
       * frame. This test counted in-frame samples until the v0.3 re-capture,
       * where the run's own `sawNewFrame` says LoAF reported a frame after 2 of
       * production's 24 presses (5 of 24 in the capture before), leaving 3
       * in-frame samples that resolved into OrderTable.tsx. The source map, the
       * bundle (the same `index-FhbDr_RJ.js` in both captures) and the profiler
       * start (before the drive in both) were unchanged, and 67 of the replay's
       * 69 stacked samples still resolved there — so what collapsed was the
       * number of presses that cleared LoAF's 50ms threshold, and an in-frame
       * floor was an assertion on the long-frame count by another name. The
       * claim is about what each keystroke spent its time on, and the profiler
       * sees that whether or not the trigger fired.
       */
      for (const stackId of inStepSamples(run)) {
        const line = deepestOriginalLine(trace, maps, stackId, (source) =>
          source.includes('OrderTable'),
        );
        if (line !== null) histogram.set(line, (histogram.get(line) ?? 0) + 1);
      }

      const total = [...histogram.values()].reduce((sum, count) => sum + count, 0);
      expect(total, 'no sample resolved into OrderTable.tsx').toBeGreaterThan(10);

      const inRange = [...histogram.entries()]
        .filter(([line]) => line >= from && line <= to)
        .reduce((sum, [, count]) => sum + count, 0);

      /*
       * Measured over the replay in the v0.3 re-capture (4x): 70.7% of 92
       * OrderTable samples in the declared range 34-36 in development, and
       * 83.6% of 67 in production. Over the capture before it the same
       * population gave 60.8% of 102 and 86.3% of 80 — the development figure
       * is the thinnest margin this floor has seen. In-frame only, which is
       * what `findings.md` quotes, the two captures gave 68.9% of 61 then 71.4%
       * of 56 in development, and 93.3% of 15 then 33.3% of 3 in production,
       * where three samples is no distribution at all. Asserted at 60%
       * because the quantity is a sampling distribution over a 12-15ms
       * cadence, and the lines outside the range are real render work rather
       * than error: line 32 is the component declaration, reached when a
       * sample lands in the sort but not in the comparator, and line 49 is the
       * row-rendering `.map`.
       */
      expect(inRange / total).toBeGreaterThan(0.6);

      // The single most-sampled line is the declared dominant cost. This is
      // the claim the project exists to make, and over the replay it held in
      // both builds of both captures it was measured on. It is not stable
      // in-frame at three samples: the re-capture's in-frame production top
      // line was 32.
      const topLine = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      expect(topLine).toBe(36);
    });
  }
});

describe('vendor-listener: LoAF attributes a vendor to the line that registered it', () => {
  /** The three declared slices, in registration order. */
  function declaredSlices(): { line: number; isThirdParty: boolean }[] {
    const groundTruth = loadGroundTruth('vendor-listener');
    return arrayAt(groundTruth, ['expected', 'slices']).map((slice) => ({
      line: numberAt(slice, ['loafAttributesTo', 'line']),
      isThirdParty: get(slice, ['isThirdParty']) === true,
    }));
  }

  for (const mode of BUILD_MODES) {
    it(`${mode}: three slices, every one resolving to its registration line in app.js`, () => {
      const run = loadCorpusRun('vendor-listener', mode);
      const slices = declaredSlices();

      const frames = longFrames(run);
      const index = frames.findIndex((_, i) => scriptsOfFrame(run, i).length === 3);
      expect(index, 'no frame carried three script attributions').toBeGreaterThanOrEqual(0);
      const scripts = scriptsOfFrame(run, index);

      /*
       * The fixture's scripts are served out of `public/`, which Vite copies
       * byte-for-byte in both build modes, so the repo's own copy *is* the text
       * the character offsets index into. That is what makes this check
       * possible with no capture of the text and no server: it is the only
       * place in the corpus where the served bytes are in version control.
       */
      const index_ = createScriptLineIndex(
        readRepoFile('fixtures/vendor-listener/public/app.js'),
      );

      const resolvedLines = scripts.map((script) => {
        const charPosition = asNumber(script.sourceCharPosition, ['sourceCharPosition']);
        const position = lineColumnAt(index_, charPosition);
        expect(position, `charPosition ${String(charPosition)} is outside app.js`).not.toBeNull();
        return position?.line;
      });

      expect(resolvedLines).toEqual(slices.map((slice) => slice.line));

      /*
       * Two further halves of the same finding, both load-bearing:
       *
       * `sourceFunctionName` is empty for all three, because the listeners are
       * anonymous arrows — so the character offset did all the work. That is
       * the positive result, and it is what makes `sourceCharPosition` worth
       * resolving for non-framework jank at all.
       *
       * And `vendor.js` is named by no script entry, even though one of the
       * three slices is entirely the vendor's cost. LoAF attributes to the
       * registration site, so wherever first-party code calls into a vendor
       * library, LoAF's script attribution reports a 100% first-party frame.
       * A third-party share is not available from this signal at all; it needs
       * the profiler.
       */
      for (const script of scripts) {
        expect(asString(script.sourceFunctionName, ['sourceFunctionName'])).toBe('');
        expect(asString(script.sourceURL, ['sourceURL'])).toContain('/app.js');
      }

      expect(slices.some((slice) => slice.isThirdParty)).toBe(true);
      expect(scripts.map((script) => asString(script.sourceURL, ['sourceURL']))).not.toContain(
        expect.stringContaining('vendor.js'),
      );
    });
  }
});

describe('innerhtml-rebuild: the frame the arithmetic cannot account for', () => {
  /** Frames belonging to one labelled drive step. */
  function framesOfStep(run: CorpusRun, label: string): JsonObject[] {
    const step = stepsOf(run).find((candidate) => candidate.label === label);
    if (!step) throw new Error(`no step labelled ${label}`);
    const from = asNumber(step.startedAtPageClock, ['startedAtPageClock']);
    const to = asNumber(step.endedAtPageClock, ['endedAtPageClock']);

    return longFrames(run).filter((frame) => {
      const start = asNumber(frame.startTime, ['startTime']);
      return start >= from && start <= to;
    });
  }

  it('development: the unforced rebuild leaves most of the frame unnamed', () => {
    const run = loadCorpusRun('innerhtml-rebuild', 'development');
    const frames = framesOfStep(run, 'unforced');
    expect(frames.length).toBeGreaterThan(2);

    for (const [index, frame] of frames.entries()) {
      const scripts = scriptsOfFrame(run, longFrames(run).indexOf(frame));
      const scriptTotal = scripts.reduce(
        (sum, script) => sum + asNumber(script.duration, ['duration']),
        0,
      );
      const duration = asNumber(frame.duration, ['duration']);

      /*
       * Style recalculation and layout performed while no script is running —
       * before the rendering update — are not counted by LoAF. That is
       * specified behaviour, not a Chrome bug, and it is why these two fields
       * are zero on a frame that is almost entirely style and layout.
       */
      expect(asNumber(frame.styleDuration, ['styleDuration']), `frame ${String(index)}`).toBe(0);
      expect(asNumber(frame.layoutDuration, ['layoutDuration'])).toBe(0);

      // Measured at 88.9-90.3% of the frame unaccounted for (4x); asserted at
      // 70%.
      expect((duration - scriptTotal) / duration).toBeGreaterThan(0.7);
    }

    /*
     * The cross-check, and the reason this is a tier rather than a shrug: the
     * residual is corroborated by a second, independent signal. If most of the
     * frame were attributable work that LoAF merely failed to name, the
     * profiler would have found JavaScript on the stack. It did not — measured
     * at 88.9-91.7% of each unforced frame's samples with no stack at all (4x).
     * The share asserted below pools every long frame in the run, the forced
     * ones included, which is why it measures lower, at 56.0% (47 of 84), and
     * why the floor is 40%. Two signals agreeing that nothing was attributable
     * is what makes an honest unattributed slice possible; subtraction alone
     * would not.
     */
    const samples = inFrameSamples(run);
    const unforcedShare = samples.emptyCount / samples.total;
    expect(unforcedShare).toBeGreaterThan(0.4);

    /*
     * And the third signal, which is the one that makes the residual *work*
     * rather than idle time. An empty stack only says no JavaScript was
     * running; it does not say the thread was busy. The fixture publishes what
     * nothing outside the page can see: how long a `MessageChannel` message
     * posted at the end of the listener took to be delivered, and how late the
     * next animation frame fired. A 14ms listener followed by a 120ms wait for
     * a task it posted itself means the thread was occupied throughout.
     *
     * Measured (4x): listeners of 13.3-14.3ms, deliveries of 116.7-148.8ms.
     */
    const probe = arrayAt(run.files.loaf, ['fixtureProbe'])
      .map((record, index) => asRecord(record, ['fixtureProbe', index]))
      .filter((record) => record.scenario === 'unforced');
    expect(probe.length).toBeGreaterThan(2);

    for (const record of probe) {
      const listener = asNumber(record.listenerTotalMs, ['listenerTotalMs']);
      const delivered = numberAt(record, ['delays', 'messageChannelMs']);
      expect(listener).toBeLessThan(40);
      expect(delivered).toBeGreaterThan(60);
      // The delay is the frame's unnameable part, not the listener's own work.
      expect(delivered).toBeGreaterThan(listener * 3);
    }
  });

  it('development: forcing the same work inline makes LoAF name it exactly', () => {
    const run = loadCorpusRun('innerhtml-rebuild', 'development');
    const all = longFrames(run);
    const frames = framesOfStep(run, 'forced');
    expect(frames.length).toBeGreaterThan(2);

    for (const frame of frames) {
      const scripts = scriptsOfFrame(run, all.indexOf(frame));
      const forced = scripts.reduce(
        (sum, script) =>
          sum + asNumber(script.forcedStyleAndLayoutDuration, ['forcedStyleAndLayoutDuration']),
        0,
      );
      const scriptTotal = scripts.reduce(
        (sum, script) => sum + asNumber(script.duration, ['duration']),
        0,
      );

      // Measured at 94.9-102.3ms of forced style and layout per frame (4x).
      expect(forced).toBeGreaterThan(50);

      /*
       * `forcedStyleAndLayoutDuration` is browser work performed *inside* the
       * script's own duration, not alongside it, so it must never be added to
       * a frame's decomposition as a separate slice. Asserted rather than
       * merely commented, because double-counting it is the single easiest way
       * to produce a frame that sums to more than 100%.
       */
      expect(forced).toBeLessThanOrEqual(scriptTotal);

      // Still zero, even though this frame is dominated by style and layout:
      // only the rendering update's own work lands in these fields.
      expect(asNumber(frame.styleDuration, ['styleDuration'])).toBe(0);
      expect(asNumber(frame.layoutDuration, ['layoutDuration'])).toBe(0);
    }
  });
});

describe("spans: React's spans miss the component that caused the frame", () => {
  it('development: the state owner re-renders for 25ms and is given no span', () => {
    const run = loadCorpusRun('spans', 'development');
    const step = stepsOf(run).find((candidate) => candidate.label === 'state-owner-self');
    if (!step) throw new Error('no state-owner-self step');

    const from = asNumber(step.startedAtPageClock, ['startedAtPageClock']);
    const to = asNumber(step.endedAtPageClock, ['endedAtPageClock']);

    const commits = arrayAt(run.files.react, ['commits'])
      .map((commit, index) => asRecord(commit, ['commits', index]))
      .filter((commit) => commit.kind === 'commit')
      .filter((commit) => {
        const at = asNumber(commit.committedAt, ['committedAt']);
        return at >= from && at <= to;
      });

    expect(commits.length, 'the interaction produced no commit').toBe(1);

    const components = arrayAt(commits[0], ['components']).map((component, index) =>
      asRecord(component, ['components', index]),
    );
    const expensive = components.filter(
      (component) => asNumber(component.actualDuration, ['actualDuration']) > 20,
    );

    /*
     * The gate, measured. React emits a `performance.measure` for a component
     * only when its props changed by identity, so a leaf's own `setState`
     * produces no span for the leaf *or* for its ancestors — 25ms of render
     * here, and not one span anywhere in the tree. A tool keyed on spans would
     * report that nothing happened.
     *
     * Read the two names below correctly: `actualDuration` is subtree time, so
     * `StateOwner` at 25ms is the work and `App` at 25ms is the same work seen
     * from one level up. Self time is
     * `actualDuration - sum(children.actualDuration)`, which makes `App`'s own
     * contribution zero — it did not re-render, its child did. The pair is
     * asserted rather than just `StateOwner` because an engine has to get that
     * subtraction right to avoid double-counting the frame.
     *
     * This is the fixture that caught the previous session's worst error, which
     * was to promote these spans to the primary component signal. The fiber
     * tree saw the render; the spans did not.
     */
    expect(expensive.map((component) => asString(component.name, ['name'])).sort()).toEqual([
      'App',
      'StateOwner',
    ]);
    expect(componentSpanNames(run, from, to)).toEqual([]);

    /*
     * And the second blind spot, stacked on the first: this interaction
     * produced no long animation frame either. ~25ms of render is under LoAF's
     * 50ms reporting threshold, so the one interaction React declines to name
     * is also the one the trigger never fires for. Asserted because it is a
     * real property of the corpus that an engine must not be surprised by —
     * the evidence for this claim is a commit record, not a frame.
     */
    const framesInStep = longFrames(run).filter((frame) => {
      const start = asNumber(frame.startTime, ['startTime']);
      return start >= from && start <= to;
    });
    expect(framesInStep).toHaveLength(0);
  });

  it('development: the mount renders five components and names none of them', () => {
    const run = loadCorpusRun('spans', 'development');
    const step = stepsOf(run).find((candidate) => candidate.label === 'initial-mount');
    if (!step) throw new Error('no initial-mount step');

    // The window opens at 0 for this fixture: React's mount commit lands while
    // the navigation is still in progress. See `spike/drive.ts`.
    const from = asNumber(step.startedAtPageClock, ['startedAtPageClock']);
    const to = asNumber(step.endedAtPageClock, ['endedAtPageClock']);
    expect(from).toBe(0);

    const mountCommit = arrayAt(run.files.react, ['commits'])
      .map((commit, index) => asRecord(commit, ['commits', index]))
      .find((commit) => commit.kind === 'commit');
    expect(mountCommit, 'the mount produced no commit record').toBeDefined();

    const rendered = arrayAt(mountCommit, ['components'])
      .map((component, index) => asRecord(component, ['components', index]))
      .filter((component) => asNumber(component.actualDuration, ['actualDuration']) > 20);

    expect(rendered.length).toBe(5);
    expect(componentSpanNames(run, from, to)).toEqual([]);
  });

  it('production: no spans and no fiber timings at all', () => {
    const run = loadCorpusRun('spans', 'production');

    /*
     * Both React signals are gone in a production build: zero
     * `performance.measure` entries and `actualDuration` null on every fiber.
     * The DevTools hook still fires on every commit, but the component names
     * are minified — which is why production attribution runs on the profiler
     * and the shipped source map instead, needing no hook and no dev build.
     */
    expect(componentSpanNames(run, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);

    const commits = arrayAt(run.files.react, ['commits'])
      .map((commit, index) => asRecord(commit, ['commits', index]))
      .filter((commit) => commit.kind === 'commit');
    expect(commits.length).toBeGreaterThan(0);

    for (const commit of commits) {
      const components = arrayAt(commit, ['components']).map((component, index) =>
        asRecord(component, ['components', index]),
      );
      expect(components.length).toBeGreaterThan(0);
      for (const component of components) {
        expect(component.actualDuration).toBeNull();
      }
    }
  });
});
