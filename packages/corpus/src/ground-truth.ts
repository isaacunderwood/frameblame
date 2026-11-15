/**
 * Checking a fixture's ground truth against the source it describes.
 *
 * A ground truth is full of line numbers, and line numbers drift the moment
 * somebody edits a component. The failure that causes is the worst kind:
 * nothing is broken, nothing throws, and the accuracy suite reports that the
 * tool attributed a frame to the wrong line — when in fact the tool was right
 * and the expectation had moved. `derive-in-render`'s ground truth answers this
 * by pairing every line number with the text that should be on it, so the suite
 * can assert the fixture is still the app the ground truth describes *before*
 * asserting anything about the tool. This module is that mechanism, applied
 * across every fixture.
 *
 * It walks the ground truth structurally rather than against a schema, because
 * the four fixtures declare genuinely different things — a culprit line range,
 * a span gate in React's own source, two scenarios, three slices of one frame —
 * and a schema that covered all four would either be empty or be a lie about
 * how similar they are. What they do share is a convention: a line number and
 * its `expectedSourceText`, inside the scope of a `sourceFile`.
 *
 * The module reads source files and compares strings. It knows nothing about
 * frames, attribution or what any particular fixture claims.
 */

import { readRepoFile } from './corpus.ts';
import { isJsonArray, isJsonRecord, type Json } from './json.ts';

/** One `line` plus `expectedSourceText` pair, with the file it applies to. */
export interface SourceAnchor {
  /**
   * Repo-relative, taken from the nearest `sourceFile` in scope. `null` when
   * the ground truth declared a line with no file anywhere above it, which is
   * a defect in the ground truth rather than in the fixture.
   */
  readonly sourceFile: string | null;
  readonly line: number;
  readonly expectedSourceText: string;
  /** Where in the ground truth this came from, for a legible failure. */
  readonly declaredAt: string;
}

/**
 * Collects every source anchor a ground truth declares.
 *
 * Scoping rule: an object's `sourceFile` applies to that object and everything
 * below it, so a container naming a file once covers a list of lines inside it
 * — which is how `spans` declares fourteen lines of React's own source and how
 * `vendor-listener` declares a file per slice.
 *
 * Two anchor shapes are recognised. The plain one is `line` with
 * `expectedSourceText`. The second is `nextLine` with
 * `nextLineExpectedSourceText` on the same object, which `vendor-listener`
 * needs because its three registration lines are byte-identical: the line after
 * each is the only thing that tells them apart, so the ground truth anchors
 * both and a drift in either is caught.
 */
export function collectSourceAnchors(groundTruth: Json): SourceAnchor[] {
  const anchors: SourceAnchor[] = [];

  function walk(node: Json, file: string | null, path: string): void {
    if (isJsonArray(node)) {
      node.forEach((child, index) => {
        walk(child, file, `${path}[${String(index)}]`);
      });
      return;
    }
    if (!isJsonRecord(node)) return;

    const scopedFile = typeof node.sourceFile === 'string' ? node.sourceFile : file;

    if (typeof node.line === 'number' && typeof node.expectedSourceText === 'string') {
      anchors.push({
        sourceFile: scopedFile,
        line: node.line,
        expectedSourceText: node.expectedSourceText,
        declaredAt: `${path}.line`,
      });
    }

    if (
      typeof node.nextLine === 'number' &&
      typeof node.nextLineExpectedSourceText === 'string'
    ) {
      anchors.push({
        sourceFile: scopedFile,
        line: node.nextLine,
        expectedSourceText: node.nextLineExpectedSourceText,
        declaredAt: `${path}.nextLine`,
      });
    }

    for (const [key, child] of Object.entries(node)) {
      walk(child, scopedFile, `${path}.${key}`);
    }
  }

  walk(groundTruth, null, '');
  return anchors;
}

/**
 * Returns `null` if the anchor still holds, or a message saying how it drifted.
 *
 * The comparison is containment of the trimmed expected text within the line,
 * not equality, because a ground truth quotes the part of a line that carries
 * the claim rather than reproducing its indentation and trailing punctuation.
 * Lines are 1-based, as every signal in this project reports them.
 */
export function checkSourceAnchor(anchor: SourceAnchor): string | null {
  if (anchor.sourceFile === null) {
    return `${anchor.declaredAt}: declares line ${String(anchor.line)} with no sourceFile in scope`;
  }

  const lines = readRepoFile(anchor.sourceFile).split('\n');
  const actual = lines[anchor.line - 1];

  if (actual === undefined) {
    return (
      `${anchor.declaredAt}: ${anchor.sourceFile} has ${String(lines.length)} lines, ` +
      `so line ${String(anchor.line)} does not exist`
    );
  }

  const expected = anchor.expectedSourceText.trim();
  if (!actual.includes(expected)) {
    return (
      `${anchor.declaredAt}: ${anchor.sourceFile}:${String(anchor.line)} should contain\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual.trim())}`
    );
  }

  return null;
}
