/**
 * The JS Self-Profiling half of the corpus adapter: `profile.json` into a
 * `ProfileTrace`.
 *
 * The trace is stored as Chrome hands it over — interned frames, stacks as
 * parent-linked ids, samples pointing into the stacks — plus what the capture
 * fetched for every script resource the trace names, source map included.
 * This module reads both, field by field, so that a source map reaches the
 * engine as a typed `RawSourceMap` rather than as JSON cast into one.
 *
 * It deliberately does not walk a stack, resolve a position through a source
 * map, or decide which samples fall inside a frame. Those are the profiler
 * tier's heuristics, and they belong to the engine.
 */

import type {
  ProfiledFrame,
  ProfiledSample,
  ProfiledStack,
  ProfileTrace,
  RawSourceMap,
  ScriptResource,
  SourceMapOrigin,
} from '@frameblame/core';

import type { CorpusRun } from './corpus.ts';
import {
  arrayAt,
  asNumber,
  asRecord,
  asString,
  get,
  isJsonArray,
  isJsonRecord,
  type Json,
  type JsonObject,
  type JsonPath,
  nonEmptyStringAt,
  nullableNumberAt,
  nullableStringAt,
  numberAt,
  recordAt,
  stringAt,
} from './json.ts';

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
    // `undefined` for a resource the capture fetched nothing for, which every
    // read below takes as absence: no length, no map, no error.
    const source = sources[url];

    const map = get(source, ['sourceMap']);
    const from = nullableStringAt(source, ['sourceMapFrom']);
    const error = get(source, ['error']);

    const origin: SourceMapOrigin | null =
      from === null ? null : from === 'inline' ? { kind: 'inline' } : { kind: 'external', url: from };

    return {
      url,
      servedLength: nullableNumberAt(source, ['length']),
      sourceMap:
        isJsonRecord(map) && origin !== null
          ? { origin, map: readSourceMap(map, ['resourceSources', url, 'sourceMap']) }
          : null,
      /*
       * `null` on all 16 resources in the corpus, so the non-null shape is
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
      // empty string. 23 of the corpus's 136 frames are anonymous, and all of
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
