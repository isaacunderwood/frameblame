/**
 * Resolving the profiler's frames through the source maps the capture
 * carried: from a position in the script the browser ran to a position in the
 * file the developer wrote.
 *
 * This is the step that makes the profiler tier the whole production story. A
 * production bundle reports `h` at generated `9:50998`; resolved through its
 * shipped map, that is `OrderTable.tsx:32:16`, and the map's `names` array
 * gives `OrderTable` back. No React hook, no development build and no
 * build-time plugin is involved.
 *
 * ## Conventions
 *
 * Three conventions meet here, and this is where getting one wrong would be
 * silent. `ProfilerFrame.line` and `.column` are both 1-based. A source map's
 * column is 0-based, its line 1-based in `@jridgewell/trace-mapping`'s
 * `originalPositionFor`. `core`'s `LineColumn` is 1-based line with 0-based
 * column, which is exactly what that function takes and returns. So the only
 * conversion is the profiler's column minus one, and it happens in
 * `profiledFramePosition` and nowhere else; this module never adjusts a
 * position it has been handed.
 *
 * ## What a resolved position means
 *
 * The profiler reports where a function is *defined*, so a resolved position
 * is a definition site, never the statement that was running. For an
 * anonymous callback it is better than that sounds: esbuild and rolldown emit
 * no segment for an arrow function's opening paren, so the lookup lands on the
 * segment before it, which is the token of the call the arrow was passed to.
 * The corpus's declared culprit resolves to `OrderTable.tsx:36:5`, the `sort`
 * of `.sort((a, b) => ...)`, in both builds. That token is read back out of
 * the map's `sourcesContent` and carried as `enclosingCallToken`, so that the
 * claim can be "line 36, in the callback passed to `.sort`". It depends on the
 * lookup's bias; see the comment in `resolveFrame`.
 *
 * ## Library code
 *
 * A map's `ignoreList` names the sources its bundler considers library code:
 * Vite lists every `node_modules` source, so React, the JSX runtime and the
 * scheduler are ignore-listed in all four React captures, and the fixtures'
 * own files are not. The resolution records that flag and does nothing with it;
 * `line-attribution.ts` decides what to charge.
 *
 * ## What this module does not do
 *
 * It does not read a map off disk or the network: the caller hands over the
 * parsed map with the trace, which `packages/corpus` reads out of the dump. It
 * does not walk stacks, count samples or rank anything.
 */

import {
  GREATEST_LOWER_BOUND,
  isIgnored,
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from '@jridgewell/trace-mapping';

import type { SourceLocation, UnmappedReason } from './attribution.ts';
import {
  charPositionAt,
  createScriptLineIndex,
  type LineColumn,
  type ScriptLineIndex,
} from './char-position.ts';
import {
  independentSampleWeights,
  type ProfiledFrame,
  profiledFramePosition,
  type ProfileTrace,
  type RawSourceMap,
  type ScriptResource,
  stackFrameIds,
} from './profiler.ts';

/** Why a frame has no position to resolve at all. */
export type UnlocatedReason =
  /** No `resourceId`: a native frame. */
  | 'no-resource'
  /** A resource, but no line and column. */
  | 'no-position'
  /** A `resourceId` with no entry in `trace.resources`. */
  | 'unknown-resource';

/** What every frame with a position carries, whether or not a map applied. */
interface Located {
  readonly frame: ProfiledFrame;
  /** The served script the frame ran in. */
  readonly scriptUrl: string;
  /** The profiler's position, converted once, in the served script. */
  readonly generated: LineColumn;
}

/**
 * One profiled frame, resolved as far as the capture allows.
 *
 * A located frame carries `definedAt`, where its function is defined: in the
 * original file when a map applied, in the served script with the reason when
 * none did. Either way `generated` is the served position, so a frame's
 * identity never depends on whether it resolved.
 *
 * Every frame in the corpus is either `mapped` or `unmapped`. `unlocated` is
 * reasoned rather than measured: the API can report a native frame, and no
 * capture has one.
 */
export type FrameResolution =
  | (Located & {
      readonly kind: 'mapped';
      /** The original position, through the map. */
      readonly definedAt: Extract<SourceLocation, { throughSourceMap: true }>;
      /**
       * The map's name for the identifier at the original position, or `null`.
       * Present on every component in both production captures, and absent
       * from every development map, which carries an empty `names` array.
       *
       * Always `null` for a frame the profiler reports as anonymous. Such a
       * frame resolves to the segment before its own, which belongs to a
       * neighbouring token, the enclosing call, so any name the map gives
       * there is that token's and not the function's. Taken only from a named
       * frame, where the segment is the function's own name: `h` becomes
       * `OrderTable`.
       */
      readonly originalName: string | null;
      /** Whether the map's `ignoreList` names the original source as library code. */
      readonly inIgnoredSource: boolean;
      /**
       * For an anonymous function, the call it was passed to, e.g. `.sort`,
       * when the map carries the original text. See `enclosingCallTokenAt`.
       */
      readonly enclosingCallToken: string | null;
    })
  | (Located & {
      readonly kind: 'unmapped';
      /** In the served script, carrying the reason no map applied. */
      readonly definedAt: Extract<SourceLocation, { throughSourceMap: false }>;
    })
  | {
      readonly kind: 'unlocated';
      readonly frame: ProfiledFrame;
      readonly reason: UnlocatedReason;
    };

/**
 * A stable key for a profiled function: its resource and its definition site
 * there, as the profiler reported it.
 *
 * The raw 1-based line and column, unconverted. A key only has to tell sites
 * apart, so it needs no conversion, and leaving the position as reported keeps
 * `profiledFramePosition` the one place the column changes base. Two frames
 * with the same generated position are the same function; keying on the
 * original position as well would split nothing, since the map is a function
 * of the generated one. The React tier's name index and the profiler tier's
 * tallies both key on this, so the two can never disagree about which frames
 * are one function.
 */
export function generatedSiteKey(frame: ProfiledFrame): string {
  return `${String(frame.resourceId)}:${String(frame.line)}:${String(frame.column)}`;
}

/**
 * A profile with every frame resolved, computed once.
 *
 * The trace interns its frames, so a capture of 8,776 samples has only 19
 * distinct frames to resolve (`derive-in-render`, production, 4x), and every
 * sample's stack is a walk over indices into `frames` here.
 */
export interface ResolvedProfile {
  readonly trace: ProfileTrace;
  /** Aligned with `trace.frames`: entry `i` is frame `i`, resolved. */
  readonly frames: readonly FrameResolution[];
  /**
   * Aligned with `trace.samples`: how much independent evidence each sample
   * is, by `independentSampleWeights`. Computed once here so that every
   * share taken from the profile counts bursts the same way.
   */
  readonly independence: readonly number[];
}

/**
 * A resource's map, ready for lookups, or the reason there is none.
 *
 * `TraceMap` decodes its mappings lazily on the first lookup, so building one
 * per mapped resource costs nothing for a resource no frame points into.
 * `lineIndexOf` is lazy and cached for the same reason: React's development
 * map carries the whole of react-dom as `sourcesContent`, and only a frame
 * that resolves into a source needs its lines counted.
 */
type ResourceMap =
  | {
      readonly kind: 'map';
      readonly map: TraceMap;
      /** The original text's line index, or `null` when the map carries no text. */
      readonly lineIndexOf: (source: string) => ScriptLineIndex | null;
    }
  | { readonly kind: 'none'; readonly reason: UnmappedReason };

/**
 * The parsed map in the shape `TraceMap` reads, or `null` for a version this
 * project does not know how to read. Only version 3 exists in practice, and
 * all ten maps in the corpus are version 3.
 */
function traceMapOf(map: RawSourceMap): TraceMap | null {
  if (map.version !== 3) return null;

  /*
   * Spread conditionally rather than assigned `undefined`, because
   * `exactOptionalPropertyTypes` treats a present `undefined` as a different
   * thing from an absent key. `TraceMap` reads `x_google_ignoreList` as well;
   * the corpus reader carries only the standard `ignoreList`, which is what
   * Vite emits.
   */
  try {
    return new TraceMap({
      version: 3,
      sources: map.sources,
      names: map.names ?? [],
      mappings: map.mappings,
      ...(map.file === undefined ? {} : { file: map.file }),
      ...(map.sourceRoot === undefined ? {} : { sourceRoot: map.sourceRoot }),
      ...(map.sourcesContent === undefined ? {} : { sourcesContent: map.sourcesContent }),
      ...(map.ignoreList === undefined ? {} : { ignoreList: map.ignoreList }),
    });
  } catch {
    /*
     * Only a structural fault reaches here, such as a map with no `sources`
     * array. A malformed `mappings` string does not: `TraceMap` decodes
     * lazily and leniently, and garbage VLQ resolves silently to some
     * position rather than throwing. The original-line check in
     * `resolveFrame` is the cheap guard against the worst of that. Either way
     * it is the map's fault, not the capture's, and it degrades the resource
     * rather than the run.
     */
    return null;
  }
}

function resourceMapOf(resource: ScriptResource): ResourceMap {
  if (resource.sourceMap === null) {
    return {
      kind: 'none',
      reason: resource.fetchError === null ? 'no-source-map' : 'source-map-unavailable',
    };
  }
  const map = traceMapOf(resource.sourceMap.map);
  if (map === null) return { kind: 'none', reason: 'source-map-unreadable' };

  const lineIndexes = new Map<string, ScriptLineIndex | null>();
  const lineIndexOf = (source: string): ScriptLineIndex | null => {
    if (!lineIndexes.has(source)) {
      const text = sourceContentFor(map, source);
      lineIndexes.set(source, text === null ? null : createScriptLineIndex(text));
    }
    return lineIndexes.get(source) ?? null;
  };
  return { kind: 'map', map, lineIndexOf };
}

/*
 * Words that can stand before `(` without being a call. An anonymous
 * function expression resolves to its own `function` keyword, and a callback
 * whose map segment fell on a control-flow keyword would otherwise be
 * reported as "passed to if".
 */
const NOT_A_CALL = new Set([
  'async',
  'await',
  'catch',
  'for',
  'function',
  'if',
  'return',
  'switch',
  'typeof',
  'while',
  'with',
  'yield',
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[\w$]/;

/**
 * The call token at a position in original source text, e.g. `.sort` or
 * `useEffect`, or `null` when the text there is not the start of a call.
 *
 * `position` is a `LineColumn`, 1-based line and 0-based column, as
 * `originalPositionFor` returns it. Returns the identifier with its leading
 * `.` when it is a member call, and `null` unless the identifier is followed,
 * after optional whitespace, by `(`. Accepts a position on the `.` itself or
 * on the identifier's first character, and nothing in between, because a
 * position mid-identifier means the segment is not the token's start and the
 * guess would be a fragment. The corpus's culprit resolves to the identifier's
 * first character, the `s` of `.sort`.
 *
 * Meant for an anonymous function's resolved definition site, where the
 * missing paren segment puts it on the enclosing call. On a named function's
 * site the identifier is the function's own name, so the caller must not ask.
 */
export function enclosingCallTokenAt(
  sourceText: string,
  position: LineColumn,
): string | null {
  const offset = charPositionAt(createScriptLineIndex(sourceText), position);
  if (offset === null) return null;

  // On the `.` of a member call, step onto the identifier it introduces.
  const start = sourceText[offset] === '.' ? offset + 1 : offset;
  const first = sourceText[start];
  if (first === undefined || !IDENTIFIER_START.test(first)) return null;
  const before = sourceText[start - 1];
  if (before !== undefined && IDENTIFIER_PART.test(before)) return null;
  const member = before === '.';

  let end = start + 1;
  while (end < sourceText.length && IDENTIFIER_PART.test(sourceText.charAt(end)))
    end += 1;
  const identifier = sourceText.slice(start, end);
  if (NOT_A_CALL.has(identifier)) return null;

  let next = end;
  while (next < sourceText.length && /\s/.test(sourceText.charAt(next))) next += 1;
  if (sourceText[next] !== '(') return null;

  return member ? `.${identifier}` : identifier;
}

/**
 * Resolves one frame through its resource's map, if it has one. See
 * `FrameResolution` for what each outcome carries.
 */
function resolveFrame(
  trace: ProfileTrace,
  maps: readonly ResourceMap[],
  frame: ProfiledFrame,
): FrameResolution {
  if (frame.resourceId === null)
    return { kind: 'unlocated', frame, reason: 'no-resource' };
  const resource = trace.resources[frame.resourceId];
  const resourceMap = maps[frame.resourceId];
  if (resource === undefined || resourceMap === undefined) {
    return { kind: 'unlocated', frame, reason: 'unknown-resource' };
  }
  const generated = profiledFramePosition(frame);
  if (generated === null) return { kind: 'unlocated', frame, reason: 'no-position' };

  const scriptUrl = resource.url;
  const unmapped = (whyNot: UnmappedReason): FrameResolution => ({
    kind: 'unmapped',
    frame,
    scriptUrl,
    generated,
    definedAt: { file: scriptUrl, position: generated, throughSourceMap: false, whyNot },
  });

  if (resourceMap.kind === 'none') return unmapped(resourceMap.reason);

  /*
   * The bias is load-bearing, and `GREATEST_LOWER_BOUND` is required, not
   * merely the default. esbuild and rolldown emit no segment on an arrow
   * function's opening paren, so the profiler's position for an anonymous
   * callback falls between segments. With none at that column, GLB takes the
   * segment before it, which is the call token: `OrderTable.tsx:36:5`, the
   * `sort` of `.sort`. `LEAST_UPPER_BOUND` takes the one after, the arrow's
   * first parameter, at `36:11`.
   *
   * The two disagree on every mapped frame in the corpus, not only that one:
   * they agree on 0 of 27 in `derive-in-render` development and 0 of 19 in
   * production, and on 0 of 117 across `derive-in-render` and `spans` (v0.3
   * re-capture, 4x, both build modes). So no profiled position lands exactly
   * on a segment start, and the bias decides every lookup. `findings.md`
   * point 4 once recorded the opposite. Agreement appears only at the
   * unconverted 1-based column, and even there on 24 of 27 frames in
   * development and 15 of 19 in production, so it was most likely measured with the
   * off-by-one; the correction is appended there.
   */
  const { map, lineIndexOf } = resourceMap;
  const original = originalPositionFor(map, { ...generated, bias: GREATEST_LOWER_BOUND });
  if (original.source === null) return unmapped('no-mapping-at-position');

  /*
   * A sanity check against a map that decoded without complaint and is
   * wrong: an original line past the end of the source it names cannot be
   * a real position. `TraceMap` decodes leniently, so a corrupt `mappings`
   * string reaches here rather than failing at construction. Only checked
   * where the map carries the source's text; no frame in the corpus fails it.
   */
  const lineIndex = lineIndexOf(original.source);
  if (lineIndex !== null && original.line > lineIndex.lineStarts.length) {
    return unmapped('no-mapping-at-position');
  }

  const position = { line: original.line, column: original.column };
  // Only the profiler's own name says whether the function is anonymous: see
  // `originalName` on `FrameResolution` for why the map's name cannot.
  const anonymous = frame.name === null;
  const text = anonymous ? sourceContentFor(map, original.source) : null;

  return {
    kind: 'mapped',
    frame,
    scriptUrl,
    generated,
    definedAt: { file: original.source, position, throughSourceMap: true },
    originalName: anonymous ? null : original.name,
    inIgnoredSource: isIgnored(map, original.source),
    enclosingCallToken: text === null ? null : enclosingCallTokenAt(text, position),
  };
}

/**
 * Resolves every frame of a profile through the source maps carried with it.
 *
 * Returns one `FrameResolution` per entry of `trace.frames`, in the same
 * order. Assumes each resource's map, where present, is the map of the script
 * as it was served: a map from a different build resolves without complaint to
 * the wrong lines, and nothing here can detect that. The corpus captured each
 * map in the same session as its trace.
 */
export function resolveProfile(trace: ProfileTrace): ResolvedProfile {
  const maps = trace.resources.map(resourceMapOf);
  return {
    trace,
    frames: trace.frames.map((frame) => resolveFrame(trace, maps, frame)),
    independence: independentSampleWeights(trace),
  };
}

/**
 * A sample's stack as resolved frames, leaf first, with the same walk and the
 * same stop at a dangling index as `stackFrames`.
 */
export function resolvedStack(
  resolved: ResolvedProfile,
  stackId: number | null,
): readonly FrameResolution[] {
  return stackFrameIds(resolved.trace, stackId).flatMap((frameId) => {
    const resolution = resolved.frames[frameId];
    return resolution === undefined ? [] : [resolution];
  });
}

/**
 * Where a resolved frame's function is defined: the original position when a
 * map applied, the generated one otherwise, and `null` for an unlocated frame.
 */
export function definitionSite(resolution: FrameResolution): SourceLocation | null {
  return resolution.kind === 'unlocated' ? null : resolution.definedAt;
}
