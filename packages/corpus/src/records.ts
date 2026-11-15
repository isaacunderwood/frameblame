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
 */

import type {
  CapturedSignals,
  CaptureProvenance,
  FrameRenderingUpdate,
  FrameScript,
  InteractionAction,
  InteractionWindow,
  LongAnimationFrame,
  ProfiledFrame,
  ProfiledSample,
  ProfiledStack,
  ProfileTrace,
  RawSourceMap,
  ReactCommit,
  ReactSignals,
  ReactSpan,
  RenderedFiber,
  ScriptResource,
  SourceMapOrigin,
  SpanProperty,
  UpdateOriginator,
} from '@frameblame/core';
import { COMPONENT_SPAN_PREFIX } from '@frameblame/core';

import {
  type BuildMode,
  type CorpusRun,
  envelopeOf,
  loadCorpusRun,
} from './corpus.ts';
import {
  arrayAt,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  get,
  isJsonArray,
  isJsonRecord,
  type Json,
  type JsonObject,
  type JsonPath,
  nullableNumberAt,
  nullableStringAt,
  numberAt,
  recordAt,
  stringAt,
} from './json.ts';

/** A string, or `null` when the dump holds the empty string Chrome uses for "none". */
function nonEmptyStringAt(value: Json | undefined, path: JsonPath): string | null {
  const found = nullableStringAt(value, path);
  return found === null || found === '' ? null : found;
}

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

/**
 * One script attribution, assembled from the two copies the capture stores.
 *
 * The capture writes each LoAF entry twice: whatever Chrome's own `toJSON()`
 * serialised, and a field-by-field projection the collector wrote by hand. They
 * agree on every shared field across all 80 entries in the corpus, and neither
 * is complete:
 *
 * - Only `toJSON` carries `forcedStyleDuration` and `forcedLayoutDuration`. The
 *   hand-written projection predates the discovery that Chrome ships them —
 *   `findings.md` still has an open item saying the split is unavailable from
 *   the entry — because the projection was written from the same hand-transcribed
 *   ambient declarations that missed them.
 * - Only the projection carries `sourceLine` and `sourceColumn`, which Chrome's
 *   `toJSON` omits entirely and which are `null` in every capture anyway,
 *   because the Blink features that populate them are off by default.
 *
 * So the authoritative copy is `toJSON`, and the projection is consulted for
 * exactly the two fields it alone has. Passing `projected` as `undefined` is
 * fine: both fields become `null`, which is what they are.
 */
function readScript(serialised: JsonObject, projected: Json | undefined): FrameScript {
  // Chrome's "unknown" sentinel is -1, and it is the only negative number
  // anywhere in the captured frames. Left as -1 it would be rejected by
  // `lineColumnAt` as a position outside the script, which is a true statement
  // about the wrong thing: the offset is absent, not out of range.
  const charPosition = numberAt(serialised, ['sourceCharPosition']);

  return {
    startTimeMs: numberAt(serialised, ['startTime']),
    durationMs: numberAt(serialised, ['duration']),
    executionStartMs: numberAt(serialised, ['executionStart']),
    invoker: stringAt(serialised, ['invoker']),
    invokerType: stringAt(serialised, ['invokerType']),
    sourceUrl: nonEmptyStringAt(serialised, ['sourceURL']),
    sourceFunctionName: nonEmptyStringAt(serialised, ['sourceFunctionName']),
    sourceCharPosition: charPosition < 0 ? null : charPosition,
    sourceLine: nullableNumberAt(projected, ['sourceLine']),
    sourceColumn: nullableNumberAt(projected, ['sourceColumn']),
    pauseDurationMs: numberAt(serialised, ['pauseDuration']),
    forcedStyleAndLayoutDurationMs: numberAt(serialised, ['forcedStyleAndLayoutDuration']),
    forcedStyleDurationMs: nullableNumberAt(serialised, ['forcedStyleDuration']),
    forcedLayoutDurationMs: nullableNumberAt(serialised, ['forcedLayoutDuration']),
    windowAttribution: stringAt(serialised, ['windowAttribution']),
  };
}

/**
 * The rendering update, or the fact that there was not one.
 *
 * `renderStart` is Chrome's flag as much as its timestamp: the spec says it and
 * `styleAndLayoutStart` return 0 when there was no rendering update, and the
 * two frames in the corpus that report 0 are both a bare `Promise.resolve` task
 * that never painted — one of them beginning at 60976.6ms, where a 0 could only
 * be a sentinel.
 *
 * Throws on a frame that reports a rendering update with no `paintTime`. That
 * combination does not occur in any capture and has no sensible arithmetic: the
 * end of `duration` is `paintTime` by definition, so a frame claiming to have
 * rendered without one is a frame whose boundaries cannot be established. A
 * loud failure in the adapter is the right place for it; the alternative is an
 * engine quietly deciding which half of the record to disbelieve.
 */
function readRenderingUpdate(frame: JsonObject, path: JsonPath): FrameRenderingUpdate {
  const renderStartMs = numberAt(frame, ['renderStart']);
  const paintTimeMs = nullableNumberAt(frame, ['paintTime']);

  if (renderStartMs === 0) {
    if (paintTimeMs !== null) {
      throw new Error(
        `${path.join('.')}: renderStart is 0, the spec's "no rendering update" sentinel, ` +
          'but the frame reports a paintTime',
      );
    }
    return { kind: 'none' };
  }

  if (paintTimeMs === null) {
    throw new Error(
      `${path.join('.')}: the frame reports a rendering update at ${String(renderStartMs)}ms ` +
        'but no paintTime, so the end of its duration cannot be established',
    );
  }

  return {
    kind: 'rendered',
    renderStartMs,
    styleAndLayoutStartMs: numberAt(frame, ['styleAndLayoutStart']),
    styleDurationMs: numberAt(frame, ['styleDuration']),
    layoutDurationMs: numberAt(frame, ['layoutDuration']),
    paintTimeMs,
    presentationTimeMs: nullableNumberAt(frame, ['presentationTime']),
  };
}

/** Every long animation frame in a run, in capture order. */
export function framesOf(run: CorpusRun): LongAnimationFrame[] {
  return arrayAt(run.files.loaf, ['entries']).map((entry, index) => {
    const path = ['entries', index] as const;
    const serialised = asRecord(get(entry, ['toJSON']), [...path, 'toJSON']);
    const projected = arrayAt(entry, ['scripts']);
    const scripts = arrayAt(serialised, ['scripts']);

    const firstUIEventTimestampMs = numberAt(serialised, ['firstUIEventTimestamp']);

    return {
      startTimeMs: numberAt(serialised, ['startTime']),
      durationMs: numberAt(serialised, ['duration']),
      blockingDurationMs: numberAt(serialised, ['blockingDuration']),
      // Zero means "there was no UI event", not "the UI event happened at time
      // zero" — and whether a frame is interaction-driven turns on it.
      firstUIEventTimestampMs:
        firstUIEventTimestampMs === 0 ? null : firstUIEventTimestampMs,
      renderingUpdate: readRenderingUpdate(serialised, [...path, 'toJSON']),
      scripts: scripts.map((script, scriptIndex) =>
        readScript(
          asRecord(script, [...path, 'toJSON', 'scripts', scriptIndex]),
          projected[scriptIndex],
        ),
      ),
      navigationId: nullableNumberAt(serialised, ['navigationId']),
    };
  });
}

/** A source map, field by field, so that nothing is cast into the engine's type. */
function readSourceMap(map: JsonObject, path: JsonPath): RawSourceMap {
  const strings = (key: string): readonly (string | null)[] =>
    arrayAt(map, [key]).map((entry, index) =>
      entry === null ? null : asString(entry, [...path, key, index]),
    );

  const names = get(map, ['names']);
  const sourcesContent = get(map, ['sourcesContent']);
  const file = get(map, ['file']);
  const sourceRoot = get(map, ['sourceRoot']);
  const ignoreList = get(map, ['ignoreList']);

  /*
   * Built with conditional spreads rather than by assigning `undefined`:
   * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
   * undefined", and the distinction is doing real work here. Five of the
   * corpus's ten maps have no `file` at all, and all eight development maps
   * carry `names` as an empty array rather than omitting it — which is the
   * difference between "this build minified nothing" and "this map cannot
   * recover a name".
   */
  return {
    version: numberAt(map, ['version']),
    sources: strings('sources'),
    mappings: stringAt(map, ['mappings']),
    ...(isJsonArray(names)
      ? { names: names.map((name, index) => asString(name, [...path, 'names', index])) }
      : {}),
    ...(isJsonArray(sourcesContent) ? { sourcesContent: strings('sourcesContent') } : {}),
    ...(typeof file === 'string' ? { file } : {}),
    ...(typeof sourceRoot === 'string' ? { sourceRoot } : {}),
    ...(isJsonArray(ignoreList)
      ? {
          ignoreList: ignoreList.map((entry, index) =>
            asNumber(entry, [...path, 'ignoreList', index]),
          ),
        }
      : {}),
  };
}

/**
 * The script resources the trace names, each with whatever the capture could
 * fetch for it.
 *
 * The join is the URL string, which is the only identifier the three files
 * share: the profiler reports a `resourceId` into `trace.resources`, LoAF
 * reports a `sourceURL`, and the capture's `resourceSources` is keyed by the
 * URL. Their key sets are equal in all eight runs.
 */
function readResources(profile: Json, path: JsonPath): ScriptResource[] {
  const urls = arrayAt(profile, [...path, 'trace', 'resources']);
  const sources = recordAt(profile, ['resourceSources']);

  return urls.map((entry, index) => {
    const url = asString(entry, [...path, 'trace', 'resources', index]);
    const source = sources[url];

    const map = source === undefined ? undefined : get(source, ['sourceMap']);
    const from = source === undefined ? null : nullableStringAt(source, ['sourceMapFrom']);
    const error = source === undefined ? undefined : get(source, ['error']);

    const origin: SourceMapOrigin | null =
      from === null ? null : from === 'inline' ? { kind: 'inline' } : { kind: 'external', url: from };

    return {
      url,
      servedLength: source === undefined ? null : nullableNumberAt(source, ['length']),
      sourceMap:
        isJsonRecord(map) && origin !== null
          ? { origin, map: readSourceMap(map, ['resourceSources', url, 'sourceMap']) }
          : null,
      /*
       * `null` on all 17 resources in the corpus, so the non-null shape is
       * unknown — hence the stringify rather than a narrowing. It is kept
       * because "this script shipped no source map" and "this script's source
       * map could not be fetched" degrade to the same tier but deserve
       * different warnings.
       */
      fetchError:
        error === null || error === undefined
          ? null
          : typeof error === 'string'
            ? error
            : JSON.stringify(error),
    };
  });
}

/**
 * The sampled profile, or `null` when the capture has none.
 *
 * `null` is the first degradation tier rather than a broken capture: without
 * `Document-Policy: js-profiling` on the document response there is no
 * `window.Profiler` at all. Every run in the corpus has a trace, so this branch
 * is reasoned rather than measured — the capture treats a missing profiler as a
 * hard error precisely so that a corpus entry can never be quietly weaker than
 * it looks.
 */
export function profileOf(run: CorpusRun): ProfileTrace | null {
  const profile = get(run.files.profile, ['profile']);
  if (!isJsonRecord(profile)) return null;

  const trace = get(profile, ['trace']);
  if (!isJsonRecord(trace)) return null;

  const frames: ProfiledFrame[] = arrayAt(trace, ['frames']).map((entry, index) => {
    const path = ['profile', 'trace', 'frames', index] as const;
    const frame = asRecord(entry, path);
    return {
      // Chrome reports an anonymous function and a module top level as the
      // empty string. 23 of the corpus's 156 frames are anonymous, and all of
      // them still carry a resource and a position.
      name: nonEmptyStringAt(frame, ['name']),
      resourceId: nullableNumberAt(frame, ['resourceId']),
      line: nullableNumberAt(frame, ['line']),
      column: nullableNumberAt(frame, ['column']),
    };
  });

  const stacks: ProfiledStack[] = arrayAt(trace, ['stacks']).map((entry, index) => {
    const path = ['profile', 'trace', 'stacks', index] as const;
    const stack = asRecord(entry, path);
    return {
      frameId: numberAt(stack, ['frameId']),
      // Omitted at a root rather than nulled, in every capture.
      parentId: nullableNumberAt(stack, ['parentId']),
    };
  });

  const samples: ProfiledSample[] = arrayAt(trace, ['samples']).map((entry, index) => {
    const path = ['profile', 'trace', 'samples', index] as const;
    const sample = asRecord(entry, path);
    return {
      atMs: numberAt(sample, ['timestamp']),
      // Omitted when no JavaScript was on the stack, which is the signal the
      // unattributed tier is cross-checked against — not a parse failure.
      stackId: nullableNumberAt(sample, ['stackId']),
    };
  });

  return {
    resources: readResources(run.files.profile, ['profile']),
    frames,
    stacks,
    samples,
    sampling: {
      requestedIntervalMs: nullableNumberAt(profile, ['requestedSampleInterval']),
      effectiveIntervalMs: nullableNumberAt(profile, ['effectiveSampleInterval']),
      maxBufferSize: nullableNumberAt(run.files.run, ['sampling', 'maxBufferSize']),
    },
    startedAtMs: nullableNumberAt(profile, ['startedAt']),
    stoppedAtMs: nullableNumberAt(profile, ['stoppedAt']),
  };
}

function readFiber(fiber: JsonObject): RenderedFiber {
  return {
    name: stringAt(fiber, ['name']),
    tag: numberAt(fiber, ['tag']),
    lanes: nullableNumberAt(fiber, ['lanes']),
    // Both are `null` on every fiber in a production build, where React does
    // not populate them at all. Absent, not zero: a component that rendered
    // for an unknown length of time is not one that rendered instantly.
    actualDurationMs: nullableNumberAt(fiber, ['actualDuration']),
    selfBaseDurationMs: nullableNumberAt(fiber, ['selfBaseDuration']),
  };
}

/** The `[label, value]` rows of a span's detail, parsed by label and never by index. */
function readSpanProperties(detail: Json | undefined): SpanProperty[] {
  const properties = get(detail, ['devtools', 'properties']);
  if (!isJsonArray(properties)) return [];

  const rows: SpanProperty[] = [];
  for (const row of properties) {
    if (!isJsonArray(row)) continue;
    const [label, value] = row;
    if (typeof label === 'string' && typeof value === 'string') {
      rows.push({ label, value });
    }
  }
  return rows;
}

/**
 * Who scheduled the update a phase span describes, where the span says.
 *
 * By label, because the rows are a variable-length list: the corpus's `Update`
 * spans carry both a component and a method, while its one `Update Blocked`
 * span carries only `[["Method name","root.render()"]]` — so reading row 0 as
 * the component name would name a method as a component.
 */
function readOriginator(properties: readonly SpanProperty[]): UpdateOriginator | null {
  const find = (label: string): string | null =>
    properties.find((property) => property.label === label)?.value ?? null;

  const componentName = find('Component name');
  const methodName = find('Method name');
  if (componentName === null && methodName === null) return null;

  return { componentName, methodName };
}

/**
 * React's commits and spans.
 *
 * Two reassemblies happen here. The capture pushes commit and post-commit
 * records into one array, tagged by `kind`, so a commit is paired with the
 * post-commit that follows it — React calls them in that order, and the dev
 * runs interleave them strictly. And a `performance.measure` entry is sorted
 * into a component span or a phase marker by the zero-width prefix on its name,
 * which is the only thing that distinguishes them: `Mount` sits on the same
 * track as the component spans, so keying on the track would misclassify it.
 */
export function reactOf(run: CorpusRun): ReactSignals {
  const hookInstalled = asBoolean(
    get(run.files.react, ['reactDevToolsHookInstalled']),
    ['reactDevToolsHookInstalled'],
  );

  const records = arrayAt(run.files.react, ['commits']).map((entry, index) =>
    asRecord(entry, ['commits', index]),
  );

  const commits: ReactCommit[] = [];
  for (const [index, record] of records.entries()) {
    const kind = stringAt(record, ['kind']);

    if (kind === 'post-commit') {
      /*
       * Attached to the most recent commit that has none. A production build
       * never calls `onPostCommitFiberRoot`, so every commit in both production
       * runs keeps `null` here — and in development the gap reached 50.6ms,
       * which is long enough that a post-commit is not safely inside its
       * commit's frame.
       */
      const previous = commits.at(-1);
      if (previous?.postCommitAtMs === null) {
        commits[commits.length - 1] = {
          ...previous,
          postCommitAtMs: numberAt(record, ['postCommitAt']),
        };
      }
      continue;
    }

    commits.push({
      committedAtMs: numberAt(record, ['committedAt']),
      postCommitAtMs: null,
      rendererId: numberAt(record, ['rendererId']),
      didError: asBoolean(get(record, ['didError']), ['commits', index, 'didError']),
      priorityLevel: nullableNumberAt(record, ['priorityLevel']),
      collectionCostMs: numberAt(record, ['collectionCost']),
      components: arrayAt(record, ['components']).map((component, componentIndex) =>
        readFiber(asRecord(component, ['commits', index, 'components', componentIndex])),
      ),
    });
  }

  const spans: ReactSpan[] = arrayAt(run.files.react, ['measures']).map((entry, index) => {
    const measure = asRecord(entry, ['measures', index]);
    const name = stringAt(measure, ['name']);
    const startTimeMs = numberAt(measure, ['startTime']);
    const durationMs = numberAt(measure, ['duration']);
    const properties = readSpanProperties(get(measure, ['detail']));

    return name.startsWith(COMPONENT_SPAN_PREFIX)
      ? {
          kind: 'component',
          componentName: name.slice(COMPONENT_SPAN_PREFIX.length),
          startTimeMs,
          durationMs,
          changedProps: properties,
        }
      : { kind: 'phase', phase: name, startTimeMs, durationMs, originator: readOriginator(properties) };
  });

  return { hookInstalled, commits, spans };
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
