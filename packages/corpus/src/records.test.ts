/**
 * The record types and the frame arithmetic, against all eight captures.
 *
 * Two questions, and they are the ones a human can check cheaply before any
 * heuristic is built on top:
 *
 * 1. **Do the types fit the dumps?** Every run must parse with nothing cast and
 *    nothing left as loosely-typed JSON, and a field the specifications promise
 *    but Chrome withholds must arrive as absent rather than as zero.
 * 2. **Does the arithmetic close?** Every frame in the corpus must partition
 *    into slices that account for its duration and never claim more than it,
 *    and the three fixtures that were promoted to make claims about a frame's
 *    composition must reproduce those claims from the engine rather than from a
 *    reader written beside the assertion.
 *
 * It is also where a claim about the raw signal lives: what LoAF reports in
 * which field, what a production build withholds, what the fixture's own probe
 * recorded. Those are facts about the input, asserted against the reader that
 * parses them; what the engine concludes from them is `accuracy.test.ts`'s.
 *
 * This file does not walk a stack, filter samples by a window or partition a
 * frame by hand. Where it needs a partition it asks `decomposeFrame`, and
 * where it needs an interaction's frames it asks `framesOfInteraction`. The
 * throwaway readers `corpus.test.ts` used to hold were the predecessors of
 * exactly that, and step 6 deleted them. Nothing here counts long frames
 * either, zero included: every assertion about frames is made of each frame a
 * capture holds.
 *
 * Every millisecond figure quoted below carries its build mode and CPU throttle
 * rate, which for all eight captures is Chromium 159.0.8154.6 at 4x.
 */

import {
  COARSENED_TIMING_TOLERANCE_MS,
  createScriptLineIndex,
  decomposeFrame,
  exceedsCoarsenedTolerance,
  type FrameDecomposition,
  framesOfInteraction,
  lineColumnAt,
  shareOfFrame,
} from '@frameblame/core';
import { describe, expect, it } from 'vitest';

import {
  BUILD_MODES,
  type BuildMode,
  listFixtures,
  loadCorpusRun,
  readRepoFile,
} from './corpus.ts';
import { arrayAt, asRecord, get, numberAt, stringAt } from './json.ts';
import { loadSignals } from './records.ts';
import { vendorListenerTruth } from './test-support.ts';

const FIXTURES = listFixtures();

/** Every captured run, as the engine's input. */
const RUNS: { fixture: string; mode: BuildMode }[] = FIXTURES.flatMap((fixture) =>
  BUILD_MODES.map((mode) => ({ fixture, mode })),
);

/** The summed duration of a decomposition's slices, in ms. */
function slicedMs(decomposition: FrameDecomposition): number {
  return decomposition.slices.reduce((sum, slice) => sum + slice.durationMs, 0);
}

describe('the records', () => {
  for (const { fixture, mode } of RUNS) {
    it(`${fixture}/${mode}: parses into the engine's types`, () => {
      const signals = loadSignals(fixture, mode);

      expect(signals.provenance.subject).toBe(fixture);
      expect(signals.provenance.buildMode).toBe(mode);
      expect(signals.provenance.cpuThrottleRate).toBe(4);
      expect(signals.provenance.browser).toMatch(/^chromium \d/);

      expect(signals.frames.length).toBeGreaterThan(0);
      expect(signals.interactions.length).toBeGreaterThan(0);
      // The profiler is a hard requirement of the capture, not of the engine:
      // a run collected without it would be evidence for much less than it
      // appears to be, so `collectRun` fails rather than writing one.
      expect(signals.profile).not.toBeNull();
      expect(signals.react.hookInstalled).toBe(true);
    });
  }

  it('represents the fields Chrome withholds as absent, not as zero', () => {
    /*
     * `sourceLine` and `sourceColumn` are specified and are implemented in
     * Chromium behind Blink features that are off by default. Their absence is
     * the entire reason this project resolves a character offset by hand, so a
     * zero here would quietly turn the project's premise into a line number.
     */
    for (const { fixture, mode } of RUNS) {
      for (const frame of loadSignals(fixture, mode).frames) {
        for (const script of frame.scripts) {
          expect(script.sourceLine, `${fixture}/${mode}`).toBeNull();
          expect(script.sourceColumn).toBeNull();
        }
      }
    }
  });

  it('turns Chrome’s sentinels into absence', () => {
    /*
     * Three sentinels, all of them numbers or strings that arithmetic would
     * consume happily. Measured in the corpus: two script entries report
     * `sourceCharPosition: -1` with an empty `sourceURL`, 54 of 77 report an
     * empty `sourceFunctionName` — 52 because the listener is an anonymous
     * arrow, and those same two because they name no function — and five frames
     * report `firstUIEventTimestamp: 0` because nothing in them came from an
     * input.
     */
    const derive = loadSignals('derive-in-render', 'development');

    const unattributedScripts = derive.frames
      .flatMap((frame) => frame.scripts)
      .filter((script) => script.sourceCharPosition === null);
    expect(unattributedScripts.length).toBeGreaterThan(0);
    for (const script of unattributedScripts) {
      expect(script.sourceUrl).toBeNull();
      expect(script.sourceFunctionName).toBeNull();
    }

    // Every one of `vendor-listener`'s script entries is an anonymous arrow,
    // and still located: this is the case that makes the character offset
    // worth resolving at all. The offsets themselves are checked against the
    // registration lines in the `vendor-listener` block below.
    const vendor = loadSignals('vendor-listener', 'development');
    expect(vendor.frames.length).toBeGreaterThan(0);
    for (const frame of vendor.frames) {
      for (const script of frame.scripts) {
        expect(script.sourceFunctionName).toBeNull();
        expect(script.sourceCharPosition).not.toBeNull();
      }
    }

    expect(
      derive.frames.filter((frame) => frame.firstUIEventTimestampMs === null).length,
    ).toBeGreaterThan(0);
  });

  it('carries the forced style and layout split that findings.md records as unavailable', () => {
    /*
     * `findings.md`'s one open item says the forced scenario's
     * style-versus-layout split "cannot have come from the LoAF entry - the
     * entry exposes only the combined forcedStyleAndLayoutDuration". It can:
     * both fields are in the specification, which defines the combined one as
     * their sum, and Chrome 159 serialises all three. They are in all eight
     * captures.
     *
     * Measured on `innerhtml-rebuild`'s forced frames (4x): 22.4-24.2ms style
     * and 71.5-79.6ms layout in development and production together in the
     * v0.3 re-capture, and 23.4-25.8 and 71.1-80.6 in the capture before it,
     * against the 24.3-25.3 and 71.8-90.6 the document quotes from an
     * instrument it could not name.
     */
    const forced = BUILD_MODES.flatMap((mode) => {
      const signals = loadSignals('innerhtml-rebuild', mode);
      const frames = framesOfInteraction(signals, 'forced');
      expect(frames.length, mode).toBeGreaterThan(0);
      return frames.map((frame) => {
        // Each frame of the forced scenario carries the split on the one
        // script entry that forced it.
        const [forcing, ...others] = frame.scripts.filter(
          (script) => script.forcedStyleAndLayoutDurationMs > 50,
        );
        expect(others, `${mode} frame at ${String(frame.startTimeMs)}ms`).toEqual([]);
        if (forcing === undefined)
          throw new Error(`${mode}: a forced frame with no forcing script`);
        return forcing;
      });
    });

    for (const script of forced) {
      const { forcedStyleDurationMs: style, forcedLayoutDurationMs: layout } = script;
      expect(style).not.toBeNull();
      expect(layout).not.toBeNull();
      if (style === null || layout === null) continue;

      expect(style).toBeGreaterThan(20);
      expect(layout).toBeGreaterThan(60);
      /*
       * The sum is approximate in Chrome 159, though the spec defines the
       * combined figure as exactly the sum: the three are reported as values
       * that disagree on the 100us grid. Measured in the v0.3 re-capture (4x)
       * at one grid step on 8 of the corpus's 20 forced entries and two steps
       * on 1 — this fixture's development frame 5, 23.2 + 71.5 against 94.9.
       * Two steps is the tolerance exactly, and the subtraction gives
       * -0.20000000000000284, so the bound is checked with
       * `exceedsCoarsenedTolerance`, which is inclusive at the tolerance plus
       * a 1e-6ms float slack, rather than with a bare `<= 0.2`. Not loosened:
       * a third grid step still fails.
       */
      expect(
        exceedsCoarsenedTolerance(style + layout - script.forcedStyleAndLayoutDurationMs),
      ).toBe(false);
    }
  });

  for (const { fixture, mode } of RUNS) {
    it(`${fixture}/${mode}: models a frame that never painted as having no rendering update`, () => {
      /*
       * In the v0.3 re-capture two of the corpus's 53 frames, both the last of
       * a `derive-in-render` run (4x, one per build mode), are a single
       * `Promise.resolve` task with `renderStart` and `styleAndLayoutStart`
       * reporting the spec's 0 sentinel, and no `paintTime` or
       * `presentationTime` at all. A frame starting at 60943.7ms
       * (development, 4x) whose `renderStart` is 0 is not a frame that
       * rendered at time zero.
       *
       * Which frames those are is the capture's business, and how many there
       * are is a long-frame count, so neither is asserted. What is asserted is
       * the reader's rule, frame by frame against the entry Chrome serialised:
       * a frame has no rendering update exactly when its `renderStart` is the
       * sentinel, and such a frame has no paint and still decomposes to its
       * own end.
       */
      const signals = loadSignals(fixture, mode);
      const entries = arrayAt(loadCorpusRun(fixture, mode).files.loaf, ['entries']);

      for (const index of entries.keys()) {
        const where = `${fixture}/${mode} frame ${String(index)}`;
        // The reader maps entries one to one, in order.
        const frame = signals.frames[index];
        if (frame === undefined) throw new Error(`${where}: not parsed`);
        const serialised = asRecord(get(entries[index], ['toJSON']), [
          'entries',
          index,
          'toJSON',
        ]);
        const unpainted = frame.renderingUpdate.kind === 'none';
        expect(unpainted, where).toBe(numberAt(serialised, ['renderStart']) === 0);
        if (!unpainted) continue;

        expect(serialised.paintTime, where).toBeUndefined();
        expect(serialised.presentationTime, where).toBeUndefined();
        // And the reader carries neither: a frame with no rendering update has
        // no paint or presentation time to report, not a zero one.
        expect(frame.renderingUpdate, where).toEqual({ kind: 'none' });
        expect(frame.startTimeMs, where).toBeGreaterThan(1000);
        expect(frame.firstUIEventTimestampMs, where).toBeNull();
        expect(decomposeFrame(frame).frameEndMs, where).toBeCloseTo(
          frame.startTimeMs + frame.durationMs,
          10,
        );
      }
    });
  }

  for (const mode of BUILD_MODES) {
    it(`spans/${mode}: the mount's window opens at the page clock's origin`, () => {
      /*
       * The first interaction of a fixture that captures its own first mount
       * covers the page from its very beginning, because React's mount commit
       * lands while the navigation is still in progress (`spike/drive.ts`).
       * In the v0.3 re-capture it lands at 239.4ms in development and 175.8ms
       * in production (4x). A window that opened when the driver got control
       * would miss the commit and report that the mount rendered nothing,
       * which is the opposite of `spans`' claim.
       */
      const signals = loadSignals('spans', mode);
      const [mount] = signals.interactions;
      const [first] = signals.react.commits;
      expect(mount?.label).toBe('initial-mount');
      expect(mount?.fromMs).toBe(0);
      expect(first?.committedAtMs).toBeLessThanOrEqual(mount?.toMs ?? -1);
    });
  }

  it('keeps React’s two kinds of span apart, and the fiber timings that production drops', () => {
    const dev = loadSignals('spans', 'development');
    const prod = loadSignals('spans', 'production');

    /*
     * The gate, in one assertion. React emits a component span only for a
     * component whose props changed by identity, so across five interactions
     * that render six components it named exactly two of them — and never the
     * `setState` owner, the context consumer, or anything on first mount.
     */
    const componentSpans = dev.react.spans.flatMap((span) =>
      span.kind === 'component' ? [span.componentName] : [],
    );
    expect(new Set(componentSpans)).toEqual(new Set(['PropsChanged', 'DeepEqualProps']));

    /*
     * Phase markers sit on the same DevTools track as the component spans, so
     * only the zero-width prefix tells them apart.
     *
     * The set is not asserted equal to `{Update, Mount, Update Blocked}`, which
     * is what this test used to do, because two of those three are a coin flip
     * per capture. `Update` and `Update Blocked` are the same marker, emitted
     * under the one gate described below and named `Update Blocked` when the
     * render started more than 5ms after the update (:18629-18630). Both
     * captures so far happened to contain both, and a re-capture in which every
     * update and its render shared a clock tick would have contained neither,
     * failing the test on chance. `Mount` is deterministic here: React logs it
     * for a fiber mounting under an already-mounted parent whenever the mount
     * took more than 0.05ms (`logComponentTrigger(..., "Mount")`, :17206 and
     * :17224), and every component in the fixture burns 25ms. So: `Mount` is
     * present, and nothing outside the three names is classified as a phase.
     */
    const phases = new Set(
      dev.react.spans.filter((span) => span.kind === 'phase').map((span) => span.phase),
    );
    expect(phases).toContain('Mount');
    for (const phase of phases)
      expect(['Update', 'Mount', 'Update Blocked']).toContain(phase);

    /*
     * An `Update` span names the component that scheduled the update — which is
     * exactly the component the span gate declines to give a span to. So each
     * named originator is asserted, per interaction, to be the component whose
     * `setState` that interaction's click called (`fixtures/spans/src/App.tsx`
     * and `causes.tsx`; the `bump-again` step clicks the `bump` button again),
     * and to be a component with no component span.
     *
     * Which interactions get an `Update` span at all is not stable, so none is
     * required to have one. React 19.3.1 emits it only when the render started
     * strictly after the update was scheduled, on the coarsened page clock
     * (`debugTask > previousRenderStartTime &&` in
     * `react-dom-client.development.js`, :18619); an update and a render inside
     * the same clock tick produce nothing. The capture before v0.3 had one for
     * `StateOwner`'s own `setState` and one for `App`; the re-capture has two
     * for `App` and none for `StateOwner`. The v0.1 replay saw one on 5 of 24
     * keypresses. A bonus, not a tier, exactly as `react.ts` says. What is
     * deterministic is that when one appears it names the right component, and
     * that is what is asserted; an `Update` span that fell outside every
     * interaction window would escape the check, so that is refused too.
     *
     * The `Update Blocked` span at mount names no component at all — its rows
     * are only `[["Method name","root.render()"]]` — which is what reading the
     * rows by label rather than by index is for. It sits under the same gate, so
     * it is asserted only where it appears; the label-parsing it exercises is
     * pinned without chance in `collector-fields.test.ts`.
     */
    const SET_STATE_OWNER: Readonly<Record<string, string | null>> = {
      'initial-mount': null,
      bump: 'App',
      'state-owner-self': 'StateOwner',
      'mount-toggle': 'App',
      'bump-again': 'App',
    };
    const originated = dev.react.spans.flatMap((span) =>
      span.kind === 'phase' && span.originator !== null
        ? [{ atMs: span.startTimeMs, originator: span.originator }]
        : [],
    );
    for (const { atMs, originator } of originated) {
      const interaction = dev.interactions.find(
        (window) => atMs >= window.fromMs && atMs <= window.toMs,
      );
      const where = `originator at ${String(atMs)}ms`;
      expect(interaction, where).toBeDefined();
      if (interaction === undefined) continue;

      expect(Object.keys(SET_STATE_OWNER), where).toContain(interaction.label);
      const owner = SET_STATE_OWNER[interaction.label] ?? null;
      expect(originator.componentName, `${where}, ${interaction.label}`).toBe(owner);
      if (owner === null) {
        expect(originator.methodName, where).toBe('root.render()');
      } else {
        expect(originator.methodName, where).toBe('setState()');
        expect(componentSpans, where).not.toContain(owner);
      }
    }

    // Production: no spans at all, and every fiber timing null rather than
    // zero. The hook still fires on every commit, with minified names.
    expect(prod.react.spans).toEqual([]);
    expect(prod.react.commits.length).toBeGreaterThan(0);
    for (const commit of prod.react.commits) {
      expect(commit.components.fibers.length).toBeGreaterThan(0);
      for (const component of commit.components.fibers) {
        expect(component.actualDurationMs).toBeNull();
        expect(component.selfBaseDurationMs).toBeNull();
      }
      expect(commit.priorityLevel).toBeNull();
      expect(commit.postCommitAtMs).toBeNull();
    }
  });
});

describe('the v0.3 collector fields, as the re-capture recorded them', () => {
  /*
   * The collector change behind the v0.3 re-capture added a parent link and raw
   * render evidence to every component fiber, a truncation flag to every
   * commit, and the forced style and layout split to its own script
   * projection. Step 3's self-time subtraction trusts the first two without
   * looking, so they are asserted against the corpus rather than assumed from
   * the collector's source. No assertion here counts frames.
   */
  const REACT_FIXTURES = ['spans', 'derive-in-render'] as const;

  for (const fixture of REACT_FIXTURES) {
    for (const mode of BUILD_MODES) {
      it(`${fixture}/${mode}: every commit is linked throughout and was walked to the end`, () => {
        const { commits } = loadSignals(fixture, mode).react;
        expect(commits.length).toBeGreaterThan(0);

        for (const [index, commit] of commits.entries()) {
          const where = `${fixture}/${mode} commit ${String(index)}`;
          expect(commit.components.linkage, where).toBe('recorded');
          if (commit.components.linkage !== 'recorded') continue;
          expect(commit.components.truncated, where).toBe(false);

          for (const fiber of commit.components.fibers) {
            const performedWork = (fiber.render.flags & 1) !== 0;
            /*
             * React's own evidence, checked against its own timing. A fiber
             * cloned and bailed out has `actualDuration` reset to 0 and
             * `PerformedWork` masked off by `createWorkInProgress`; a fiber
             * with no alternate is mounting, and a mount runs its render.
             * The converse of the first does not hold and is not asserted: a
             * bailed-out parent's `actualDuration` is its subtree's, so `App`
             * reads 25.2ms with the bit clear in `spans`' `state-owner-self`
             * commit (development, 4x), all of it its child's.
             */
            if (fiber.actualDurationMs === 0) expect(performedWork, where).toBe(false);
            if (!fiber.render.hasAlternate) expect(performedWork, where).toBe(true);
          }
        }
      });
    }
  }

  it('projects the forced split on every script, identically to Chrome’s own serialisation', () => {
    for (const { fixture, mode } of RUNS) {
      const run = loadCorpusRun(fixture, mode);
      for (const [frameIndex, entry] of arrayAt(run.files.loaf, ['entries']).entries()) {
        const serialised = arrayAt(entry, ['toJSON', 'scripts']);
        const projected = arrayAt(entry, ['scripts']);
        expect(projected.length).toBe(serialised.length);

        for (const [index, script] of projected.entries()) {
          const where = `${fixture}/${mode} frame ${String(frameIndex)} script ${String(index)}`;
          for (const field of ['forcedStyleDuration', 'forcedLayoutDuration']) {
            const value = get(script, [field]);
            expect(typeof value, where).toBe('number');
            expect(value, where).toBe(get(serialised[index], [field]));
          }
        }
      }
    }
  });
});

describe('the partition, against every frame in the corpus', () => {
  for (const { fixture, mode } of RUNS) {
    it(`${fixture}/${mode}: every frame accounts for its duration and claims no more`, () => {
      const signals = loadSignals(fixture, mode);

      for (const [index, frame] of signals.frames.entries()) {
        const where = `${fixture}/${mode} frame ${String(index)}`;
        const decomposition = decomposeFrame(frame);
        const sliced = slicedMs(decomposition);
        const charged =
          decomposition.charges.javaScriptMs +
          decomposition.charges.browserRenderingMs +
          decomposition.charges.unattributedMs;

        /*
         * The residual is zero by construction — the slices are the intervals
         * between boundaries the frame already reports — so this asserts the
         * construction rather than a property of Chrome. Measured at under
         * 2e-9ms on all 53 frames; asserted at the coarsening tolerance,
         * because a figure finer than the timing grid is not a figure.
         */
        expect(Math.abs(decomposition.unaccountedMs), where).toBeLessThan(
          COARSENED_TIMING_TOLERANCE_MS,
        );
        expect(sliced, where).toBeLessThanOrEqual(
          frame.durationMs + COARSENED_TIMING_TOLERANCE_MS,
        );
        expect(charged, where).toBeCloseTo(sliced, 6);

        // Nothing in the corpus contradicts itself. If a recapture makes this
        // fail, the note says which figure disagreed with the boundaries and by
        // how much — which is the point of having notes rather than clamps.
        expect(decomposition.notes, where).toEqual([]);
      }
    });
  }
});

describe('innerhtml-rebuild: the frame the arithmetic can account for but not attribute', () => {
  for (const mode of BUILD_MODES) {
    it(`${mode}: the unforced rebuild is mostly unattributed`, () => {
      const signals = loadSignals('innerhtml-rebuild', mode);
      const frames = framesOfInteraction(signals, 'unforced');
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        const decomposition = decomposeFrame(frame);
        const share = shareOfFrame(
          decomposition,
          decomposition.charges.unattributedMs,
          'frame-duration',
        );
        expect(share).not.toBeNull();

        /*
         * Measured at 88.9-90.3% of the frame (4x, both build modes): a 13-16ms
         * listener followed by 110-131ms in which no script was running.
         * Asserted at 70% because the quantity is the fixture's own composition
         * rather than a tuned threshold, and the margin is where the thermal
         * variation lives.
         *
         * Note which figure this is. It is not the arithmetic residual, which
         * is zero: the frame is fully *accounted for* and almost entirely
         * *unattributed*, and keeping those two apart is the whole reason the
         * charges exist.
         */
        expect(share?.fraction).toBeGreaterThan(0.7);

        // LoAF's own style and layout fields stay zero on a frame that is
        // almost entirely style and layout: work done before the rendering
        // update, while no script is running, is not counted in them. That is
        // specified behaviour, and it is why the time lands in a slice that
        // names when rather than what.
        expect(frame.renderingUpdate.kind).toBe('rendered');
        if (frame.renderingUpdate.kind === 'rendered') {
          expect(frame.renderingUpdate.styleDurationMs).toBe(0);
          expect(frame.renderingUpdate.layoutDurationMs).toBe(0);
        }
      }

      /*
       * The second signal, that the profiler found no JavaScript on the stack
       * for most of each of these frames, is the engine's cross-check and is
       * asserted per frame through `attributeCapture` in `accuracy.test.ts`.
       * It used to be asserted here by filtering samples into frame windows by
       * hand, which is the engine's job.
       */
    });

    it(`${mode}: the fixture's own probe says the thread was busy, not idle`, () => {
      /*
       * The third signal, and the one that makes the unattributed residual
       * *work* rather than idle time. An empty stack only says no JavaScript
       * was running; it does not say the thread was busy. The fixture
       * publishes what nothing outside the page can see: how long a
       * `MessageChannel` message posted at the end of the listener took to be
       * delivered. A listener of about 14ms followed by a wait of about
       * 120ms for a task it posted itself, figures rounded from the ranges
       * below, means the thread was occupied throughout.
       *
       * Measured on the unforced clicks (4x): listeners of 13.3-14.3ms and
       * deliveries of 116.7-148.8ms in development, 13.4-14.2ms and
       * 117.6-147.2ms in production, so every delivery is more than eight
       * times its listener. Asserted at three times, a 40ms listener ceiling
       * and a 60ms delivery floor: loose, because the claim is the shape, a
       * cheap listener and a long wait, not one capture's figures.
       *
       * Read from the capture's `fixtureProbe`, which the collector stores
       * verbatim and the engine never sees. The probe records one entry per
       * click whether or not LoAF reported a frame for it, so these are not
       * long frames.
       */
      const probe = arrayAt(loadCorpusRun('innerhtml-rebuild', mode).files.loaf, [
        'fixtureProbe',
      ])
        .map((record, index) => asRecord(record, ['fixtureProbe', index]))
        .filter((record) => stringAt(record, ['scenario']) === 'unforced');
      expect(probe.length).toBeGreaterThan(0);

      for (const record of probe) {
        const listener = numberAt(record, ['listenerTotalMs']);
        const delivered = numberAt(record, ['delays', 'messageChannelMs']);
        expect(listener).toBeLessThan(40);
        expect(delivered).toBeGreaterThan(60);
        // The delay is the frame's unnameable part, not the listener's own work.
        expect(delivered).toBeGreaterThan(listener * 3);
      }
    });

    it(`${mode}: forcing the same work inline charges it to the script that forced it`, () => {
      const signals = loadSignals('innerhtml-rebuild', mode);
      const frames = framesOfInteraction(signals, 'forced');
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        const decomposition = decomposeFrame(frame);

        /*
         * Measured at 94.9-103.8ms of forced style and layout per frame (4x,
         * both modes), inside script entries of 108.8-117.7ms. Asserted
         * loosely: the figure is the fixture's wall-clock burn plus however
         * long the browser takes to lay out 4,000 rows, and only the fact that
         * it is charged — once, to the script, as browser work rather than as
         * JavaScript — is the engine's business.
         */
        expect(decomposition.charges.browserRenderingMs).toBeGreaterThan(90);
        expect(decomposition.charges.browserRenderingMs).toBeLessThan(110);

        /*
         * The double-count check, which is the first thing `findings.md` says
         * an engine must get right. In the raw signal, each entry's forced
         * figure is nested inside its own `duration`, never beside it; so the
         * frame must still add up once it is charged.
         */
        for (const script of frame.scripts) {
          expect(script.forcedStyleAndLayoutDurationMs).toBeLessThanOrEqual(
            script.durationMs,
          );
        }
        const sliced = slicedMs(decomposition);
        expect(sliced).toBeLessThanOrEqual(
          frame.durationMs + COARSENED_TIMING_TOLERANCE_MS,
        );
        expect(decomposition.charges.javaScriptMs).toBeLessThan(
          decomposition.charges.browserRenderingMs,
        );

        // Still zero, though this frame is dominated by style and layout:
        // only the rendering update's own work lands in these fields.
        expect(frame.renderingUpdate.kind).toBe('rendered');
        if (frame.renderingUpdate.kind === 'rendered') {
          expect(frame.renderingUpdate.styleDurationMs).toBe(0);
          expect(frame.renderingUpdate.layoutDurationMs).toBe(0);
        }
      }
    });
  }
});

describe('vendor-listener: three slices, not one', () => {
  const declared = vendorListenerTruth().slices;

  /*
   * The fixture's scripts are served out of `public/`, which Vite copies
   * byte-for-byte in both build modes, so the repo's own copy *is* the text
   * the character offsets index into. That is what makes this check possible
   * with no capture of the text and no server. It is one of two fixtures
   * whose served bytes are in version control: `innerhtml-rebuild` also
   * serves its `app.js` from `public/`, and every one of its captured source
   * windows matches the repo's copy at its offset, in both build modes (4x).
   */
  const appJs = createScriptLineIndex(
    readRepoFile('fixtures/vendor-listener/public/app.js'),
  );

  for (const mode of BUILD_MODES) {
    it(`${mode}: the frame comes apart into its three listeners`, () => {
      const signals = loadSignals('vendor-listener', mode);
      expect(signals.frames.length).toBeGreaterThan(0);

      for (const frame of signals.frames) {
        const decomposition = decomposeFrame(frame);
        const scripts = decomposition.slices.filter((slice) => slice.kind === 'script');

        /*
         * Three sibling listeners on one button, which LoAF reports as three
         * script entries in one frame. Keeping them apart is the point: the
         * middle one is a vendor's, and a decomposition that merged them could
         * never produce a third-party share. All three resolve to the
         * first-party file that *registered* them, which is the other half of
         * the finding and why the share needs the profiler.
         */
        expect(scripts).toHaveLength(3);
        for (const slice of scripts) {
          expect(slice.script.sourceUrl).toContain('/app.js');
          expect(slice.script.sourceUrl).not.toContain('vendor.js');
        }

        // One of the three forces layout, and its forced work is charged inside
        // its own slice: measured at 100.0-104.2ms (4x, both modes) nested in a
        // script entry of 103.5-106.4ms.
        const forcing = scripts.filter(
          (slice) => slice.interior.forcedStyleAndLayoutMs > 50,
        );
        expect(forcing).toHaveLength(1);
      }
    });

    it(`${mode}: LoAF locates each listener at the line that registered it, in app.js`, () => {
      const signals = loadSignals('vendor-listener', mode);
      const entries = arrayAt(loadCorpusRun('vendor-listener', mode).files.loaf, [
        'entries',
      ]);
      expect(signals.frames.length).toBeGreaterThan(0);

      for (const [frameIndex, frame] of signals.frames.entries()) {
        /*
         * Each entry's `sourceCharPosition`, resolved against the served text,
         * lands on the `addEventListener` line the ground truth declares for
         * that slice, in registration order: offsets 9092, 9268 and 9443, lines
         * 188, 192 and 196, on every frame in both build modes (4x). The ground
         * truth anchors those lines, and the line after each, since the three
         * are byte-identical.
         */
        expect(frame.scripts.map((script) => script.sourceCharPosition)).toEqual(
          declared.map((slice) => slice.charPosition),
        );
        for (const [index, script] of frame.scripts.entries()) {
          const at = script.sourceCharPosition;
          expect(at, `script ${String(index)}`).not.toBeNull();
          if (at === null) continue;
          expect(lineColumnAt(appJs, at)?.line).toBe(declared[index]?.loafLine);

          /*
           * Two further halves of the same finding. `sourceFunctionName` is
           * absent for all three, because the listeners are anonymous arrows,
           * so the character offset did all the work: that is what makes it
           * worth resolving outside a framework. And `vendor.js` is named by
           * no entry, though one slice is entirely the vendor's: LoAF
           * attributes to the registration site, so its script attribution
           * reports a 100% first-party frame. A third-party share is not in
           * this signal; `accuracy.test.ts` asserts it from the profiler.
           */
          expect(script.sourceFunctionName).toBeNull();
          expect(script.sourceUrl).toContain('/app.js');
          expect(JSON.stringify(script)).not.toContain('vendor.js');

          // The absence is the reader's reading of Chrome's sentinel: the
          // entry as serialised carries the empty string the ground truth
          // declares "by construction", which the reader maps one to one.
          expect(
            stringAt(entries[frameIndex], [
              'toJSON',
              'scripts',
              index,
              'sourceFunctionName',
            ]),
          ).toBe(declared[index]?.loafSourceFunctionName);
        }
      }
      expect(declared.some((slice) => slice.isThirdParty)).toBe(true);
    });
  }
});
