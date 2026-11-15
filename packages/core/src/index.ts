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
 * Five layers, in dependency order:
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
 *    reads nothing but the commit record. Where timings are absent and the
 *    bundle ships a source map, the components come back under their real
 *    names through it.
 * 5. **The profiler tier** — `source-map.ts` resolves the profiler's frames
 *    through the maps the capture carried, and `line-attribution.ts` charges
 *    a population of samples to the functions they ran in, located by
 *    definition site: the replay, the long frames, or the script slices LoAF
 *    attributed to one registration site, where the profiler can name a
 *    third party LoAF cannot.
 *
 * What is deliberately not here yet is the confidence model: nothing in this
 * package weighs one tier's answer against another's, or a commit against the
 * frame it landed in. That is built on the layers above, which are meant to be
 * checkable without it.
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
  FunctionName,
  RankedCauses,
  SampleWindowKind,
  SourceLocation,
  UnattributedReason,
  UnmappedReason,
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
  attributeSampledFunctions,
  attributeScriptEntries,
  chargedSamples,
  describeFunctionAttribution,
  describeScriptEntry,
  describeSourceLocation,
  describeUnmappedReason,
  FUNCTION_LEVEL_CAVEAT,
  interactionPopulation,
  longFramePopulation,
  scriptSlicePopulation,
} from './line-attribution.ts';
export type {
  FunctionAttribution,
  FunctionSubject,
  SamplePopulation,
  SampleRange,
  ScriptDisagreement,
  ScriptEntryAttribution,
  ScriptEntrySite,
  ScriptSlice,
} from './line-attribution.ts';

export {
  OBSERVED_SAMPLE_CADENCE_MS,
  profiledFramePosition,
  SAMPLE_INTERVAL_FLOOR_MS,
  stackFrameIds,
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

export {
  definitionSite,
  enclosingCallTokenAt,
  resolvedStack,
  resolveProfile,
} from './source-map.ts';
export type { FrameResolution, ResolvedProfile, UnlocatedReason } from './source-map.ts';
