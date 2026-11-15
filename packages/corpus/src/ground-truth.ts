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
 * The second convention is the tier a claim is made at. A ground truth states
 * it in prose — "React DevTools hook plus fiber actualDuration", "the
 * profiler" — and, beside the prose, as a `declaredTier`: an object keyed by
 * build mode whose values are the engine's own `AttributionTier` names. The
 * accuracy suite asserts the engine's answer against that, so the names are
 * checked here against the engine's list before anything is asserted with
 * them. A misspelt tier would otherwise fail as a wrong attribution, which is
 * the same misdirection a drifted line number causes. A build mode a
 * declaration leaves out is one the fixture makes no claim about, and reads as
 * `null` rather than as a default.
 *
 * The module reads source files, compares strings and checks tier names
 * against the engine's vocabulary. It knows nothing about frames or about what
 * the engine answers.
 */

import { ATTRIBUTION_TIERS, type AttributionTier } from '@frameblame/core';

import { BUILD_MODES, type BuildMode, readRepoFile } from './corpus.ts';
import {
  get,
  isJsonArray,
  isJsonRecord,
  type Json,
  type JsonObject,
  type JsonPath,
} from './json.ts';

/**
 * Renders a path into a ground truth the one way every message here names a
 * place: `.key` for an object step and `[i]` for an array index, from the
 * root. `['expected', 'slices', 0, 'declaredTier']` is
 * `.expected.slices[0].declaredTier`, and the root itself is the empty string.
 */
function formatPath(path: JsonPath): string {
  return path
    .map((step) => (typeof step === 'number' ? `[${String(step)}]` : `.${step}`))
    .join('');
}

/** What an object in a ground truth inherits from the objects above it. */
interface RecordScope {
  /**
   * The `sourceFile` of the object itself, or else of its nearest ancestor
   * that names one; `null` when none does.
   */
  readonly sourceFile: string | null;
  /** Where the object sits, as `formatPath` renders it. */
  readonly path: string;
}

/**
 * Visits every object in a ground truth, depth first and parents before
 * children, with the scope it inherits.
 *
 * Scoping rule: an object's `sourceFile` applies to that object and everything
 * below it, so a container naming a file once covers a list of lines inside it
 * — which is how `spans` declares fourteen lines of React's own source and how
 * `vendor-listener` declares a file per slice.
 *
 * Every value is walked into, a `declaredTier` included. A well-formed
 * declaration is build modes mapped to tier names, so nothing inside one can
 * be an anchor or another declaration, and a malformed one is reported by
 * `checkTierDeclaration` whether or not its inside is visited.
 */
function forEachRecord(
  groundTruth: Json,
  visit: (record: JsonObject, scope: RecordScope) => void,
): void {
  function walk(node: Json, sourceFile: string | null, path: JsonPath): void {
    if (isJsonArray(node)) {
      node.forEach((child, index) => {
        walk(child, sourceFile, [...path, index]);
      });
      return;
    }
    if (!isJsonRecord(node)) return;

    const scoped = typeof node.sourceFile === 'string' ? node.sourceFile : sourceFile;
    visit(node, { sourceFile: scoped, path: formatPath(path) });
    for (const [key, child] of Object.entries(node)) {
      walk(child, scoped, [...path, key]);
    }
  }

  walk(groundTruth, null, []);
}

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
 * Collects every source anchor a ground truth declares, each with the
 * `sourceFile` in scope under `forEachRecord`'s scoping rule.
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

  forEachRecord(groundTruth, (node, { sourceFile, path }) => {
    if (typeof node.line === 'number' && typeof node.expectedSourceText === 'string') {
      anchors.push({
        sourceFile,
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
        sourceFile,
        line: node.nextLine,
        expectedSourceText: node.nextLineExpectedSourceText,
        declaredAt: `${path}.nextLine`,
      });
    }
  });

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

/** One `declaredTier` a ground truth makes, as written. */
export interface TierDeclaration {
  /** Where in the ground truth it was declared, for a legible failure. */
  readonly declaredAt: string;
  /** Unchecked: `checkTierDeclaration` says whether it is well formed. */
  readonly value: Json;
}

/**
 * Collects every `declaredTier` a ground truth makes, wherever it sits.
 *
 * Structural, like `collectSourceAnchors`: a declaration sits beside the claim
 * it qualifies — a line range, a scenario's correct attribution, one slice's
 * recoverable owner — so there is no one place to look for them.
 */
export function collectTierDeclarations(groundTruth: Json): TierDeclaration[] {
  const declarations: TierDeclaration[] = [];

  forEachRecord(groundTruth, (node, { path }) => {
    const declared = node.declaredTier;
    if (declared !== undefined) {
      declarations.push({ declaredAt: `${path}.declaredTier`, value: declared });
    }
  });

  return declarations;
}

/** A declaration read into the engine's vocabulary, or what is wrong with it. */
type ParsedTierDeclaration =
  | { readonly ok: true; readonly byMode: ReadonlyMap<BuildMode, AttributionTier> }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a `declaredTier` value: an object with at least one build mode as a
 * key, each naming a tier in `ATTRIBUTION_TIERS`. Anything else is a defect
 * in the ground truth, reported rather than guessed around.
 */
function parseTierDeclaration(value: Json): ParsedTierDeclaration {
  if (!isJsonRecord(value)) {
    return { ok: false, problem: 'is not an object keyed by build mode' };
  }

  const byMode = new Map<BuildMode, AttributionTier>();
  for (const [key, tier] of Object.entries(value)) {
    const mode = BUILD_MODES.find((candidate) => candidate === key);
    if (mode === undefined) {
      return {
        ok: false,
        problem: `names ${JSON.stringify(key)}, which is not a build mode (${BUILD_MODES.join(', ')})`,
      };
    }
    const known = ATTRIBUTION_TIERS.find((candidate) => candidate === tier);
    if (known === undefined) {
      return {
        ok: false,
        problem:
          `${key}: ${JSON.stringify(tier)} is not one of the engine's tiers ` +
          `(${ATTRIBUTION_TIERS.join(', ')})`,
      };
    }
    byMode.set(mode, known);
  }

  if (byMode.size === 0) return { ok: false, problem: 'declares no build mode' };
  return { ok: true, byMode };
}

/** Returns `null` if the declaration is well formed, or a message saying what is wrong. */
export function checkTierDeclaration(declaration: TierDeclaration): string | null {
  const parsed = parseTierDeclaration(declaration.value);
  return parsed.ok ? null : `${declaration.declaredAt} ${parsed.problem}`;
}

/**
 * The tier a ground truth declares, at `path`, for one build mode.
 *
 * `path` names the object that carries the `declaredTier`, not the
 * declaration itself. Returns `null` when the declaration leaves `mode` out,
 * which means the fixture makes no claim about that build. Throws when there
 * is no declaration at `path` or it is malformed, because a test that asked
 * for a tier the ground truth does not hold has the wrong path, not a weaker
 * claim.
 */
export function declaredTierAt(
  groundTruth: Json,
  path: JsonPath,
  mode: BuildMode,
): AttributionTier | null {
  const where = formatPath([...path, 'declaredTier']);
  const value = get(groundTruth, [...path, 'declaredTier']);
  if (value === undefined) throw new Error(`no declaredTier at ${where}`);

  const parsed = parseTierDeclaration(value);
  if (!parsed.ok) throw new Error(`${where} ${parsed.problem}`);
  return parsed.byMode.get(mode) ?? null;
}
