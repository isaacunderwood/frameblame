/**
 * Ambient declarations for the three signals, transcribed from their current
 * specifications on 2026-11-14 rather than from memory.
 *
 * None of these are in TypeScript's DOM library: the JS Self-Profiling API is a
 * WICG draft, Long Animation Frames' script attribution is newer than the lib
 * definitions, and React's DevTools hook is internals with no published type.
 * They live here, in the spike, because the spike is what verifies that the
 * fields actually arrive — the checked subset moves into the packages
 * afterwards, with the fields that turned out to be absent marked as such.
 *
 * Sources:
 * - https://wicg.github.io/js-self-profiling/
 * - https://w3c.github.io/long-animation-frames/
 *
 * Deliberately narrow: only the members this spike reads are declared, so that
 * a field appearing here is a claim someone checked.
 */

// ---------------------------------------------------------------------------
// JS Self-Profiling API
// ---------------------------------------------------------------------------

interface ProfilerInitOptions {
  /** Requested sampling period in milliseconds. The UA may clamp it. */
  readonly sampleInterval: number;
  /** Capacity in samples; the profiler stops buffering once it is reached. */
  readonly maxBufferSize: number;
}

/** A frame's `line` and `column` are 1-based, unlike source maps' columns. */
interface ProfilerFrame {
  readonly name: string;
  readonly resourceId?: number;
  readonly line?: number;
  readonly column?: number;
}

interface ProfilerStack {
  readonly parentId?: number;
  readonly frameId: number;
}

interface ProfilerSample {
  /**
   * Per spec, a high resolution timestamp relative to "the profiling session's
   * time origin" — which is not obviously the document's time origin.
   *
   * Measured, it is: the first sample lands 0.1-0.9ms after the
   * `performance.now()` reading taken immediately before `new Profiler(...)`
   * (v0.3 re-capture, 4x, both build modes; 0.0-0.7ms in the capture before),
   * so all three signals share one `performance.now()` timeline and no clock
   * reconciliation is needed. That was the correlation risk the spike was most
   * worried about; `findings.md` records it as answered.
   */
  readonly timestamp: number;
  readonly stackId?: number;
  /*
   * `ProfilerSample.marker` is specified — it would attribute style, layout
   * and other browser work *inside* a script's slice, which is precisely the
   * gap nothing else fills — and is **not implemented in Chrome 159**. Zero of
   * 667 samples carried one, including across a 102ms forced layout. It is
   * deliberately not declared here: this file's rule is that a field appearing
   * in it is a claim someone checked, and the checked answer is "absent".
   * Untested under COOP+COEP, where the spec's filter is wider.
   */
}

interface ProfilerTrace {
  /** Script URLs, indexed by `ProfilerFrame.resourceId`. */
  readonly resources: readonly string[];
  readonly frames: readonly ProfilerFrame[];
  readonly stacks: readonly ProfilerStack[];
  readonly samples: readonly ProfilerSample[];
}

declare class Profiler {
  constructor(options: ProfilerInitOptions);
  readonly sampleInterval: number;
  readonly stopped: boolean;
  stop(): Promise<ProfilerTrace>;
}

// ---------------------------------------------------------------------------
// Long Animation Frames
// ---------------------------------------------------------------------------

interface PerformanceScriptTiming extends PerformanceEntry {
  readonly invokerType: string;
  readonly invoker: string;
  readonly executionStart: number;
  readonly sourceURL: string;
  readonly sourceFunctionName: string;
  /** Zero-based character offset into the script resource, or -1 if unknown. */
  readonly sourceCharPosition: number;
  /**
   * 1-based, and specified but gated in Chromium behind the
   * `LongAnimationFrameSourceLineColumn` Blink features, which are off by
   * default as of November 2026. Optional here because the honest expectation
   * is that they are `undefined` — which is precisely why
   * `sourceCharPosition` has to be resolved by hand.
   */
  readonly sourceLine?: number;
  readonly sourceColumn?: number;
  readonly pauseDuration: number;
  readonly forcedStyleAndLayoutDuration: number;
  /**
   * The same figure split in two, and the correction this file most deserved.
   *
   * Both are specified — the spec defines `forcedStyleAndLayoutDuration` as
   * *their sum* — and Chrome 159 ships both. Names checked against the IDL on
   * 2026-11-15:
   * https://w3c.github.io/long-animation-frames/#dom-performancescripttiming-forcedstyleduration
   * https://w3c.github.io/long-animation-frames/#dom-performancescripttiming-forcedlayoutduration
   *
   * They were missing from this file until the corpus was read field by
   * field, and because the collector's `serializeScript` was written from this
   * list, they were absent from its projection too until step 0.2 of the v0.3
   * run added them. Captures before that carry them only because the
   * collector also stores whatever `toJSON()` serialises.
   *
   * So "transcribed from the specification rather than from memory" was not
   * enough: a hand-transcribed list is a list of the fields someone noticed.
   * `findings.md` carried an open item for days saying this split was
   * unavailable from the entry.
   *
   * Optional, unlike the combined figure, although the spec makes them
   * unconditional: they are the newest attributes on the interface, and a
   * browser that predates them returns `undefined`. Declared that way so the
   * collector has to say what absence becomes, rather than letting a missing
   * field pass through as if it were a measurement.
   *
   * They do not sum to the combined figure exactly, although the spec defines
   * the combined figure as exactly their sum: Chrome 159 reports the three as
   * values that disagree on the 100µs grid. This comment used to say each half
   * is coarsened independently, deliberately, so that summing them cannot
   * recover resolution the browser is withholding, and that they differ by one
   * grid step on 6 of the corpus's 20 forced entries. Both were wrong. The
   * spec's coarsening stops a sum of many short periods exposing more
   * precision than a timestamp, and does not license the disagreement; and
   * the count, re-measured on the v0.3 re-capture (4x, both build modes), is
   * 0 on 11, one step on 8 and two steps on 1 (11 at one step in the capture
   * before, so the "6" was a miscount). `COARSENED_TIMING_TOLERANCE_MS` in
   * `packages/core/src/loaf.ts` carries the measurement.
   */
  readonly forcedStyleDuration?: number;
  readonly forcedLayoutDuration?: number;
  readonly windowAttribution: string;
}

interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
  readonly renderStart: number;
  readonly styleAndLayoutStart: number;
  readonly blockingDuration: number;
  readonly firstUIEventTimestamp: number;
  readonly scripts: readonly PerformanceScriptTiming[];
}

// ---------------------------------------------------------------------------
// React's DevTools global hook
// ---------------------------------------------------------------------------

/**
 * Only the members React itself calls on the hook, in the order it calls them:
 * `checkDCE` and `inject` during renderer module evaluation, then
 * `onCommitFiberRoot` after every commit. Everything else the real DevTools
 * hook carries is for DevTools' own benefit.
 */
interface ReactDevToolsGlobalHook {
  supportsFiber: boolean;
  renderers: Map<number, unknown>;
  checkDCE(fn: unknown): void;
  inject(renderer: unknown): number;
  onCommitFiberRoot(
    rendererId: number,
    root: ReactFiberRoot,
    priorityLevel: unknown,
    didError: boolean,
  ): void;
  onPostCommitFiberRoot(rendererId: number, root: ReactFiberRoot): void;
  onCommitFiberUnmount(rendererId: number, fiber: ReactFiber): void;
  /** DevTools' event emitter, stubbed because React's dev build calls it. */
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
  sub(event: string, listener: () => void): () => void;
  emit(event: string, payload?: unknown): void;
}

interface ReactFiberRoot {
  readonly current: ReactFiber | null;
}

interface ReactFiber {
  /** Discriminates component kinds; the numbering is internal and unstable. */
  readonly tag: number;
  readonly type: unknown;
  readonly child: ReactFiber | null;
  readonly sibling: ReactFiber | null;
  /**
   * The fiber's other half in React's double buffer, or `null` for a fiber
   * mounting in this commit. Compared by identity to find a subtree React
   * bailed out of without cloning; see `describeCommit` in
   * `spike/collectors.ts`.
   */
  readonly alternate: ReactFiber | null;
  /**
   * React's effect bitmask. Bit 0 is `PerformedWork`, set only when a
   * component's render function ran in this render; the other bits are
   * internal and recorded only so a reader can re-derive what it needs.
   */
  readonly flags: number;
  /**
   * The plan assumed these were set only in a profiling build. Measured, both
   * are populated in React 19.3's **development** build, on every component
   * fiber — including the ones React declined to give a `performance.measure`
   * span. Where both signals existed for one component they agreed to within
   * about a millisecond, which is why the fiber tree is the primary component
   * signal in development and the spans are corroboration.
   *
   * `actualDuration` is the subtree's render time. Self time is
   * `actualDuration - sum(children.actualDuration)`. `selfBaseDuration` is
   * *not* self time: it is the previous full render's base duration, and it
   * measured 8% off (42.1 against 45.5ms) on the one component where both
   * could be compared.
   */
  readonly actualDuration?: number;
  readonly selfBaseDuration?: number;
  readonly lanes?: number;
}

/**
 * A `performance.measure` entry with its `detail` readable.
 *
 * The DOM library types `PerformanceMeasure.detail` as `any`, which the repo's
 * type-checked lint rules will not let through. Declared as `unknown` here so
 * that reading React's span details is an explicit narrowing rather than an
 * unchecked one — appropriate, given that most of what React puts in `detail`
 * cannot be trusted. See the trap recorded beside the observer in
 * `spike/collectors.ts`.
 */
interface ReactMeasureEntry extends PerformanceEntry {
  readonly detail: unknown;
}

// ---------------------------------------------------------------------------
// The spike's own channel out of the page
// ---------------------------------------------------------------------------

interface SpikeCollector {
  readonly profilerAvailable: boolean;
  readonly timeOrigin: number;
  readonly loaf: unknown[];
  readonly commits: unknown[];
  readonly measures: unknown[];
  startProfile(sampleInterval: number, maxBufferSize: number): void;
  stopProfile(): Promise<{
    trace: ProfilerTrace | null;
    requestedSampleInterval: number;
    effectiveSampleInterval: number | null;
    startedAt: number;
    stoppedAt: number;
  }>;
  mark(label: string): number;
  /** The page's `performance.now()`, for pairing a step with the page clock. */
  now(): number;
  /** Long frames collected so far; the driver waits on this changing. */
  frameCount(): number;
  /** Drops collected records. Does not stop or restart the profiler. */
  reset(): void;
  /** Whatever the fixture published about itself, verbatim, or null. */
  fixtureProbe(): unknown;
}

interface Window {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevToolsGlobalHook;
  __frameblameSpike__?: SpikeCollector;
  /**
   * The one channel by which a fixture publishes evidence only it can gather.
   *
   * Typed `unknown` because its shape is the fixture's business: the capture
   * stores it verbatim and each fixture's `ground-truth.json` says what it
   * means. See `fixtureProbe` in `spike/collectors.ts`.
   */
  __frameblameFixtureProbe?: unknown;
}
