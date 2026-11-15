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
 * handed over as the subtree time the capture recorded; turning it into self
 * time is the React tier's job, in the engine.
 */

import type {
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
