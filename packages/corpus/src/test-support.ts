/**
 * What the corpus test files share: the readings of a ground truth, and of the
 * engine's answer, that more than one of them makes.
 *
 * Each fixture's ground truth is read here once, into the shape its tests
 * compare the engine against, so that `accuracy.test.ts`, `components.test.ts`,
 * `lines.test.ts` and `records.test.ts` cannot disagree about what a fixture
 * declares. A reading only one file makes stays in that file, beside the
 * assertion it serves.
 *
 * It asserts nothing and attributes nothing. The readers throw, naming the
 * path, when a ground truth lacks a field they expect, because a test reading
 * the wrong path has a broken expectation rather than a weaker claim.
 */

import {
  type CandidateCause,
  type CapturedSignals,
  resolveProfile,
  type ResolvedProfile,
} from '@frameblame/core';

import { type BuildMode, loadGroundTruth } from './corpus.ts';
import {
  arrayAt,
  asArray,
  asString,
  get,
  type Json,
  type JsonPath,
  numberAt,
  stringAt,
} from './json.ts';
import { loadSignals } from './records.ts';

/** A file name's last path segment, which is how a ground truth and a source map agree. */
export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The names of the component candidates among `causes`, in rank order. */
export function componentNamesOf(causes: readonly CandidateCause[]): string[] {
  return causes.flatMap((cause) =>
    cause.subject.kind === 'component' ? [cause.subject.name] : [],
  );
}

/**
 * A capture's signals, with its profile resolved through the source maps the
 * capture carried. Throws for a capture with no profile, which `collectRun`
 * never writes.
 */
export function resolvedProfileOf(
  fixture: string,
  mode: BuildMode,
): { readonly signals: CapturedSignals; readonly resolved: ResolvedProfile } {
  const signals = loadSignals(fixture, mode);
  if (signals.profile === null) throw new Error(`${fixture}/${mode}: no profile`);
  return { signals, resolved: resolveProfile(signals.profile) };
}

/** `derive-in-render`'s declared culprit, as its tests compare against it. */
export interface DeriveInRenderTruth {
  readonly truth: Json;
  /** `expected.component`: the component the replay's time belongs to. */
  readonly component: string;
  /** The last path segment of `expected.sourceFile`. */
  readonly fileName: string;
  /**
   * `expected.acceptableAttribution.lineRange`, inclusive at both ends, with
   * the path that carries its `declaredTier`.
   */
  readonly lineRange: {
    readonly path: JsonPath;
    readonly from: number;
    readonly to: number;
  };
  /** `notAtFault.components`: the declared wrong answers. */
  readonly notAtFault: readonly string[];
}

/** Reads `derive-in-render`'s ground truth off disk; see `DeriveInRenderTruth`. */
export function deriveInRenderTruth(): DeriveInRenderTruth {
  const truth = loadGroundTruth('derive-in-render');
  const range = ['expected', 'acceptableAttribution', 'lineRange'] as const;
  return {
    truth,
    component: stringAt(truth, ['expected', 'component']),
    fileName: fileNameOf(stringAt(truth, ['expected', 'sourceFile'])),
    lineRange: {
      path: range,
      from: numberAt(truth, [...range, 'from']),
      to: numberAt(truth, [...range, 'to']),
    },
    notAtFault: arrayAt(truth, ['notAtFault', 'components']).map((name, index) =>
      asString(name, ['notAtFault', 'components', index]),
    ),
  };
}

/** One row of `spans`' `expected.sequence`, which is one interaction of the drive. */
export interface SpansSequenceRow {
  /** The interaction's label. */
  readonly id: string;
  /** `componentsThatRender` minus `listedButBailedOut`. */
  readonly rendered: readonly string[];
  readonly givenASpan: readonly string[];
}

/** `spans`' declared sequence and burn, as its tests compare against them. */
export interface SpansTruth {
  readonly truth: Json;
  readonly sequence: readonly SpansSequenceRow[];
  /**
   * What every `spans` component burns in its render body: `BURN_MS = 25` in
   * `fixtures/spans/src/burn.ts`, declared in the ground truth as
   * `bug.declaredBurnMsPerComponent`. Wall-clock time, so the same at any
   * throttle rate.
   */
  readonly burnMs: number;
}

/** Reads `spans`' ground truth off disk; see `SpansTruth`. */
export function spansTruth(): SpansTruth {
  const truth = loadGroundTruth('spans');
  const sequence = arrayAt(truth, ['expected', 'sequence']).map((row, index) => {
    const path = ['expected', 'sequence', index];
    const names = (key: string): string[] => {
      const value = get(row, [key]);
      return value === undefined
        ? []
        : asArray(value, [...path, key]).map((name, at) =>
            asString(name, [...path, key, at]),
          );
    };
    const bailedOut = new Set(names('listedButBailedOut'));
    return {
      id: stringAt(row, ['id']),
      rendered: names('componentsThatRender').filter((name) => !bailedOut.has(name)),
      givenASpan: names('componentsGivenASpan'),
    };
  });
  return {
    truth,
    sequence,
    burnMs: numberAt(truth, ['bug', 'declaredBurnMsPerComponent']),
  };
}

/** One of `vendor-listener`'s three declared slices of its frame. */
export interface VendorSlice {
  readonly slice: string;
  /** Where the slice sits in the ground truth, for reading its declarations. */
  readonly path: JsonPath;
  /** `loafAttributesTo`: the registration site LoAF reports for the slice. */
  readonly charPosition: number;
  readonly loafFileName: string;
  readonly loafLine: number;
  /** `trueOwner`: the function the slice's time was spent in. */
  readonly ownerFileName: string;
  readonly ownerFunction: string;
  readonly ownerLine: number;
  readonly isThirdParty: boolean;
  readonly expectedRank: number;
}

/**
 * Reads `vendor-listener`'s ground truth off disk, with its declared slices in
 * registration order, which is the order LoAF reports their script entries.
 */
export function vendorListenerTruth(): {
  readonly truth: Json;
  readonly slices: readonly VendorSlice[];
} {
  const truth = loadGroundTruth('vendor-listener');
  const slices = arrayAt(truth, ['expected', 'slices']).map((slice, index) => ({
    slice: stringAt(slice, ['slice']),
    path: ['expected', 'slices', index] as const,
    charPosition: numberAt(slice, ['loafAttributesTo', 'sourceCharPosition']),
    loafFileName: fileNameOf(stringAt(slice, ['loafAttributesTo', 'sourceFile'])),
    loafLine: numberAt(slice, ['loafAttributesTo', 'line']),
    ownerFileName: fileNameOf(stringAt(slice, ['trueOwner', 'sourceFile'])),
    ownerFunction: stringAt(slice, ['trueOwner', 'function']),
    ownerLine: numberAt(slice, ['trueOwner', 'definedAtLine']),
    isThirdParty: get(slice, ['isThirdParty']) === true,
    expectedRank: numberAt(slice, ['expectedRank']),
  }));
  return { truth, slices };
}
