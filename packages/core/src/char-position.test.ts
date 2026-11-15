import { describe, expect, it } from 'vitest';

import {
  charPositionAt,
  createScriptLineIndex,
  lineColumnAt,
  type LineColumn,
} from './char-position.ts';

/** Convenience for the common case of one lookup against one string. */
function positionIn(source: string, charPosition: number) {
  return lineColumnAt(createScriptLineIndex(source), charPosition);
}

/** As above, in the other direction. */
function offsetIn(source: string, position: LineColumn) {
  return charPositionAt(createScriptLineIndex(source), position);
}

describe('lineColumnAt', () => {
  it('reports the first character as line 1, column 0', () => {
    expect(positionIn('const a = 1;', 0)).toEqual({ line: 1, column: 0 });
  });

  it('counts columns within a line in UTF-16 code units', () => {
    expect(positionIn('const a = 1;', 6)).toEqual({ line: 1, column: 6 });
  });

  it('starts a new line after a line feed', () => {
    //                 0123 4567
    expect(positionIn('ab\ncd', 3)).toEqual({ line: 2, column: 0 });
    expect(positionIn('ab\ncd', 4)).toEqual({ line: 2, column: 1 });
  });

  it('treats CRLF as a single terminator', () => {
    // 'ab\r\ncd': the \r is at 2, the \n at 3, so 'c' is at offset 4 and must
    // land on line 2 column 0 — not line 3, which is what counting the \n as
    // its own terminator would give.
    expect(positionIn('ab\r\ncd', 4)).toEqual({ line: 2, column: 0 });
  });

  it('treats a lone carriage return as a terminator', () => {
    expect(positionIn('ab\rcd', 3)).toEqual({ line: 2, column: 0 });
  });

  // Written as escapes deliberately: a literal U+2028 in this file would be
  // treated as a line break by some editors and formatters, and the test
  // would then assert something other than what it reads as.
  it.each([
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
  ])('treats %s as a terminator, as V8 does', (_name, separator) => {
    expect(positionIn(`ab${separator}cd`, 3)).toEqual({ line: 2, column: 0 });
  });

  it('places a position on a line terminator at the end of the line it ends', () => {
    // Offset 2 is the \n itself. V8 reports such a position as the end of
    // line 1 rather than the start of line 2.
    expect(positionIn('ab\ncd', 2)).toEqual({ line: 1, column: 2 });
  });

  it('counts an astral-plane character as two columns', () => {
    // '😀' is a surrogate pair, so the character after it sits at offset 2.
    expect(positionIn('😀x', 2)).toEqual({ line: 1, column: 2 });
  });

  it('accepts a position one past the last character', () => {
    // The end of the script is a legitimate position: a function whose body
    // runs to the final byte of the bundle reports it.
    expect(positionIn('ab', 2)).toEqual({ line: 1, column: 2 });
  });

  it('handles empty lines and a trailing terminator', () => {
    const source = 'a\n\nb\n';
    expect(positionIn(source, 2)).toEqual({ line: 2, column: 0 });
    expect(positionIn(source, 3)).toEqual({ line: 3, column: 0 });
    expect(positionIn(source, 5)).toEqual({ line: 4, column: 0 });
  });

  it('indexes a realistically long single-line bundle', () => {
    // Minified output is one enormous line, which is the case the binary
    // search exists for and the one where an off-by-one is least visible.
    const source = `${'x'.repeat(100_000)}\ny`;
    expect(positionIn(source, 99_999)).toEqual({ line: 1, column: 99_999 });
    expect(positionIn(source, 100_001)).toEqual({ line: 2, column: 0 });
  });

  it('refuses a position past the end of the source', () => {
    // Signals a stale script text rather than a position worth resolving, so
    // it must not be clamped to the last line.
    expect(positionIn('ab', 3)).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the non-offset %p',
    (charPosition) => {
      expect(positionIn('ab\ncd', charPosition)).toBeNull();
    },
  );
});

describe('charPositionAt', () => {
  it('resolves the first position to offset 0', () => {
    expect(offsetIn('const a = 1;', { line: 1, column: 0 })).toBe(0);
  });

  it('adds the column to the start of the line', () => {
    //                      0123 4567
    expect(offsetIn('ab\ncd', { line: 2, column: 1 })).toBe(4);
  });

  it('counts a CRLF as one terminator when locating the next line', () => {
    // The \r is at 2 and the \n at 3, so line 2 starts at 4 — the same
    // arithmetic `lineColumnAt` does, and the reason both have to agree.
    expect(offsetIn('ab\r\ncd', { line: 2, column: 0 })).toBe(4);
  });

  it('accepts a column pointing at the line terminator', () => {
    // Offset 2 is the \n. `lineColumnAt` reports it as line 1 column 2, so
    // refusing it here would break the inverse on a position the other
    // direction produces.
    expect(offsetIn('ab\ncd', { line: 1, column: 2 })).toBe(2);
  });

  it('accepts the position one past the last character of the last line', () => {
    expect(offsetIn('ab', { line: 1, column: 2 })).toBe(2);
  });

  it('locates a position in a realistically long single-line bundle', () => {
    const source = `${'x'.repeat(100_000)}\ny`;
    expect(offsetIn(source, { line: 1, column: 99_999 })).toBe(99_999);
    expect(offsetIn(source, { line: 2, column: 0 })).toBe(100_001);
  });

  it('refuses a column that overruns its own line', () => {
    // The failure this prevents: without a per-line bound, 'ab\ncd' with
    // column 4 would answer 4 — a real offset, on the wrong line, resolving
    // through the source map to confidently wrong code.
    expect(offsetIn('ab\ncd', { line: 1, column: 3 })).toBeNull();
  });

  it('refuses a line past the end of the source', () => {
    expect(offsetIn('ab\ncd', { line: 3, column: 0 })).toBeNull();
  });

  it.each([
    ['a zero line, since lines are 1-based', { line: 0, column: 0 }],
    ['a negative line', { line: -1, column: 0 }],
    ['a negative column', { line: 1, column: -1 }],
    ['a fractional line', { line: 1.5, column: 0 }],
    ['a fractional column', { line: 1, column: 0.5 }],
    ['a NaN line', { line: Number.NaN, column: 0 }],
    ['an infinite column', { line: 1, column: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_name, position) => {
    expect(offsetIn('ab\ncd', position)).toBeNull();
  });

  /*
   * The property that makes the pair trustworthy, asserted exhaustively rather
   * than at a handful of points. Every offset in `[0, length]` is a position
   * `lineColumnAt` accepts, so every one of them must survive a round trip in
   * both directions — otherwise the window of served text the collector slices
   * out would not be the text the profiler frame pointed at, and the "served
   * text" link in `findings.md`'s resolution chain would be decoration.
   *
   * The source mixes every terminator the index understands, empty lines, a
   * trailing terminator and a surrogate pair, because those are where an
   * off-by-one hides.
   */
  it('round-trips every offset in a source using every terminator', () => {
    const source = 'ab\ncd\r\n\refg h \n😀i\n';
    const index = createScriptLineIndex(source);

    for (let offset = 0; offset <= source.length; offset += 1) {
      const position = lineColumnAt(index, offset);
      // Thrown rather than asserted so the compiler narrows `position` for the
      // assertion that follows, which is the one the test is about.
      if (position === null) {
        throw new Error(`lineColumnAt rejected the in-range offset ${String(offset)}`);
      }
      expect(charPositionAt(index, position)).toBe(offset);
    }
  });
});

describe('createScriptLineIndex', () => {
  it('reports one line for an empty script', () => {
    expect(createScriptLineIndex('')).toEqual({
      lineStarts: Uint32Array.of(0),
      sourceLength: 0,
    });
  });

  it('records a line start per terminator, including a trailing one', () => {
    // 'a\nb\n' ends with a terminator, so there is a fourth, empty line whose
    // start is one past the last character.
    expect(createScriptLineIndex('a\nb\n').lineStarts).toEqual(Uint32Array.of(0, 2, 4));
  });
});
