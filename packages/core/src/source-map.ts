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
 * claim can be "line 36, in the callback passed to `.sort`".
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
} from './char-position.ts';
import {
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

/**
 * One profiled frame, resolved as far as the capture allows.
 *
 * Every frame in the corpus is either `mapped` or `unmapped`. `unlocated` is
 * reasoned rather than measured: the API can report a native frame, and no
 * capture has one.
 */
export type FrameResolution =
  | {
      readonly kind: 'mapped';
      readonly frame: ProfiledFrame;
      /** The served script the frame ran in. */
      readonly scriptUrl: string;
      /** The profiler's position, converted once, in the served script. */
      readonly generated: LineColumn;
      /** The original position, through the map. */
      readonly original: Extract<SourceLocation, { throughSourceMap: true }>;
      /**
       * The map's name for the identifier at the original position, or `null`.
       * Present on every component in both production captures, and absent
       * from every development map, which carries an empty `names` array.
       */
      readonly originalName: string | null;
      /** Whether the map's `ignoreList` names the original source as library code. */
      readonly inIgnoredSource: boolean;
      /**
       * For an anonymous function, the call it was passed to, e.g. `.sort`,
       * when the map carries the original text. See `enclosingCallTokenAt`.
       */
      readonly enclosingCallToken: string | null;
    }
  | {
      readonly kind: 'unmapped';
      readonly frame: ProfiledFrame;
      readonly scriptUrl: string;
      /** In the served script, carrying the reason no map applied. */
      readonly generated: Extract<SourceLocation, { throughSourceMap: false }>;
    }
  | {
      readonly kind: 'unlocated';
      readonly frame: ProfiledFrame;
      readonly reason: UnlocatedReason;
    };

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
}

/**
 * A resource's map, ready for lookups, or the reason there is none.
 *
 * `TraceMap` decodes its mappings lazily on the first lookup, so building one
 * per mapped resource costs nothing for a resource no frame points into.
 */
type ResourceMap =
  | { readonly kind: 'map'; readonly map: TraceMap }
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
    // A malformed `mappings` string throws on decode. That is the map's
    // fault, not the capture's, and it degrades the resource rather than the
    // run.
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
  return map === null
    ? { kind: 'none', reason: 'source-map-unreadable' }
    : { kind: 'map', map };
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
    generated: { file: scriptUrl, position: generated, throughSourceMap: false, whyNot },
  });

  if (resourceMap.kind === 'none') return unmapped(resourceMap.reason);

  /*
   * The default bias, `GREATEST_LOWER_BOUND`, is the right one and the only
   * one that matters: on every frame in both `derive-in-render` builds it and
   * `LEAST_UPPER_BOUND` returned the same original position (`findings.md`,
   * point 4), because the maps are dense and the miss is a structural absent
   * segment, not a sparse map.
   */
  const { map } = resourceMap;
  const original = originalPositionFor(map, generated);
  if (original.source === null) return unmapped('no-mapping-at-position');

  const position = { line: original.line, column: original.column };
  const anonymous = frame.name === null && original.name === null;
  const text = anonymous ? sourceContentFor(map, original.source) : null;

  return {
    kind: 'mapped',
    frame,
    scriptUrl,
    generated,
    original: { file: original.source, position, throughSourceMap: true },
    originalName: original.name,
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
  return { trace, frames: trace.frames.map((frame) => resolveFrame(trace, maps, frame)) };
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
  switch (resolution.kind) {
    case 'mapped':
      return resolution.original;
    case 'unmapped':
      return resolution.generated;
    case 'unlocated':
      return null;
  }
}
