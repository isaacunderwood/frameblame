/**
 * The React half of the corpus adapter: `react-commits.json` into
 * `ReactSignals`.
 *
 * Two streams arrive in that file and both need reassembling: the DevTools
 * hook's commit and post-commit records, pushed into one array in call order,
 * and React's own `performance.measure` entries, where a component span and a
 * phase marker are told apart only by a zero-width prefix on the name.
 *
 * It deliberately does not compute a component's self time, link a commit to a
 * frame, or treat a span as evidence of anything. A fiber's `actualDuration` is
 * handed over as the subtree time the capture recorded, with the parent link
 * the collector recorded beside it where it did; turning the two into self
 * time is the React tier's job, in the engine.
 */

import type {
  CommitComponents,
  LinkedFiber,
  ReactCommit,
  ReactSignals,
  ReactSpan,
  RenderedFiber,
  SpanProperty,
  UpdateOriginator,
} from '@frameblame/core';
import { COMPONENT_SPAN_PREFIX } from '@frameblame/core';

import type { CorpusRun } from './corpus.ts';
import {
  arrayAt,
  asBoolean,
  asRecord,
  get,
  isJsonArray,
  type Json,
  type JsonObject,
  type JsonPath,
  nullableBooleanAt,
  nullableNumberAt,
  numberAt,
  stringAt,
} from './json.ts';

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

/**
 * A commit's fibers, linked into a tree where the collector recorded one.
 *
 * Captures made before the collector recorded `id`, `parentId` and the render
 * evidence — every run in `corpus/` until the v0.3 re-capture — have none of
 * those keys on any fiber, and
 * come back `unrecorded` rather than with a guessed tree. A guess would be easy
 * and plausible, since both React fixtures happen to be one root over flat
 * siblings, and it would be a claim about the capture that the capture does not
 * make.
 *
 * Where the keys are present they are checked against the collector's scheme,
 * because the engine's self-time subtraction trusts them without looking: each
 * `id` is the fiber's index in the list, and each `parentId` is `null` or an
 * earlier `id`. A commit with the keys on some fibers and not others, or ids
 * that break the scheme, throws: no collector writes either, so a record like
 * that was damaged or written by something else, and the adapter is the place
 * to say so rather than an engine computing negative self times from it.
 *
 * An empty list is `unrecorded`, since it cannot show which collector wrote it.
 */
function readComponents(entries: readonly Json[], path: JsonPath): CommitComponents {
  const records = entries.map((entry, index) => asRecord(entry, [...path, index]));

  const withLinks = records.filter((record) => get(record, ['id']) !== undefined).length;
  if (withLinks === 0) return { linkage: 'unrecorded', fibers: records.map(readFiber) };
  if (withLinks !== records.length) {
    throw new Error(
      `${path.join('.')}: ${String(withLinks)} of ${String(records.length)} fibers carry ` +
        'an id, so the commit is neither linked nor flat',
    );
  }

  const linked: LinkedFiber[] = records.map((record, index) => {
    const where = [...path, index].join('.');
    const id = numberAt(record, ['id']);
    const parentId = nullableNumberAt(record, ['parentId']);
    if (id !== index) {
      throw new Error(`${where}: id ${String(id)} is not the fiber's index ${String(index)}`);
    }
    if (parentId !== null && !(Number.isInteger(parentId) && parentId >= 0 && parentId < id)) {
      throw new Error(
        `${where}: parentId ${String(parentId)} does not name an earlier fiber in the commit`,
      );
    }
    return {
      ...readFiber(record),
      id,
      parentId,
      // Required wherever the links are: the collector change that recorded
      // one recorded the other, so a fiber with an id and no evidence is not
      // something any collector wrote.
      render: {
        flags: numberAt(record, ['flags']),
        hasAlternate: asBoolean(get(record, ['hasAlternate']), [...path, index, 'hasAlternate']),
        carriedOver: asBoolean(get(record, ['carriedOver']), [...path, index, 'carriedOver']),
      },
    };
  });
  return { linkage: 'recorded', fibers: linked };
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
       * runs keeps `null` here — and in development the gap reached 52.5ms
       * (4x), which is long enough that a post-commit is not safely inside its
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
      // Absent from captures that predate it, and `null` there rather than
      // `false`: an old capture never said its walk was complete.
      truncated: nullableBooleanAt(record, ['truncated']),
      components: readComponents(arrayAt(record, ['components']), [
        'commits',
        index,
        'components',
      ]),
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
