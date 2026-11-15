/**
 * Slicing a window of served script text out around every position the signals
 * attributed anything to.
 *
 * This closes the third open item at the bottom of `findings.md`. The
 * resolution chain the project's central claim rests on has three links:
 *
 * ```
 * profiler frame   OrderTable.tsx (generated) 27:108
 * served text      ".sort((a, b) => a.customer.localeCompare(b.cust…"
 * Vite inline map  → OrderTable.tsx, original line 36
 * ```
 *
 * The v0.1 dumps stored the first and the third but not the second: each
 * resource's length and source map were kept, its text was not. So the chain
 * could be re-derived only while the dev server that served that exact
 * transform was still running — and in development Vite may retransform a
 * module at any time, which means the chain was effectively unverifiable the
 * moment a run finished. Storing whole bundles instead is not the fix;
 * react-dom's development build alone is over a megabyte.
 *
 * A few hundred characters either side of each attributed position is enough to
 * read, cheap to store, and — unlike a length — is evidence.
 *
 * The module computes positions and slices strings. It does not resolve source
 * maps: that is a separate step, done against the maps the dump already
 * carries, and keeping it separate is what lets this run before anything knows
 * what a component is.
 */

/*
 * Imported from `core`'s source rather than from the built package, so no
 * build step sits between editing the primitive and running the spike. The
 * published `exports` field still points at `dist`; only this script takes the
 * shortcut, and it is the same shortcut `tsconfig.base.json`'s `paths` takes
 * for the compiler.
 */
import {
  charPositionAt,
  createScriptLineIndex,
  lineColumnAt,
  type ScriptLineIndex,
} from '../packages/core/src/index.ts';

/**
 * How much text to keep either side of an attributed position.
 *
 * Wide enough to carry the enclosing expression — the `derive-in-render`
 * culprit is a three-line chained expression whose generated form is one line
 * of a few hundred characters — and narrow enough that several hundred
 * positions cost well under a megabyte.
 */
const WINDOW_RADIUS_CHARS = 250;

/** How much of the generated line to quote verbatim before eliding. */
const SERVED_LINE_MAX_CHARS = 300;

/** Which signal pointed at a position, and therefore how it was reported. */
export type PositionOrigin = 'profiler-frame' | 'loaf-script';

/** A position in core's convention: 1-based line, 0-based column. */
export interface ResolvedPosition {
  readonly line: number;
  readonly column: number;
  readonly charPosition: number;
}

export interface SourceWindow {
  readonly origin: PositionOrigin;
  readonly resourceUrl: string;
  /** The profiler's function name, or LoAF's invoker — whatever names it. */
  readonly label: string;
  /**
   * What the signal said, verbatim and unconverted, so the dump shows the raw
   * record next to the interpretation of it. Note the two conventions: the
   * profiler reports `line` and `column` both 1-based, while LoAF reports a
   * single 0-based `charPosition`.
   */
  readonly reported: {
    readonly charPosition?: number;
    readonly line?: number;
    readonly column?: number;
  };
  readonly resolved: ResolvedPosition;
  /** The generated line the position falls on, elided if long. */
  readonly servedLine: string;
  readonly servedText: {
    readonly startCharPosition: number;
    /** Index of the attributed character within `text`. */
    readonly caretOffset: number;
    readonly text: string;
  };
}

/**
 * A position that could not be turned into an offset in the served text.
 *
 * Kept rather than dropped. The most likely cause is that the text and the
 * position came from different builds — the dev server retransformed the module
 * between the profile and the fetch — and a dump that silently omitted those
 * would look complete while being partly unverifiable. `findings.md` records
 * the same reasoning for refusing to clamp an out-of-range offset.
 */
export interface UnresolvedPosition {
  readonly origin: PositionOrigin;
  readonly resourceUrl: string;
  readonly label: string;
  readonly reported: SourceWindow['reported'];
  readonly reason: string;
}

export interface SourceWindowSet {
  readonly windows: readonly SourceWindow[];
  readonly unresolved: readonly UnresolvedPosition[];
  /** Per-resource counts, so a reader can see what was attributed where. */
  readonly byResource: Readonly<Record<string, number>>;
}

/** The subset of a LoAF script entry this module reads. */
interface ScriptAttribution {
  readonly sourceURL?: unknown;
  readonly sourceCharPosition?: unknown;
  readonly sourceFunctionName?: unknown;
  readonly invoker?: unknown;
}

/** The subset of a collected LoAF record this module reads. */
interface FrameRecord {
  readonly scripts?: unknown;
}

/** One position to look up, before the text is consulted. */
interface Request {
  readonly origin: PositionOrigin;
  readonly resourceUrl: string;
  readonly label: string;
  readonly reported: SourceWindow['reported'];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/*
 * Written with escapes rather than literals, and as a named constant rather
 * than inline: U+2028 and U+2029 are LineTerminators, so a bare one inside a
 * regular expression literal is a syntax error, and some editors and
 * formatters treat them as line breaks and would move them.
 */
const TRAILING_TERMINATOR = /[\r\n\u2028\u2029]+$/;

/**
 * The text of one generated line, without its terminator, elided if long.
 *
 * This is the "served text" row of the resolution chain — the row a reader
 * actually recognises as their own code. Read through `at` so that a line
 * outside the index yields an empty string rather than a non-null assertion
 * whose guarantee would have to be argued.
 */
function servedLineAt(index: ScriptLineIndex, text: string, line: number): string {
  const lineIndex = line - 1;
  const start = index.lineStarts.at(lineIndex);
  if (start === undefined) return '';

  // No next line start means this is the last line, which runs to the end.
  const end = index.lineStarts.at(lineIndex + 1) ?? text.length;

  const raw = text.slice(start, end).replace(TRAILING_TERMINATOR, '');
  return raw.length > SERVED_LINE_MAX_CHARS
    ? `${raw.slice(0, SERVED_LINE_MAX_CHARS)}\u2026`
    : raw;
}

/**
 * Collects every position the profiler trace attributes samples to.
 *
 * A frame without a `resourceId` is a browser builtin or a native frame and has
 * no text to window. A frame without a `line` and `column` cannot be placed,
 * which is itself worth recording.
 */
function profilerRequests(trace: ProfilerTrace | null): Request[] {
  if (!trace) return [];

  const requests: Request[] = [];

  for (const frame of trace.frames) {
    if (frame.resourceId === undefined) continue;
    const resourceUrl = trace.resources[frame.resourceId];
    if (resourceUrl === undefined) continue;

    requests.push({
      origin: 'profiler-frame',
      resourceUrl,
      label: frame.name === '' ? '(anonymous)' : frame.name,
      reported: {
        ...(frame.line === undefined ? {} : { line: frame.line }),
        ...(frame.column === undefined ? {} : { column: frame.column }),
      },
    });
  }

  return requests;
}

/**
 * Collects every position LoAF's script attribution points at.
 *
 * `sourceCharPosition` is -1 when the browser does not know it, and the entries
 * worth windowing are the ones where it does. `findings.md` point 5 is what
 * makes this path matter: on non-framework jank the offset did all the work,
 * because `sourceFunctionName` was empty for all three anonymous-arrow
 * listeners in the frame.
 */
function loafRequests(entries: readonly unknown[]): Request[] {
  const requests: Request[] = [];

  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const { scripts } = entry as FrameRecord;
    if (!Array.isArray(scripts)) continue;

    for (const script of scripts as unknown[]) {
      if (!isObject(script)) continue;
      const attribution = script as ScriptAttribution;

      const { sourceURL, sourceCharPosition } = attribution;
      if (typeof sourceURL !== 'string' || sourceURL === '') continue;
      if (typeof sourceCharPosition !== 'number' || sourceCharPosition < 0) continue;

      const functionName =
        typeof attribution.sourceFunctionName === 'string' &&
        attribution.sourceFunctionName !== ''
          ? attribution.sourceFunctionName
          : null;
      const invoker =
        typeof attribution.invoker === 'string'
          ? attribution.invoker
          : '(unknown invoker)';

      requests.push({
        origin: 'loaf-script',
        resourceUrl: sourceURL,
        // The function name first where there is one, because that is what a
        // reader recognises; the invoker otherwise, which is the case the
        // anonymous-arrow finding turns on.
        label: functionName ?? invoker,
        reported: { charPosition: sourceCharPosition },
      });
    }
  }

  return requests;
}

/**
 * Every distinct script URL a LoAF script attribution named.
 *
 * Exported because the capture has to fetch these alongside the profiler's own
 * `resources`, and the two lists overlap without either containing the other:
 * LoAF names the script that *registered* a listener, while the profiler names
 * whatever was on the stack. `findings.md` point 5 is the case where they
 * disagree completely — a vendor's 12ms attributed by LoAF to the first-party
 * file that registered the listener, with `vendor.js` appearing nowhere in the
 * entry.
 *
 * Keeping this here rather than in the capture means one module knows the shape
 * of a collected LoAF record.
 */
export function loafScriptUrls(entries: readonly unknown[]): string[] {
  const urls = new Set<string>();
  for (const request of loafRequests(entries)) urls.add(request.resourceUrl);
  return [...urls];
}

/**
 * Returns a window of served text around every position the signals attributed
 * work to, plus the positions that could not be placed and why.
 *
 * `texts` maps a script URL to the exact bytes that URL served during the run;
 * a URL absent from it is reported as unresolved rather than skipped. Profiler
 * positions are converted from the API's 1-based line and column to core's
 * 1-based line and 0-based column on the way in — the conversion the whole
 * exercise is most likely to get wrong, and so done in exactly one place.
 *
 * All offsets are counted in UTF-16 code units, matching JavaScript string
 * indices, V8's script positions and LoAF's `sourceCharPosition`.
 */
export function collectSourceWindows(
  trace: ProfilerTrace | null,
  loafEntries: readonly unknown[],
  texts: ReadonlyMap<string, string>,
): SourceWindowSet {
  const indexes = new Map<string, ScriptLineIndex>();
  const windows: SourceWindow[] = [];
  const unresolved: UnresolvedPosition[] = [];
  const byResource: Record<string, number> = {};
  const seen = new Set<string>();

  for (const request of [...profilerRequests(trace), ...loafRequests(loafEntries)]) {
    const text = texts.get(request.resourceUrl);
    if (text === undefined) {
      unresolved.push({ ...request, reason: 'no text was captured for this resource' });
      continue;
    }

    let index = indexes.get(request.resourceUrl);
    if (!index) {
      index = createScriptLineIndex(text);
      indexes.set(request.resourceUrl, index);
    }

    const { reported } = request;
    let resolved: ResolvedPosition | null = null;

    if (reported.charPosition !== undefined) {
      const position = lineColumnAt(index, reported.charPosition);
      if (position) resolved = { ...position, charPosition: reported.charPosition };
    } else if (reported.line !== undefined && reported.column !== undefined) {
      /*
       * `ProfilerFrame.line` and `ProfilerFrame.column` are both 1-based per
       * spec, while source maps and `LineColumn` use a 0-based column. The
       * minus one is that conversion and nothing more.
       *
       * Worth knowing when reading the result: `findings.md` point 4 found the
       * resolved column lands one segment early, because esbuild and rolldown
       * emit no source-map segment for an arrow function's opening paren — and
       * that the column *minus one* resolves to the enclosing call's token,
       * identically in development and production. The window stored here is
       * centred on the position as reported, so both readings stay available.
       */
      const position = { line: reported.line, column: reported.column - 1 };
      const charPosition = charPositionAt(index, position);
      if (charPosition !== null) resolved = { ...position, charPosition };
    } else {
      unresolved.push({ ...request, reason: 'the signal reported no position' });
      continue;
    }

    if (!resolved) {
      unresolved.push({
        ...request,
        reason:
          'the position is not inside the captured text, so the two came from ' +
          'different builds of this script',
      });
      continue;
    }

    // Deduplicated on everything a reader could tell apart: two profiler
    // frames for the same function at the same position are one piece of
    // evidence, and a dev-mode replay produces many of them.
    const key = `${request.origin} ${request.resourceUrl} ${String(
      resolved.charPosition,
    )} ${request.label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const startCharPosition = Math.max(0, resolved.charPosition - WINDOW_RADIUS_CHARS);
    const endCharPosition = Math.min(
      text.length,
      resolved.charPosition + WINDOW_RADIUS_CHARS,
    );

    windows.push({
      origin: request.origin,
      resourceUrl: request.resourceUrl,
      label: request.label,
      reported,
      resolved,
      servedLine: servedLineAt(index, text, resolved.line),
      servedText: {
        startCharPosition,
        caretOffset: resolved.charPosition - startCharPosition,
        text: text.slice(startCharPosition, endCharPosition),
      },
    });

    byResource[request.resourceUrl] = (byResource[request.resourceUrl] ?? 0) + 1;
  }

  return { windows, unresolved, byResource };
}
