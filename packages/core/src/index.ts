/**
 * `@frameblame/core` — the pure half of the tool.
 *
 * Everything here takes signal records and returns answers about them. No DOM,
 * no browser globals, no I/O, no clock of its own: a caller that has collected
 * records from a live page and a caller that replayed them from a dump get
 * identical results. That is what makes this the part with real unit tests, and
 * what makes the captured corpus a test input rather than a fixture-shaped
 * special case.
 *
 * Four layers, in dependency order:
 *
 * 1. **The records** — `loaf.ts`, `profiler.ts`, `react.ts`, bundled by
 *    `signals.ts` with the `provenance.ts` that says which build and throttle
 *    rate produced them. Derived from the eight captures in `corpus/` and then
 *    checked against the specifications, in that order, because the specs
 *    describe fields Chrome does not ship and omit behaviour it has.
 * 2. **The arithmetic** — `frame-decomposition.ts` partitions a frame using
 *    only LoAF's own fields, and `char-position.ts` translates between a
 *    character offset and the line and column a source map is queried with.
 *    Both are exact and neither needs a sampled signal.
 * 3. **The answer's shape** — `attribution.ts`: ranked candidate causes, each
 *    with a weight, a tier and its evidence.
 * 4. **The React tier** — `component-attribution.ts`: which components
 *    rendered in a commit and their share of it, from fiber self times in
 *    development, and from hook names joined to sampled stacks where the
 *    timings are absent. A commit is attributed whether or not a long frame
 *    surrounds it. The self times themselves are `fiber-self-time.ts`, which
 *    reads nothing but the commit record.
 *
 * What is deliberately not here yet is the rest of the join: nothing in this
 * package resolves a source map, splits a frame's script slice among causes,
 * or weighs a commit against the frame it landed in. Those are built on the
 * layers above, which are meant to be checkable without them.
 */

export {
  ATTRIBUTION_TIERS,
  confidenceWeight,
  describeTier,
  rankCauses,
} from './attribution.ts';
export type {
  AttributionTier,
  CandidateCause,
  CauseEvidence,
  CauseSubject,
  ConfidenceWeight,
  RankedCauses,
  SampleWindowKind,
  SourceLocation,
  UnattributedReason,
  WeightBasis,
} from './attribution.ts';

export { charPositionAt, createScriptLineIndex, lineColumnAt } from './char-position.ts';
export type { LineColumn, ScriptLineIndex } from './char-position.ts';

export {
  attributeCommit,
  attributeInteractionComponents,
  describeCommitBasis,
  describeComponentNote,
  describeShortfall,
} from './component-attribution.ts';
export type {
  AttributedInteraction,
  CommitAttribution,
  CommitAttributionBasis,
  CommitComponent,
  CommitSampleWindow,
  ComponentAttributionNote,
  InteractionComponents,
  MergedComponents,
} from './component-attribution.ts';

export { commitRenderTimes, didRender, fiberParticipation } from './fiber-self-time.ts';
export type {
  CommitRenderTimes,
  CommitRenderTiming,
  CommitTimingNote,
  FiberParticipation,
  FiberSelfTime,
  ReactTierShortfall,
  RenderedParticipation,
} from './fiber-self-time.ts';

export {
  chargesOfSlice,
  decomposeFrame,
  denominatorMs,
  describeConsistencyNote,
  shareOfFrame,
} from './frame-decomposition.ts';
export type {
  FrameCharges,
  FrameConsistencyNote,
  FrameDecomposition,
  FrameDenominator,
  FrameShare,
  FrameSlice,
  ScriptInterior,
  SliceCharge,
} from './frame-decomposition.ts';

export {
  COARSENED_TIMING_TOLERANCE_MS,
  exceedsByMoreThanCoarsening,
  exceedsCoarsenedTolerance,
  frameEndMs,
  isWithinFrame,
} from './loaf.ts';
export type { FrameRenderingUpdate, FrameScript, LongAnimationFrame } from './loaf.ts';

export {
  OBSERVED_SAMPLE_CADENCE_MS,
  profiledFramePosition,
  SAMPLE_INTERVAL_FLOOR_MS,
  stackFrames,
} from './profiler.ts';
export type {
  ProfiledFrame,
  ProfiledSample,
  ProfiledStack,
  ProfilerSampling,
  ProfileTrace,
  RawSourceMap,
  ScriptResource,
  SourceMapOrigin,
} from './profiler.ts';

export { describeProvenance, formatMilliseconds } from './provenance.ts';
export type { BuildMode, CaptureProvenance } from './provenance.ts';

export { COMPONENT_SPAN_PREFIX } from './react.ts';
export type {
  CommitComponents,
  FiberId,
  FiberRenderEvidence,
  LinkedFiber,
  ReactCommit,
  ReactSignals,
  ReactSpan,
  RenderedFiber,
  SpanProperty,
  UpdateOriginator,
} from './react.ts';

export { framesOfInteraction } from './signals.ts';
export type { CapturedSignals, InteractionAction, InteractionWindow } from './signals.ts';
