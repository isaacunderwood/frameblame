/**
 * Turning a captured run directory into the engine's record types.
 *
 * This is the adapter between the dumps and `@frameblame/core`: it knows the
 * capture's file layout and Chrome's sentinels, and it hands over
 * `CapturedSignals` with every absence spelled `null` and nothing left as
 * loosely-typed JSON. A live collector would be the other adapter against the
 * same types, which is what keeps the engine free of I/O and makes these eight
 * captures a real test input.
 *
 * Three jobs, and they are the only three:
 *
 * 1. **Navigate the dump.** The readers in `json.ts` throw a message naming the
 *    path when a field has moved, so a changed capture fails as a changed
 *    capture rather than as an inaccurate engine.
 * 2. **Translate Chrome's sentinels into absence.** A `sourceCharPosition` of
 *    -1, a `sourceURL` of `""`, a `firstUIEventTimestamp` of 0 and a
 *    `renderStart` of 0 all mean "there was none", and every one of them is a
 *    number or a string that arithmetic would happily consume. This is the
 *    layer that stops them reaching the engine.
 * 3. **Reassemble what the capture split.** The frame record and its script
 *    attributions are stored twice, from two different projections, and neither
 *    copy is complete; the commits and post-commits arrive interleaved in one
 *    array. Both are put back together here.
 *
 * It deliberately does no attribution, no correlation and no scoring, and it
 * holds no opinion about what any figure means.
 *
 * The adapter is split by signal, because the three share nothing but these
 * jobs: `loaf-records.ts` reads the frames, `profiler-records.ts` the sampled
 * trace and its source maps, and `react-records.ts` the commits and spans. This
 * module holds what belongs to the run rather than to any one signal — its
 * provenance and its interaction windows — and assembles the whole.
 */

import type {
  CapturedSignals,
  CaptureProvenance,
  InteractionAction,
  InteractionWindow,
} from '@frameblame/core';

import {
  type BuildMode,
  type CorpusRun,
  envelopeOf,
  loadCorpusRun,
} from './corpus.ts';
import { arrayAt, asBoolean, asRecord, get, numberAt, stringAt } from './json.ts';
import { framesOf } from './loaf-records.ts';
import { profileOf } from './profiler-records.ts';
import { reactOf } from './react-records.ts';

/**
 * The provenance every file of the run repeats, read once.
 *
 * Taken from `run.json` because the corpus's own consistency test has already
 * asserted that all five files agree; reading it five times here would be
 * re-checking that in the wrong place.
 */
export function provenanceOf(run: CorpusRun): CaptureProvenance {
  const envelope = envelopeOf(run, 'run');

  return {
    runId: envelope.runId,
    subject: envelope.fixture,
    buildMode: run.mode,
    buildModeDescription: envelope.buildMode,
    cpuThrottleRate: envelope.cpuThrottleRate,
    browser: envelope.browser,
    collectedAt: envelope.collectedAt,
  };
}

/** The interaction windows a run's drive plan produced, in plan order. */
export function interactionsOf(run: CorpusRun): InteractionWindow[] {
  return arrayAt(run.files.run, ['steps']).map((entry, index) => {
    const step = asRecord(entry, ['steps', index]);

    const actions: InteractionAction[] = arrayAt(step, ['actions']).map(
      (action, actionIndex) => {
        const path = ['steps', index, 'actions', actionIndex] as const;
        const record = asRecord(action, path);
        return {
          index: numberAt(record, ['index']),
          what: stringAt(record, ['what']),
          atMs: numberAt(record, ['atPageClock']),
          sawLongFrame: asBoolean(get(record, ['sawNewFrame']), [...path, 'sawNewFrame']),
        };
      },
    );

    return {
      label: stringAt(step, ['label']),
      kind: stringAt(step, ['kind']),
      // Zero on a step that covers the document from its beginning, which is
      // the only way to contain a first mount: React's mount commit lands while
      // the navigation is still in progress.
      fromMs: numberAt(step, ['startedAtPageClock']),
      toMs: numberAt(step, ['endedAtPageClock']),
      actions,
    };
  });
}

/** One captured run, as the engine's input. */
export function signalsOf(run: CorpusRun): CapturedSignals {
  return {
    provenance: provenanceOf(run),
    frames: framesOf(run),
    profile: profileOf(run),
    react: reactOf(run),
    interactions: interactionsOf(run),
  };
}

/** Reads one run off disk and returns it as the engine's input. */
export function loadSignals(fixture: string, mode: BuildMode): CapturedSignals {
  return signalsOf(loadCorpusRun(fixture, mode));
}
