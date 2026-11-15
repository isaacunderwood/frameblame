/**
 * The profiler tier, against the captured corpus.
 *
 * Step 4's two claims, each asserted against the fixture's own ground truth:
 *
 * 1. `derive-in-render` resolves to `OrderTable.tsx` line 36 as the top-ranked
 *    line in both build modes, with 60% or more of the replay's `OrderTable`
 *    samples charged to functions defined inside the declared range 34-36.
 * 2. `vendor-listener` attributes its vendor slice to `vendor.js` from the
 *    profiler, while reporting that LoAF named `app.js` for the same slice.
 *
 * And the degradation it rests on: where a script ships no source map, the
 * answer is still given, at `profiler-unmapped`, with the reason named.
 *
 * Nothing here walks a stack, resolves a position or partitions a frame by
 * hand: the engine does, and these tests read its answer. Nothing counts long
 * frames either. The replay population is every sample inside the drive's
 * steps, so it does not depend on how many presses cleared LoAF's 50ms
 * threshold.
 *
 * Every figure quoted below is from the v0.3 re-capture, Chromium
 * 159.0.8154.6, 4x CPU throttle, with the build mode given.
 */

import {
  attributeSampledFunctions,
  attributeScriptEntries,
  type CandidateCause,
  chargedSamples,
  describeScriptEntry,
  describeSourceLocation,
  type FunctionAttribution,
  type FunctionSubject,
  interactionPopulation,
  longFramePopulation,
  type ScriptEntryAttribution,
} from '@frameblame/core';
import { describe, expect, it } from 'vitest';

import { BUILD_MODES, type BuildMode } from './corpus.ts';
import { arrayAt, numberAt, stringAt } from './json.ts';
import {
  deriveInRenderTruth,
  fileNameOf,
  resolvedProfileOf,
  type VendorSlice,
  vendorListenerTruth,
} from './test-support.ts';

/** A candidate's subject, which in this tier is always a source location. */
function subjectOf(cause: CandidateCause | undefined): FunctionSubject {
  if (cause?.subject.kind !== 'source-location') {
    throw new Error(
      `expected a source-location candidate, got ${String(cause?.subject.kind)}`,
    );
  }
  return cause.subject;
}

/** As `resolvedProfileOf`, with the engine's attribution over the replay population. */
function replayOf(fixture: string, mode: BuildMode) {
  const { signals, resolved } = resolvedProfileOf(fixture, mode);
  const replay = attributeSampledFunctions(
    resolved,
    signals.provenance,
    interactionPopulation(signals),
  );
  return { signals, resolved, replay };
}

/**
 * The samples charged to functions in `fileName`, and how many of them to
 * functions defined inside `[from, to]`. Reads the engine's candidates; walks
 * nothing.
 */
function shareInRange(
  attribution: FunctionAttribution,
  fileName: string,
  from: number,
  to: number,
): { readonly inRange: number; readonly ofFile: number } {
  let inRange = 0;
  let ofFile = 0;
  for (const cause of attribution.causes.causes) {
    const subject = subjectOf(cause);
    if (fileNameOf(subject.location.file) !== fileName) continue;
    const samples = chargedSamples(cause);
    ofFile += samples;
    const { line } = subject.location.position;
    if (line >= from && line <= to) inRange += samples;
  }
  return { inRange, ofFile };
}

describe('derive-in-render: the profiler names the function on the declared line', () => {
  const { truth, component, fileName, lineRange, notAtFault } = deriveInRenderTruth();
  const { from, to } = lineRange;
  const dominant = arrayAt(truth, ['expected', 'culpritLines']).find((line) =>
    stringAt(line, ['role']).startsWith('the dominant cost'),
  );
  const dominantLine = numberAt(dominant, ['line']);

  for (const mode of BUILD_MODES) {
    it(`${mode}: the function defined on line ${String(dominantLine)} ranks first over the replay, and most samples are charged to functions defined in ${String(from)}-${String(to)}`, async (context) => {
      const { signals, resolved, replay } = replayOf('derive-in-render', mode);

      /*
       * The top-ranked candidate is the comparator passed to `.sort`, defined
       * on line 36 and resolved through the source map in both builds: 62 of
       * the replay's 96 stacked samples in development and 56 of 69 in
       * production (4x). It is a function located by its definition line, and
       * the claim is worded that way.
       */
      const [top] = replay.causes.causes;
      const subject = subjectOf(top);
      expect(top?.tier).toBe('profiler-mapped');
      expect(fileNameOf(subject.location.file)).toBe(fileName);
      expect(subject.location.position.line).toBe(dominantLine);
      expect(subject.granularity).toBe('function-definition');
      expect(subject.enclosingCallToken).toBe('.sort');
      expect(
        describeSourceLocation(subject).endsWith(
          `${fileName}:${String(dominantLine)}, in the callback passed to .sort`,
        ),
      ).toBe(true);

      /*
       * Every sample taken during the replay, not only those inside a long
       * frame. The v0.3 re-capture left production with a long frame after 2
       * of its 24 presses, and 3 in-frame samples charged to OrderTable.tsx,
       * so an in-frame floor would be a long-frame count by another name. The
       * claim is about what each keystroke spent its time on, and the profiler
       * sees that whether or not the trigger fired.
       *
       * Measured over the replay: 65 of 92 OrderTable.tsx samples in the
       * declared range in development (70.7%), and 56 of 67 in production
       * (83.6%), 4x. The capture before gave 60.8% of 102 and 86.3% of 80
       * over the same population. The lines outside the range are real render
       * work rather than error: line 32 is the component body, reached when a
       * sample lands in the sort but not in the comparator, and line 49 is the
       * row-rendering `.map` callback, which holds the 14 samples whose leaf
       * was React's JSX runtime (development).
       *
       * How much room the floor leaves: a share of n samples has a binomial
       * standard error of sqrt(p(1-p)/n). At the measured shares that is 4.7
       * points for development and 4.5 for production, which puts them 2.2
       * and 5.2 standard errors above 60%. The previous capture's 60.8% of
       * 102 was 0.16 above it. A re-capture that lands just under 60% is
       * within ordinary sampling noise of what has been seen, and should be
       * read as that before it is read as a regression. The floor stays at
       * 60% because that is step 4's declared criterion in `handoff.md`.
       */
      const overReplay = shareInRange(replay, fileName, from, to);
      expect(overReplay.ofFile, `no sample resolved into ${fileName}`).toBeGreaterThan(
        10,
      );

      /*
       * Reported beside the floor and deliberately not asserted: the in-frame
       * share. 40 of 56 in development (71.4%) and 1 of 3 in production
       * (33.3%, with line 32 ranked first), 4x. Three samples is no
       * distribution at all, which is the reason the floor is over the replay.
       */
      const inFrame = shareInRange(
        attributeSampledFunctions(
          resolved,
          signals.provenance,
          longFramePopulation(signals),
        ),
        fileName,
        from,
        to,
      );
      const percent = (part: number, whole: number): string =>
        `${(whole === 0 ? 0 : (100 * part) / whole).toFixed(1)}% of ${String(whole)}`;
      await context.annotate(
        `${mode}, ${String(signals.provenance.cpuThrottleRate)}x: ${fileName} samples in ` +
          `${String(from)}-${String(to)}: ${percent(overReplay.inRange, overReplay.ofFile)} over ` +
          `the replay (asserted), ${percent(inFrame.inRange, inFrame.ofFile)} in-frame (reported only)`,
      );

      expect(overReplay.inRange / overReplay.ofFile).toBeGreaterThan(0.6);
    });

    it(`${mode}: names the component's own lines, never App's`, () => {
      const { replay } = replayOf('derive-in-render', mode);

      /*
       * The fixture's declared wrong answer is `App`, which owns the state the
       * keystroke updates. Over the replay it holds 1 of production's 69
       * stacked samples and none of development's 96 (4x). The component's own
       * body, `OrderTable` at its declaration, is a candidate in both builds,
       * named by the profiler in development and by the source map's `names`
       * in production.
       */
      const subjects = replay.causes.causes.map(subjectOf);
      const body = subjects.find((subject) => subject.functionName?.text === component);
      expect(body === undefined ? '' : fileNameOf(body.location.file)).toBe(fileName);
      expect(body?.functionName?.from).toBe(
        mode === 'production' ? 'source-map' : 'served-script',
      );

      const [top] = replay.causes.causes;
      for (const cause of replay.causes.causes) {
        if (!notAtFault.includes(subjectOf(cause).functionName?.text ?? '')) continue;
        expect(cause.weight.fraction).toBeLessThan((top?.weight.fraction ?? 0) / 10);
      }

      // Every candidate is a function located by its definition line. None is
      // a statement, because the in-page profiler cannot see one.
      for (const cause of replay.causes.causes) {
        expect(subjectOf(cause).granularity).toBe('function-definition');
      }
    });
  }

  it("development: LoAF names react-dom's dispatcher; the profiler names OrderTable.tsx", () => {
    const { signals, resolved } = resolvedProfileOf('derive-in-render', 'development');

    /*
     * The project's thesis in one assertion. LoAF reports each keypress frame
     * as one script entry in react-dom's `dispatchDiscreteEvent`, which is
     * true and useless. In development the component is a separately served
     * module, so the profiler's answer for the same slices is in a different
     * script: 39 of their 59 stacked samples in the `.sort` comparator (4x).
     * In production both are one bundle, so the same disagreement is a
     * difference of function rather than of script, and is not flagged.
     */
    const declared = stringAt(truth, [
      'observedJank',
      'loafScriptAttribution',
      'sourceFunctionName',
    ]);
    const entry = attributeScriptEntries(signals, resolved).find(
      (candidate) => candidate.site.sourceFunctionName === declared,
    );
    expect(entry, `no LoAF entry named ${declared}`).toBeDefined();
    expect(entry?.disagreement?.loafScriptUrl).toContain('react-dom');
    expect(fileNameOf(entry?.disagreement?.profilerScriptUrl ?? '')).toBe(fileName);
    const top = subjectOf(entry?.profiler?.causes.causes[0]);
    expect(top.location.position.line).toBe(dominantLine);
  });
});

describe('vendor-listener: the profiler names the vendor LoAF cannot', () => {
  const { slices } = vendorListenerTruth();

  function entryFor(
    entries: readonly ScriptEntryAttribution[],
    slice: VendorSlice,
  ): ScriptEntryAttribution {
    const entry = entries.find(
      (candidate) => candidate.site.sourceCharPosition === slice.charPosition,
    );
    if (entry === undefined) {
      throw new Error(
        `no LoAF entry at offset ${String(slice.charPosition)} (${slice.slice})`,
      );
    }
    return entry;
  }

  it('declares exactly one third-party slice', () => {
    expect(slices.filter((slice) => slice.isThirdParty)).toHaveLength(1);
  });

  for (const mode of BUILD_MODES) {
    it(`${mode}: the vendor slice is vendor.js by the profiler and app.js by LoAF`, () => {
      const { signals, resolved } = resolvedProfileOf('vendor-listener', mode);
      const entries = attributeScriptEntries(signals, resolved);
      const vendor = slices.find((slice) => slice.isThirdParty);
      if (vendor === undefined) throw new Error('no third-party slice declared');
      const entry = entryFor(entries, vendor);

      /*
       * LoAF's half, unchanged: every one of this listener's entries (six in
       * each build mode, 4x) names `app.js`, where the listener was
       * registered, and nothing in them names `vendor.js`. How many entries
       * there are is a long-frame count, so it is not asserted.
       */
      expect(entry.slices.length).toBeGreaterThan(0);
      for (const slice of entry.slices) {
        expect(fileNameOf(slice.script.sourceUrl ?? '')).toBe(vendor.loafFileName);
      }
      expect(fileNameOf(entry.site.sourceUrl ?? '')).toBe(vendor.loafFileName);

      /*
       * The profiler's half. Over the six clicks the slices hold 13 stacked
       * samples in development, all 13 in `vendorTrack`, and 14 in
       * production, 13 of them in `vendorTrack` and one in the anonymous
       * listener itself at `app.js:192` (4x). A 12ms slice at a 12-15ms
       * cadence is about one sample per click (both build modes), which is
       * why the claim is over every click rather than per frame.
       *
       * Most of those samples are one burst, not thirteen clicks' worth: 9
       * of development's 13 fall in 1.1ms on the first click (165.8-166.9ms),
       * and 9 of production's 14 in 181.0-182.5ms, the `app.js:192` sample
       * among them. After the first click the evidence is 4 of 4 in
       * development and 5 of 5 in production, all `vendorTrack`; the sixth
       * development click's one sample, at 3757.2ms, is on the boundary and
       * goes to the next slice (4x). Burst samples are not independent
       * evidence, which the confidence model has to account for.
       */
      const profiler = entry.profiler;
      if (profiler === null) throw new Error('no profiler attribution');
      const [top] = profiler.causes.causes;
      const subject = subjectOf(top);
      expect(fileNameOf(subject.scriptUrl)).toBe(vendor.ownerFileName);
      expect(subject.functionName?.text).toBe(vendor.ownerFunction);
      expect(subject.location.position.line).toBe(vendor.ownerLine);
      expect(top?.weight.fraction).toBeGreaterThan(0.5);

      // The disagreement is in the answer, with both scripts named.
      expect(entry.disagreement).not.toBeNull();
      expect(fileNameOf(entry.disagreement?.loafScriptUrl ?? '')).toBe(
        vendor.loafFileName,
      );
      expect(fileNameOf(entry.disagreement?.profilerScriptUrl ?? '')).toBe(
        vendor.ownerFileName,
      );
      const said = describeScriptEntry(entry);
      expect(said).toContain(`LoAF named ${entry.site.sourceUrl ?? ''}`);
      expect(said).toContain(
        `${vendor.ownerFileName}:${String(vendor.ownerLine)}, in ${vendor.ownerFunction}`,
      );
      expect(said).toContain('a different script');
      expect(said).toContain(`(${mode}, 4x CPU throttle`);

      /*
       * And the tier it stands on is named: `vendor.js` ships no source map,
       * so the position is the served script's and the answer says so. The
       * name is real only because the file is served as written.
       */
      expect(top?.tier).toBe('profiler-unmapped');
      expect(subject.location).toMatchObject({
        throughSourceMap: false,
        whyNot: 'no-source-map',
      });
      expect(subject.functionName?.from).toBe('served-script');
    });

    it(`${mode}: the first-party slices agree with LoAF about the script, and name the function`, () => {
      const { signals, resolved } = resolvedProfileOf('vendor-listener', mode);
      const entries = attributeScriptEntries(signals, resolved);

      /*
       * The control. For the two first-party slices LoAF and the profiler
       * name the same file, and the profiler adds the function the listener
       * called, which LoAF cannot: `computeTotals` and `thrashLayout`. The
       * forced-layout entry's 51 development samples include one in
       * `vendorTrack`, taken at 3757.2ms, the exact coarsened instant the
       * vendor slice ends and this one begins (4x). Slices are half-open, so
       * it is counted here, once. That is the tie-break, and here it points
       * the wrong way: the sample's leaf is `vendorTrack`, so by its stack it
       * belongs to the vendor slice (see `scriptSlicePopulation`).
       */
      for (const slice of slices.filter((candidate) => !candidate.isThirdParty)) {
        const entry = entryFor(entries, slice);
        expect(entry.disagreement, slice.slice).toBeNull();
        const subject = subjectOf(entry.profiler?.causes.causes[0]);
        expect(fileNameOf(subject.scriptUrl)).toBe(slice.ownerFileName);
        expect(subject.functionName?.text).toBe(slice.ownerFunction);
        expect(subject.location.position.line).toBe(slice.ownerLine);
      }
    });
  }
});

describe('innerhtml-rebuild: no source map, and the tier says so', () => {
  for (const mode of BUILD_MODES) {
    it(`${mode}: attributes the listener's function at profiler-unmapped, naming why`, () => {
      const { signals, resolved } = resolvedProfileOf('innerhtml-rebuild', mode);

      /*
       * The degraded tier in its natural habitat: `app.js` is served out of
       * `public/` with no map in either build. Always produce something,
       * always state what it was working from. Every candidate is the served
       * script's position, carrying `no-source-map`, and its description says
       * so.
       */
      const entries = attributeScriptEntries(signals, resolved);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const causes = entry.profiler?.causes.causes ?? [];
        expect(causes.length).toBeGreaterThan(0);
        for (const cause of causes) {
          const subject = subjectOf(cause);
          expect(cause.tier).toBe('profiler-unmapped');
          expect(subject.location).toMatchObject({
            throughSourceMap: false,
            whyNot: 'no-source-map',
          });
          expect(describeSourceLocation(subject)).toContain(
            'the script shipped no source map',
          );
        }
      }
    });
  }
});
