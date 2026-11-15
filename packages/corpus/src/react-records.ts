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
  booleanAt,
  get,
  isJsonArray,
  type Json,
  type JsonPath,
  nullableNumberAt,
  numberAt,
  stringAt,
} from './json.ts';

/*
 * Every reader below is handed the file's root and the full path to what it
 * reads, rather than an already-extracted record and a path relative to it. A
 * malformed fiber then fails naming where it is — `commits.3.components.1.flags
 * is undefined` — and never just `flags`, which in a file of 58 commits says
 * nothing about which one.
 */

function readFiber(root: Json, path: JsonPath): RenderedFiber {
  return {
    name: stringAt(root, [...path, 'name']),
    tag: numberAt(root, [...path, 'tag']),
    lanes: nullableNumberAt(root, [...path, 'lanes']),
    // Both are `null` on every fiber in a production build, where React does
    // not populate them at all. Absent, not zero: a component that rendered
    // for an unknown length of time is not one that rendered instantly.
    actualDurationMs: nullableNumberAt(root, [...path, 'actualDuration']),
    selfBaseDurationMs: nullableNumberAt(root, [...path, 'selfBaseDuration']),
  };
}

/**
 * The keys the v0.3 collector change added to each fiber. All present on every
 * fiber of a commit that change wrote, and none on a commit written before it.
 */
const LINKAGE_KEYS = ['id', 'parentId', 'flags', 'hasAlternate', 'carriedOver'] as const;

/**
 * A commit's fibers, linked into a tree where the collector recorded one.
 *
 * Which shape a commit has is read off the commit record, not inferred from its
 * fibers: the collector change that recorded the links also writes
 * `truncated` on every commit, so a commit with that key is `recorded` and one
 * without it is `unrecorded`. Keying on the commit means an empty fiber list
 * still says which collector wrote it, and means the fibers are then checked
 * against that answer rather than voting on it.
 *
 * Captures made before that change — every run in `corpus/` until the v0.3
 * re-capture — come back `unrecorded` rather than with a guessed tree. A guess
 * would be easy and plausible, since both React fixtures happen to be one root
 * over flat siblings, and it would be a claim about the capture that the
 * capture does not make.
 *
 * Either way the fibers must agree with the commit, and a fiber that does not
 * throws: a recorded commit's fiber missing its `id`, `parentId` or render
 * evidence, or an unrecorded commit's fiber carrying any of them, is something
 * no collector writes, so the record was damaged or written by something else.
 */
function readComponents(root: Json, commitPath: JsonPath): CommitComponents {
  const path = [...commitPath, 'components'];
  const fiberPaths = arrayAt(root, path).map((_, index) => [...path, index]);

  const truncated = get(root, [...commitPath, 'truncated']);
  if (truncated === undefined) {
    for (const fiberPath of fiberPaths) {
      const found = LINKAGE_KEYS.find(
        (key) => get(root, [...fiberPath, key]) !== undefined,
      );
      if (found !== undefined) {
        throw new Error(
          `${[...fiberPath, found].join('.')} is present, but the commit carries no ` +
            '`truncated`, so no collector that records fiber links wrote it',
        );
      }
    }
    return {
      linkage: 'unrecorded',
      fibers: fiberPaths.map((fiberPath) => readFiber(root, fiberPath)),
    };
  }

  return {
    linkage: 'recorded',
    truncated: asBoolean(truncated, [...commitPath, 'truncated']),
    fibers: fiberPaths.map((fiberPath, index) => readLinkedFiber(root, fiberPath, index)),
  };
}

/**
 * One fiber of a linked commit, its `id` and `parentId` checked against the
 * collector's scheme.
 *
 * Checked because the engine's self-time subtraction trusts them without
 * looking: each `id` is the fiber's index in the list, and each `parentId` is
 * `null` or an earlier `id`. Ids that break the scheme throw: no collector
 * writes them, so a record like that was damaged or written by something else,
 * and the adapter is the place to say so rather than an engine computing
 * negative self times from it.
 *
 * `parentId` is required even though it may be `null`: a root fiber's `null`
 * is written explicitly, so a missing key is a missing link, not a root.
 */
function readLinkedFiber(root: Json, path: JsonPath, index: number): LinkedFiber {
  const id = numberAt(root, [...path, 'id']);
  if (id !== index) {
    throw new Error(
      `${[...path, 'id'].join('.')}: id ${String(id)} is not the fiber's index ${String(index)}`,
    );
  }

  const parentPath = [...path, 'parentId'];
  if (get(root, parentPath) === undefined) {
    throw new Error(`${parentPath.join('.')} is undefined, expected a number or null`);
  }
  const parentId = nullableNumberAt(root, parentPath);
  if (
    parentId !== null &&
    !(Number.isInteger(parentId) && parentId >= 0 && parentId < id)
  ) {
    throw new Error(
      `${parentPath.join('.')}: parentId ${String(parentId)} does not name an earlier fiber ` +
        'in the commit',
    );
  }

  return {
    ...readFiber(root, path),
    id,
    parentId,
    // Required wherever the links are: the collector change that recorded
    // one recorded the other, so a fiber with an id and no evidence is not
    // something any collector wrote.
    render: {
      flags: numberAt(root, [...path, 'flags']),
      hasAlternate: booleanAt(root, [...path, 'hasAlternate']),
      carriedOver: booleanAt(root, [...path, 'carriedOver']),
    },
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
  const hookInstalled = booleanAt(run.files.react, ['reactDevToolsHookInstalled']);

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
      // Whether the walk was complete is part of `components`, and absent from
      // captures that predate it rather than `false`: an old capture never said
      // its walk was complete.
      components: readComponents(run.files.react, ['commits', index]),
    });
  }

  const spans: ReactSpan[] = arrayAt(run.files.react, ['measures']).map(
    (entry, index) => {
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
        : {
            kind: 'phase',
            phase: name,
            startTimeMs,
            durationMs,
            originator: readOriginator(properties),
          };
    },
  );

  return { hookInstalled, commits, spans };
}
