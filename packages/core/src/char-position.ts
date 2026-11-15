/**
 * Translating between a character offset into a generated script and a line and
 * column within it.
 *
 * This exists because the two signals disagree about how to point at code. Long
 * Animation Frames reports script attribution as `sourceCharPosition`: a single
 * offset into the script resource. Source maps — and the JS Self-Profiling
 * API's own frames — are indexed by line and column. Nothing in the platform
 * bridges the two, which is the mechanical reason the RUM vendors that collect
 * `sourceCharPosition` all stop at reporting the raw number.
 *
 * The module holds that translation and nothing else. It does not read source
 * maps, fetch script text, or know what a frame is — it is handed a string and
 * a position and answers a question about them.
 *
 * Both directions are needed, by different paths:
 *
 * - **Offset to line and column** is the LoAF path. The profiler reports line
 *   and column directly, so attributing a frame to a component never passes
 *   through here; what does is every path where the profiler is absent or
 *   irrelevant — the degraded LoAF-only tier, third-party script attribution,
 *   and non-React code.
 * - **Line and column to offset** is the evidence path. A profiler frame names
 *   a position in a script that no longer exists once the dev server stops, so
 *   the collector stores a window of the served text around each attributed
 *   position, and slicing that window out of the script needs an offset. See
 *   `findings.md` on the "served text" link in the resolution chain, which the
 *   v0.1 dumps could not re-derive.
 */

/**
 * A position in a text resource.
 *
 * `line` is 1-based and `column` is 0-based, which is not an aesthetic choice:
 * it is exactly the convention `@jridgewell/trace-mapping` expects from
 * `originalPositionFor`, so a value of this type can be passed straight into a
 * source map lookup without an adjustment step that someone will eventually get
 * wrong. Both are counted in UTF-16 code units, matching JavaScript string
 * indices and V8's own script positions, so an astral-plane character counts as
 * two columns.
 */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * Precomputed line boundaries for one script, so that many lookups against the
 * same script cost one scan rather than one scan each.
 *
 * A long animation frame typically carries a handful of script attributions
 * pointing into the same bundle, and the profiler trace adds more, so the
 * index is built once per script resource and queried repeatedly.
 */
export interface ScriptLineIndex {
  /**
   * Offset of the first character of each line. Always starts with 0, so its
   * length is the number of lines in the script.
   *
   * A `Uint32Array` rather than `number[]`: these are non-negative integers
   * bounded by a script's length, a dev-mode React bundle runs to tens of
   * thousands of lines, and the binary search below walks it per lookup.
   */
  readonly lineStarts: Uint32Array;
  /** Length of the indexed source, in UTF-16 code units. */
  readonly sourceLength: number;
}

/*
 * The ECMAScript LineTerminator production is LF, CR, U+2028 LINE SEPARATOR and
 * U+2029 PARAGRAPH SEPARATOR, with CRLF counting as one break. V8 computes the
 * line numbers it reports — and therefore the ones a bundler's source map is
 * generated against — using that same set, not just LF.
 *
 * Bundled output is almost always LF-only, so the CR and separator branches
 * will rarely fire. They are here because the failure they prevent is silent:
 * miscounting one line yields a position that still resolves through the source
 * map, just to the wrong line of the user's component, and nothing downstream
 * can tell that it is wrong.
 *
 * https://tc39.es/ecma262/#sec-line-terminators
 */
const LF = 0x0a;
const CR = 0x0d;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/**
 * Scans `source` once and returns an index of its line start offsets.
 *
 * Assumes `source` is the exact text of the script the offsets refer to — the
 * generated bundle as served, not a prettified or re-minified copy. A mismatch
 * does not throw; it produces positions that are wrong in a way only the source
 * map lookup downstream might reveal.
 */
export function createScriptLineIndex(source: string): ScriptLineIndex {
  const lineStarts: number[] = [0];

  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);

    if (code === CR) {
      // CRLF is one terminator, so step over the LF rather than counting it.
      if (source.charCodeAt(i + 1) === LF) i += 1;
      lineStarts.push(i + 1);
    } else if (code === LF || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR) {
      lineStarts.push(i + 1);
    }
  }

  return { lineStarts: Uint32Array.from(lineStarts), sourceLength: source.length };
}

/*
 * `lineStarts` always holds at least one entry, and every caller below bounds
 * its index against `lineStarts.length` before reading — the binary search by
 * its loop invariant, `charPositionAt` by an explicit range check — so the
 * `undefined` that `noUncheckedIndexedAccess` models cannot occur. Routing
 * every read through one accessor states that guarantee once, instead of
 * leaving an unexplained `!` at each use.
 */
function startOfLine(lineStarts: Uint32Array, lineIndex: number): number {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- in range by the caller's loop invariant, as described above
  return lineStarts[lineIndex]!;
}

/**
 * Resolves a character offset to a line and column within an indexed script.
 *
 * Returns `null` when `charPosition` is negative, not an integer, or past the
 * end of the indexed source. That case is reported rather than clamped because
 * it means the offset and the script text came from different builds — the dev
 * server rebuilt between collection and resolution, say — and a clamped
 * position would turn that into a confident attribution to the last line of the
 * bundle.
 *
 * An offset pointing exactly at a line terminator belongs to the line the
 * terminator ends, which is how V8 reports such positions.
 */
export function lineColumnAt(
  index: ScriptLineIndex,
  charPosition: number,
): LineColumn | null {
  if (!Number.isInteger(charPosition) || charPosition < 0) return null;
  if (charPosition > index.sourceLength) return null;

  const { lineStarts } = index;

  // Binary search for the last line start at or before `charPosition`. `low`
  // ends up at the 0-based index of that line, which is why the search keeps
  // the invariant `lineStarts[low] <= charPosition` rather than bailing on an
  // exact hit.
  let low = 0;
  let high = lineStarts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >>> 1;

    if (startOfLine(lineStarts, mid) <= charPosition) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { line: low + 1, column: charPosition - startOfLine(lineStarts, low) };
}

/**
 * Resolves a line and column to a character offset within an indexed script —
 * the exact inverse of `lineColumnAt` over the positions that function can
 * return.
 *
 * `position.line` is 1-based and `position.column` is 0-based, matching
 * `LineColumn`. Note that this is *not* the JS Self-Profiling API's convention:
 * `ProfilerFrame.line` and `ProfilerFrame.column` are both 1-based, so a
 * profiler frame's column has to have one subtracted from it before it arrives
 * here. That conversion is left to the caller rather than hidden behind a flag,
 * because a function that silently accepts two conventions is a function that
 * will eventually be handed the wrong one.
 *
 * Returns `null` rather than clamping when the position does not exist in the
 * indexed source: a line past its end, a negative or non-integer line or
 * column, or a column reaching past the end of its own line. Every one of those
 * means the position and the script text came from different builds — the dev
 * server retransformed the module between collection and resolution, say — and
 * the alternative is a confident offset into unrelated code. `findings.md`
 * records the same reasoning for the other direction.
 *
 * A column pointing exactly at the line's terminator is in range, because that
 * is a position `lineColumnAt` reports; on the final line, so is one character
 * past the last, which is the end of the script.
 */
export function charPositionAt(
  index: ScriptLineIndex,
  position: LineColumn,
): number | null {
  const { line, column } = position;

  if (!Number.isInteger(line) || !Number.isInteger(column)) return null;
  if (column < 0) return null;

  const { lineStarts, sourceLength } = index;
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= lineStarts.length) return null;

  const charPosition = startOfLine(lineStarts, lineIndex) + column;

  /*
   * The upper bound is the start of the *next* line, not the source length:
   * `lineColumnAt` assigns each offset to exactly one line, so an offset at or
   * past the next line's start belongs to that line and reaching it from this
   * one means the column overran. Checking only against `sourceLength` would
   * accept `{ line: 1, column: 5000 }` on a five-line file and quietly answer
   * with a position five lines further down.
   *
   * On the last line there is no next line start, and the legitimate range
   * runs to one past the final character — the end-of-script position that
   * `lineColumnAt` accepts — hence the exclusive bound of `sourceLength + 1`.
   */
  const endOfLine =
    lineIndex + 1 < lineStarts.length
      ? startOfLine(lineStarts, lineIndex + 1)
      : sourceLength + 1;

  return charPosition < endOfLine ? charPosition : null;
}
