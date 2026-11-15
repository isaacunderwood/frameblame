/**
 * The JS Self-Profiling API's trace, as Chrome 159 actually reports it.
 *
 * This is the expensive signal and the only one that can see inside a frame:
 * real sampled stacks, with positions a source map can resolve. LoAF's answer
 * to "what made this frame slow" is react-dom's event dispatcher; this is what
 * answers it with the user's own component.
 *
 * The trace is four parallel arrays referring to each other by index, which is
 * how the API serialises it and how the dumps store it. The index names are
 * kept as the API spells them — `resourceId`, `frameId`, `stackId`, `parentId`
 * — rather than renamed to `index`, so that a reader cross-referencing a dump
 * or the specification sees the same words. They are array indices in every
 * case.
 *
 * What this module does not do: resolve a source map (`source-map.ts`) or
 * charge a sample to a function (`line-attribution.ts`). It holds the records,
 * the stack walk, the one position conversion the whole project must get
 * right, and the facts about sampling that bound what any heuristic built on
 * top may claim, including which samples are independent of each other.
 *
 * **Clock.** Sample timestamps are `performance.now()` milliseconds on the
 * document's timeline, shared with LoAF and React. The spec says they are
 * relative to "the profiling session's time origin", which is not obviously the
 * document's; measured, it is — the first sample lands 0.1-0.9ms after the
 * reading taken immediately before the profiler was constructed, across all
 * eight captures of the v0.3 re-capture (4x, both build modes; 0.0-0.7ms in the
 * capture before, also 4x).
 *
 * https://wicg.github.io/js-self-profiling/
 */

import type { LineColumn } from './char-position.ts';

/**
 * The floor Chrome clamps the sampling period to, in milliseconds.
 *
 * `ProfilerGroup::kBaseSampleIntervalMs` is a compile-time constant of 10 in
 * Blink (16 on Windows) that no flag, feature or Document-Policy parameter
 * reads, and V8's `--cpu-profiler-sampling-interval` is overridden by Blink's
 * own call. Chrome also snaps **up**, contrary to the spec's "next lowest
 * supported" language: a requested interval of 1 silently becomes 10. All eight
 * captures requested 5 and were given 10.
 */
export const SAMPLE_INTERVAL_FLOOR_MS = 10;

/**
 * What the cadence actually measures out at, which is not the floor.
 *
 * Measured over 16,459 samples across the corpus (v0.3 re-capture, 4x, both
 * build modes): a median inter-sample delta of 14.5ms, p25 10.8, p90 15.3, max
 * 15.9. The capture before it, on the same machine, browser and settings, gave
 * 12.2ms, p25 10.6, p90 12.8 with a tail to 29.9ms over 17,250 samples. The
 * shift is in all eight runs alike, the two vanilla fixtures with no React in
 * them included, and nothing in the profiler's request changed (5ms asked, 10
 * given), so it is the machine rather than the collector — which makes the
 * cadence a property of the session, not a constant to rely on. Budget 12-15ms
 * per sample when reasoning about how many a frame can yield — a 64ms frame
 * gives four to six — and expect duplicates: 32 pairs of samples in the
 * corpus share a timestamp exactly, 31 of them the same stack sampled twice
 * (51 of 51 in the capture before), so a zero-width sample is a real thing to
 * tolerate rather than a parse error.
 */
export const OBSERVED_SAMPLE_CADENCE_MS = 14.5;

/**
 * The gap below which two consecutive samples are one look at the stack rather
 * than two: half the sampling floor, in milliseconds.
 *
 * A sampler with a 10ms floor cannot honestly tick twice inside 5ms, and the
 * corpus's gaps say the same thing from the other side. Of its 16,451
 * inter-sample gaps, 16,376 are 9ms or longer, 11 fall between 5 and 9ms, and
 * 64 are under 5ms (v0.3 re-capture, 4x, both build modes). Those 64 are not
 * spread about. They sit in 14 runs holding 78 samples, and four of the runs
 * are `vendor-listener`'s first click: 15 samples in 145.3-149.6ms and 9 in
 * 165.8-166.9ms in development, 24 in 163.5-169.5ms and 9 in 181.0-182.5ms in
 * production. The other ten are nine pairs and a triple.
 *
 * Why Chrome emits them is not established here. What is measured is that a
 * burst repeats one instant: 9 of the 14 hold a single stack sampled over and
 * over, or no stack at all, and the other 5 hold two.
 */
export const SAMPLE_BURST_GAP_MS = SAMPLE_INTERVAL_FLOOR_MS / 2;

/** A source map as it appears in JSON, narrowed to the fields this project reads. */
export interface RawSourceMap {
  readonly version: number;
  readonly file?: string;
  /** Original file paths, relative to `sourceRoot` when there is one. */
  readonly sources: readonly (string | null)[];
  /**
   * Original identifier names.
   *
   * Load-bearing in production and absent in practice in development: the two
   * production bundles in the corpus carry 1,852 and 1,856 names, while all
   * eight development maps carry an empty array. This array is how a minified
   * frame recovers its component name — `h` at generated `9:50998` resolves to
   * `OrderTable.tsx:32:16` with `name: "OrderTable"` — which is why production
   * attribution needs no React hook and no build-time plugin.
   */
  readonly names?: readonly string[];
  readonly mappings: string;
  readonly sourcesContent?: readonly (string | null)[];
  readonly sourceRoot?: string;
  /** Indices into `sources` the debugger should skip. Chrome's `x_google_ignoreList`. */
  readonly ignoreList?: readonly number[];
}

/** Where a script's source map came from, which decides whether it survives the server. */
export type SourceMapOrigin =
  /** A `data:` URI in the script itself, as a Vite dev server serves each module. */
  | { readonly kind: 'inline' }
  /** A `.map` file alongside the bundle, as a production build ships. */
  | { readonly kind: 'external'; readonly url: string };

/**
 * One script resource named by the trace, with whatever is known about it.
 *
 * In a Vite dev server the resources are *the component files themselves*,
 * because dev-mode ESM serves each module separately, and the list varies with
 * what actually ran — a module appears only when a sample happened to land in
 * it. In production there is one bundle. Both are in the corpus, along with two
 * fixtures whose scripts are hand-written files served byte-for-byte out of
 * `public/` with no map at all, which is the degraded tier in its natural
 * habitat.
 */
export interface ScriptResource {
  readonly url: string;
  /**
   * Length of the served text in UTF-16 code units, or `null` if unknown.
   *
   * Not the text itself: the engine is pure and a 221KB bundle is not something
   * to carry through it. The length is here because it is the one cheap check
   * that a character offset belongs to the script it claims to.
   */
  readonly servedLength: number | null;
  /** `null` when the script shipped no map — which is 6 of the corpus's 16 resources. */
  readonly sourceMap: {
    readonly origin: SourceMapOrigin;
    readonly map: RawSourceMap;
  } | null;
  /**
   * Why nothing could be read for this script, when something went wrong rather
   * than nothing being there.
   *
   * "This bundle shipped no source map" and "this bundle's source map could not
   * be fetched" both degrade to the same tier — a minified name with a warning
   * — but they are different warnings, and only one of them is the user's to
   * fix. `null` on all 16 resources in the corpus.
   */
  readonly fetchError: string | null;
}

/**
 * One function in the trace: where it was *defined*, not where it was executing.
 *
 * This is the project's hardest structural limit and it is mandated by the
 * spec: `line` is "the 1-based index of the line at which instance is
 * defined". V8 does record the executing line, but Blink requests
 * `kLeafNodeLineNumbers` and its trace builder never reads `GetLineTicks()`.
 *
 * So a frame naming line 32 of `OrderTable.tsx` — the `export function
 * OrderTable(` line — means "inside the component body but not inside any
 * nested callback", and the comparator passed to `.sort` on line 36 is a
 * *separate frame* with its own definition line. That is what makes
 * `OrderTable.tsx:36, in the callback passed to .sort` defensible and "line 36
 * is slow" not. True statement-level attribution exists over CDP, where
 * `positionTicks` gave 164 ticks on one generated line at a 185us cadence, and
 * is unavailable from inside the page at any sample count.
 */
export interface ProfiledFrame {
  /**
   * The function's name, or `null` for an anonymous function or a module's top
   * level. Chrome reports the empty string; 23 of the corpus's 136 frames are
   * anonymous, every one of them with a valid `resourceId`.
   */
  readonly name: string | null;
  /** Index into `ProfileTrace.resources`, or `null` for a native frame. */
  readonly resourceId: number | null;
  /**
   * 1-based line of the function's definition, or `null`.
   *
   * Both of these are 1-based, which is *not* the convention a source map is
   * queried with. Convert with `profiledFramePosition` rather than by hand: the
   * minus one belongs in exactly one place.
   */
  readonly line: number | null;
  /** 1-based column. See `line`, and see `profiledFramePosition`. */
  readonly column: number | null;
}

/**
 * One stack, as a frame plus a link to its caller.
 *
 * `parentId` is `null` at a root — the event dispatch or task entry point. The
 * API omits the property there rather than nulling it, and in every capture a
 * parent's index is strictly lower than its child's, so a walk outward
 * terminates.
 */
export interface ProfiledStack {
  readonly frameId: number;
  readonly parentId: number | null;
}

/**
 * One sample: a timestamp, and the stack that was running — or nothing.
 *
 * **The empty stack is the cross-check, not a shrug.** `stackId` is `null` when
 * no JavaScript was on the stack at that instant, which is not the same as the
 * thread being idle. It is the second, independent signal behind the
 * unattributed tier: the corpus's unforced `innerHTML` frames show an 89-90%
 * LoAF residual alongside 89-92% of in-frame samples carrying no stack, and
 * adding one `offsetHeight` read moves both together — the residual to 14-17%,
 * the empty-stack share to 10-22% (per frame, 4x, both build modes). Two
 * signals agreeing that nothing was attributable is a far better unattributed
 * tier than subtraction alone.
 *
 * "In-frame" needs its window stated, because the forced figure depends on it.
 * The 10-22% counts samples inside `[startTime, startTime + duration]`. Inside
 * the engine's `isWithinFrame`, whose tolerance is 0.2ms either side, it is
 * 10-30%: one stackless sample at 4324.9ms falls against a production frame
 * starting at 4325.0, turning that frame's 2 of 9 into 3 of 10. The unforced
 * figures are the same under both windows.
 *
 * Note that the whole-run share is not that number: most of a run is the idle
 * gaps between interactions, so 75-99% of all samples in these captures have no
 * stack. The quantity that means anything is the share of samples *inside a
 * frame*.
 */
export interface ProfiledSample {
  readonly atMs: number;
  readonly stackId: number | null;
}

/** What the profiler was asked for, and what it was actually given. */
export interface ProfilerSampling {
  readonly requestedIntervalMs: number | null;
  /**
   * The interval the profiler reported after clamping, or `null` if not
   * recorded. 10 in every capture, against a request of 5.
   */
  readonly effectiveIntervalMs: number | null;
  /** Capacity in samples. A full buffer silently discards the end of a run. */
  readonly maxBufferSize: number | null;
}

/**
 * A complete sampled profile over one session.
 *
 * Note the two windows a consumer must not confuse: this trace's own
 * `startedAtMs`/`stoppedAtMs`, and the interaction windows in `signals.ts`. In
 * two of the eight captures the profiler was started in an init script at 22-26ms
 * to catch the page's first mount, long before the drive began at 239-307ms (4x,
 * both build modes), so
 * dozens of samples precede the first interaction. Anything that assumes
 * samples begin at the first interaction mis-bins them.
 */
export interface ProfileTrace {
  /** Indexed by `ProfiledFrame.resourceId`. */
  readonly resources: readonly ScriptResource[];
  /** Indexed by `ProfiledStack.frameId`. */
  readonly frames: readonly ProfiledFrame[];
  /** Indexed by `ProfiledSample.stackId` and `ProfiledStack.parentId`. */
  readonly stacks: readonly ProfiledStack[];
  /** In timestamp order, non-decreasing; consecutive duplicates occur. */
  readonly samples: readonly ProfiledSample[];
  readonly sampling: ProfilerSampling;
  readonly startedAtMs: number | null;
  readonly stoppedAtMs: number | null;
}

/**
 * The profiler's position for a frame, converted to the convention a source map
 * is queried with: 1-based line, 0-based column.
 *
 * **This is the only place the minus one belongs.** `ProfilerFrame.line` and
 * `.column` are both 1-based; a source map's column is 0-based, and `core`'s
 * `LineColumn` is 1-based line with 0-based column precisely so that a value of
 * that type can go straight into `originalPositionFor`. Doing the subtraction
 * at each use site is how one of them silently keeps the off-by-one.
 *
 * Returns `null` when the frame carries no position — a native frame, or one
 * the profiler reported without line and column. Every frame in the corpus has
 * both, so the null branch is reasoned rather than measured.
 *
 * What the result resolves to, measured rather than assumed. For an arrow
 * function passed as an argument, the converted position points at the arrow's
 * opening paren in the generated code: the corpus's declared culprit is reported
 * at `27:108`, and 0-based column 107 of that served line is the `(` of
 * `(a, b) =>` (`derive-in-render`, development, 4x; `source-windows.json`
 * carries the served line). esbuild and rolldown emit no source-map segment for
 * that paren, so the lookup falls back to the segment before it, which is the
 * enclosing call's token: `OrderTable.tsx:36:5`, 0-based, is `sort` in
 * `.sort((a, b) => ...)` (`36:6` counted 1-based, as `findings.md` quotes it),
 * in development and production alike. One further column to the left
 * resolves identically in both builds, so no second adjustment sharpens it.
 * That fallback is why `source-map.ts` can name the call a callback was passed
 * to, and it needs no adjustment beyond this one. (This comment used to say the
 * resolved column lands on the paren and that the call token sits one column
 * further left; resolving the corpus showed both halves wrong.)
 */
export function profiledFramePosition(frame: ProfiledFrame): LineColumn | null {
  const { line, column } = frame;
  if (line === null || column === null) return null;
  return { line, column: column - 1 };
}

/**
 * Walks a sample's stack from the leaf outwards, returning the index into
 * `trace.frames` of each frame on it.
 *
 * Leaf first, because the leaf is where the time was actually spent: a sample
 * whose stack runs `workLoopSync -> beginWork -> OrderTable -> sort callback`
 * is evidence about the callback, and about `OrderTable` only in the weaker
 * sense that it was on the stack.
 *
 * Indices rather than frames, so that a caller holding something computed per
 * frame, such as a source-map resolution, can look it up without a second
 * walk. Returns an empty array for a sample with no stack, and stops at the
 * first dangling index rather than throwing: a truncated trace is a thing a
 * buffer limit can produce, and losing the deeper half of one stack should not
 * lose the run.
 */
export function stackFrameIds(
  trace: ProfileTrace,
  stackId: number | null,
): readonly number[] {
  const frameIds: number[] = [];
  let current = stackId;

  /*
   * Bounded by the number of stacks rather than trusted to terminate. In every
   * capture a parent's index is strictly lower than its child's, so a walk
   * outward reaches a root — but that is an observation about Chrome, not a
   * guarantee the records carry, and the cost of being wrong about it is a hung
   * engine rather than a wrong answer.
   */
  for (let step = 0; current !== null && step <= trace.stacks.length; step += 1) {
    const stack: ProfiledStack | undefined = trace.stacks[current];
    if (stack === undefined) break;
    if (trace.frames[stack.frameId] === undefined) break;

    frameIds.push(stack.frameId);
    current = stack.parentId;
  }

  return frameIds;
}

/**
 * Walks a sample's stack from the leaf outwards, yielding each frame. The same
 * walk as `stackFrameIds`, with the same leaf-first order and the same stop at
 * a dangling index, returning the frames themselves.
 */
export function stackFrames(
  trace: ProfileTrace,
  stackId: number | null,
): readonly ProfiledFrame[] {
  return stackFrameIds(trace, stackId).flatMap((frameId) => {
    const frame = trace.frames[frameId];
    return frame === undefined ? [] : [frame];
  });
}

/** Raw and independent sample counts, kept side by side. */
export interface SampleCounts {
  /** Samples as the trace holds them. */
  samples: number;
  /** The same samples with bursts collapsed. See `independentSampleWeights`. */
  independent: number;
}

/**
 * How much independent evidence each sample is: 1 for a sample on its own, and
 * `1 / n` for each of the `n` samples in a burst.
 *
 * A burst is a maximal run of samples each less than `SAMPLE_BURST_GAP_MS`
 * after the one before it. It is one look at the stack, taken `n` times, so it
 * counts once and its samples share that one count equally. Shared rather than
 * given to the first sample, because a burst can straddle a boundary a caller
 * cares about or hold two different stacks, and an equal split is the only
 * division that does not pick a winner.
 *
 * Returns one weight per entry of `trace.samples`, in the same order. The sum
 * of the weights over any set of samples is the number of independent samples
 * in it, which is what a share's confidence must be computed from. Counting
 * raw samples would let `vendor-listener`'s first-click burst pass for nine
 * separate observations of the vendor's function, when it is one (4x, both
 * build modes).
 *
 * A burst counts as one look only while it is short. It is bounded by its
 * span: a burst lasting `spanMs` counts as `spanMs / SAMPLE_INTERVAL_FLOOR_MS`
 * looks, and never fewer than one, which is as many as a sampler at the floor
 * could have taken in that time. Without the bound, a sampler that really did
 * tick faster than the floor, every 1ms for a second, would chain into one
 * burst and be collapsed into a single sample. Every corpus burst spans 6.0ms
 * or less, the longest being `vendor-listener` production's 24 samples in
 * 163.5-169.5ms, so each still counts once (4x, both build modes).
 *
 * Assumes the samples are in timestamp order, as the API reports them and as
 * every capture has them. Timestamps are page-clock milliseconds.
 */
export function independentSampleWeights(trace: ProfileTrace): readonly number[] {
  const { samples } = trace;
  const weights = new Array<number>(samples.length).fill(1);

  let burstStart = 0;
  for (let index = 1; index <= samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const continuesBurst =
      previous !== undefined &&
      current !== undefined &&
      current.atMs - previous.atMs < SAMPLE_BURST_GAP_MS;
    if (continuesBurst) continue;

    const size = index - burstStart;
    const first = samples[burstStart];
    if (size > 1 && first !== undefined && previous !== undefined) {
      const looks = Math.max(1, (previous.atMs - first.atMs) / SAMPLE_INTERVAL_FLOOR_MS);
      weights.fill(looks / size, burstStart, index);
    }
    burstStart = index;
  }

  return weights;
}
