/**
 * Source-map resolution, against maps built by hand.
 *
 * The corpus resolves through real Vite and rolldown maps, and
 * `packages/corpus` asserts the answers. What it cannot show is each way a map
 * can fail to apply, and what one column either way does to the answer, which
 * is the off-by-one this module exists to get right once. The maps here are a
 * few segments each, encoded by the helper below.
 */

import { describe, expect, it } from 'vitest';

import type {
  ProfiledFrame,
  ProfileTrace,
  RawSourceMap,
  ScriptResource,
} from './profiler.ts';
import { enclosingCallTokenAt, resolvedStack, resolveProfile } from './source-map.ts';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One value in the source map spec's base64 VLQ. */
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += BASE64.charAt(digit);
  } while (rest > 0);
  return out;
}

/**
 * A segment as the spec stores it, every field 0-based: generated column,
 * source index, original line, original column, and optionally a name index.
 */
type Segment = readonly [number, number, number, number, number?];

/**
 * Encodes one segment list per generated line into a `mappings` string. The
 * generated column is relative within a line; the other fields are relative
 * across the whole map, as the spec requires.
 */
function encodeMappings(lines: readonly (readonly Segment[])[]): string {
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  return lines
    .map((segments) => {
      let generated = 0;
      return segments
        .map(([genColumn, src, origLine, origColumn, nameIndex]) => {
          let out = vlq(genColumn - generated) + vlq(src - source) + vlq(origLine - line);
          out += vlq(origColumn - column);
          generated = genColumn;
          source = src;
          line = origLine;
          column = origColumn;
          if (nameIndex !== undefined) {
            out += vlq(nameIndex - name);
            name = nameIndex;
          }
          return out;
        })
        .join(',');
    })
    .join(';');
}

/*
 * The original file, laid out like the corpus's culprit: a component declared
 * on line 2, and a member call on line 4 whose callback is the hot function.
 * Line 4's `.sort` starts at 0-based column 4, and its `sort` at column 5.
 */
const ORIGINAL = [
  '// the component',
  'export function Table({ rows }) {',
  '  const visible = rows',
  '    .sort((a, b) => a - b);',
  '  return visible;',
  '}',
].join('\n');

/*
 * One generated line, minified-style. Segments at generated columns 9 (`h`,
 * the component, named `Table`), 30 (`sort`) and nowhere at 35, the arrow's
 * paren, as esbuild and rolldown emit it. A library source, ignore-listed,
 * is mapped from generated column 60.
 */
const MAP: RawSourceMap = {
  version: 3,
  sources: ['src/Table.tsx', 'node_modules/react/index.js'],
  names: ['Table'],
  sourcesContent: [ORIGINAL, null],
  ignoreList: [1],
  mappings: encodeMappings([
    [
      [9, 0, 1, 16, 0],
      [30, 0, 3, 5],
      [60, 1, 0, 0],
    ],
  ]),
};

function resource(overrides: Partial<ScriptResource> = {}): ScriptResource {
  return {
    url: 'http://localhost/assets/index.js',
    servedLength: null,
    sourceMap: { origin: { kind: 'external', url: 'index.js.map' }, map: MAP },
    fetchError: null,
    ...overrides,
  };
}

/** A trace whose frames are given directly, with one sample per frame. */
function traceOf(
  frames: readonly ProfiledFrame[],
  resources: readonly ScriptResource[] = [resource()],
): ProfileTrace {
  return {
    resources,
    frames,
    stacks: frames.map((_, frameId) => ({ frameId, parentId: null })),
    samples: frames.map((_, stackId) => ({ atMs: stackId, stackId })),
    sampling: { requestedIntervalMs: 5, effectiveIntervalMs: 10, maxBufferSize: null },
    startedAtMs: 0,
    stoppedAtMs: 100,
  };
}

/** A profiler frame at a 1-based line and column, as the API reports it. */
function at(
  name: string | null,
  line: number,
  column: number,
  resourceId = 0,
): ProfiledFrame {
  return { name, resourceId, line, column };
}

describe('resolveProfile', () => {
  it('resolves a named function to its declaration, with the name the map gives back', () => {
    // Reported 1-based at 1:10, which is 0-based column 9: the `h` segment.
    const [component] = resolveProfile(traceOf([at('h', 1, 10)])).frames;
    expect(component).toMatchObject({
      kind: 'mapped',
      generated: { line: 1, column: 9 },
      definedAt: {
        file: 'src/Table.tsx',
        position: { line: 2, column: 16 },
        throughSourceMap: true,
      },
      originalName: 'Table',
      inIgnoredSource: false,
      // A named function's position is its own name, not a call.
      enclosingCallToken: null,
    });
  });

  it('lands an anonymous callback on the call it was passed to', () => {
    /*
     * Reported at 1:36, the arrow's paren, 0-based 35. No segment there, so
     * the lookup takes the one before it: `sort`, at original 4:5. That is the
     * structural miss `findings.md` records, and what makes `.sort` the token
     * worth printing.
     */
    const [callback] = resolveProfile(traceOf([at(null, 1, 36)])).frames;
    expect(callback).toMatchObject({
      kind: 'mapped',
      definedAt: { position: { line: 4, column: 5 } },
      originalName: null,
      enclosingCallToken: '.sort',
    });
  });

  it('never gives an anonymous callback the name of the call it landed on', () => {
    /*
     * The same map, except that the `sort` segment carries a name, as a
     * production map's member-call segments can. The anonymous callback still
     * lands on it, and the name there is `sort`'s, not the callback's: taking
     * it would report the comparator as a function called `sort`. No frame in
     * the corpus has this shape; the rule is what keeps one from going wrong.
     */
    const named: RawSourceMap = {
      ...MAP,
      names: ['Table', 'sort'],
      mappings: encodeMappings([
        [
          [9, 0, 1, 16, 0],
          [30, 0, 3, 5, 1],
          [60, 1, 0, 0],
        ],
      ]),
    };
    const [callback] = resolveProfile(
      traceOf(
        [at(null, 1, 36)],
        [
          resource({
            sourceMap: { origin: { kind: 'external', url: 'index.js.map' }, map: named },
          }),
        ],
      ),
    ).frames;
    expect(callback).toMatchObject({
      kind: 'mapped',
      definedAt: { position: { line: 4, column: 5 } },
      originalName: null,
      enclosingCallToken: '.sort',
    });
  });

  it('refuses an original line past the end of the source it names', () => {
    /*
     * A segment that sends generated column 80 to 0-based line 39 of a
     * six-line file: what a corrupt `mappings` string can decode to, since
     * `TraceMap` decodes leniently rather than throwing. It is reported as
     * not covered by the map rather than as a position that does not exist.
     */
    const corrupt: RawSourceMap = {
      ...MAP,
      mappings: encodeMappings([
        [
          [9, 0, 1, 16, 0],
          [30, 0, 3, 5],
          [60, 1, 0, 0],
          [80, 0, 39, 0],
        ],
      ]),
    };
    const [past, inside] = resolveProfile(
      traceOf(
        [at('x', 1, 81), at('h', 1, 10)],
        [
          resource({
            sourceMap: {
              origin: { kind: 'external', url: 'index.js.map' },
              map: corrupt,
            },
          }),
        ],
      ),
    ).frames;
    expect(past).toMatchObject({
      kind: 'unmapped',
      generated: { line: 1, column: 80 },
      definedAt: { throughSourceMap: false, whyNot: 'no-mapping-at-position' },
    });
    expect(inside).toMatchObject({
      kind: 'mapped',
      definedAt: { position: { line: 2 } },
    });
  });

  it('converts the profiler column exactly once', () => {
    /*
     * Reported at 1:31 is 0-based 30, exactly the `sort` segment. Had the
     * minus one been applied twice, 0-based 29 would fall back to the `h`
     * segment and name the component instead of the callback's call; had it
     * been skipped, the same position would read as 0-based 31, which this
     * map happens to resolve identically, and which is why the convention is
     * pinned at a segment boundary rather than inside one.
     */
    const [onSegment, oneLeft] = resolveProfile(
      traceOf([at(null, 1, 31), at(null, 1, 30)]),
    ).frames;
    expect(onSegment).toMatchObject({ definedAt: { position: { line: 4, column: 5 } } });
    expect(oneLeft).toMatchObject({ definedAt: { position: { line: 2, column: 16 } } });
  });

  it("records the map's ignore-list verdict on library code", () => {
    const [library] = resolveProfile(traceOf([at('Fd', 1, 61)])).frames;
    expect(library).toMatchObject({
      kind: 'mapped',
      definedAt: { file: 'node_modules/react/index.js' },
      inIgnoredSource: true,
    });
  });

  it('names why a frame is not through a map, one reason per way it can fail', () => {
    const resources = [
      resource({ sourceMap: null }),
      resource({ sourceMap: null, fetchError: 'HTTP 404' }),
      resource({
        sourceMap: { origin: { kind: 'inline' }, map: { ...MAP, version: 2 } },
      }),
      resource(),
    ];
    const resolved = resolveProfile(
      traceOf(
        [
          at('a', 1, 10, 0),
          at('b', 1, 10, 1),
          at('c', 1, 10, 2),
          // Before the first segment on the line.
          at('d', 1, 1, 3),
          { name: null, resourceId: null, line: null, column: null },
          { name: 'e', resourceId: 0, line: null, column: null },
          at('f', 1, 10, 9),
        ],
        resources,
      ),
    );

    expect(
      resolved.frames.map((frame) =>
        frame.kind === 'unmapped'
          ? frame.definedAt.whyNot
          : frame.kind === 'unlocated'
            ? frame.reason
            : frame.kind,
      ),
    ).toEqual([
      'no-source-map',
      'source-map-unavailable',
      'source-map-unreadable',
      'no-mapping-at-position',
      'no-resource',
      'no-position',
      'unknown-resource',
    ]);

    // The generated position is still reported, in the served script.
    expect(resolved.frames[0]).toMatchObject({
      generated: { line: 1, column: 9 },
      definedAt: {
        file: 'http://localhost/assets/index.js',
        position: { line: 1, column: 9 },
        throughSourceMap: false,
      },
    });
  });

  it('walks a stack leaf first over the resolved frames', () => {
    const trace: ProfileTrace = {
      ...traceOf([at('h', 1, 10), at(null, 1, 36)]),
      stacks: [
        { frameId: 0, parentId: null },
        { frameId: 1, parentId: 0 },
      ],
    };
    const resolved = resolveProfile(trace);
    expect(resolvedStack(resolved, 1).map((frame) => frame.frame.name)).toEqual([
      null,
      'h',
    ]);
    expect(resolvedStack(resolved, null)).toEqual([]);
  });
});

describe('enclosingCallTokenAt', () => {
  const text =
    'run(() => 1);\n  rows.sort((a) => a);\n  useEffect (() => {});\n  if (x) {}';

  it('reads a member call from its identifier or its dot', () => {
    expect(enclosingCallTokenAt(text, { line: 2, column: 7 })).toBe('.sort');
    expect(enclosingCallTokenAt(text, { line: 2, column: 6 })).toBe('.sort');
  });

  it('reads a plain call, across whitespace before the paren', () => {
    expect(enclosingCallTokenAt(text, { line: 1, column: 0 })).toBe('run');
    expect(enclosingCallTokenAt(text, { line: 3, column: 2 })).toBe('useEffect');
  });

  it('refuses a position that is not the start of a call', () => {
    // Mid-identifier: the segment is not the token's start.
    expect(enclosingCallTokenAt(text, { line: 2, column: 8 })).toBeNull();
    // An identifier not followed by `(`.
    expect(enclosingCallTokenAt(text, { line: 2, column: 2 })).toBeNull();
    // A keyword before a paren is not a call.
    expect(enclosingCallTokenAt(text, { line: 4, column: 2 })).toBeNull();
    // A position past the end of its line.
    expect(enclosingCallTokenAt(text, { line: 1, column: 400 })).toBeNull();
  });
});
