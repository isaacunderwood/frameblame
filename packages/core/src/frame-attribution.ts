/**
 * One long frame as ranked candidate causes: every millisecond of the frame
 * charged to a candidate, each with a weight, a tier and a confidence, and
 * the part nothing can name charged to explicit `unattributed` candidates.
 *
 * This is where the three signals meet on one frame. The partition
 * (`frame-decomposition.ts`) is the spine, because it is exact and needs no
 * other signal: its slices are the frame, so the weights here are shares of
 * the frame's own duration and sum to 1. Each slice is then named as well as
 * the evidence allows, and no better.
 *
 * ## How a script slice is named
 *
 * A script slice's time is two things. The style and layout it forced is
 * browser work, reported by LoAF on the entry itself, and is one candidate
 * charged to that entry. The rest is the entry's own JavaScript, and it is
 * divided by the strongest signal that can divide it:
 *
 * 1. **Fiber timings.** Where a React commit with timings landed inside the
 *    slice, each rendered component is a candidate holding its measured self
 *    time, and the entry keeps what is left: React's own work and the handler.
 *    These are milliseconds on the same clock as the frame, so the weights
 *    are measurements, not estimates. They are placed in the frame by the
 *    commit's timestamp, and that placement is checked against LoAF: the
 *    commit's whole render has to fit between the slice's start and the
 *    commit. On all 17 timed commits that landed in a corpus frame it does,
 *    with 0.3-12.0ms to spare before the render and 0.0-1.9ms after the
 *    commit (development, 4x). Where it does not fit, the render ran partly
 *    somewhere else, the placement is not established, and the components
 *    are not charged; a note says so.
 * 2. **Sampled functions.** Otherwise, where the profiler holds stacked
 *    samples inside this entry's slices, the JavaScript is divided among the
 *    functions they ran in, by sample share. The samples are pooled over
 *    every slice LoAF attributed to the same registration site within the
 *    same interaction, because that is what a replay is: the function is a
 *    distribution over replayed frames, and one 12ms slice holds about one
 *    sample. Pooled within the interaction and not across the capture,
 *    because React registers one listener for every event, so a capture-wide
 *    pool would mix every interaction on the page. The weight is the slice's
 *    measured share times the sampled share, and it is only as good as the
 *    sampled half: its confidence carries the pool's independent sample
 *    count.
 * 3. **The entry itself.** With neither, the candidate is the script entry as
 *    LoAF named it, at the `loaf-script-registration` tier: the right
 *    milliseconds, charged to the line that registered a listener. This is
 *    what the absence of the profiler costs. Where the DevTools hook saw a
 *    commit land inside the slice but recorded no timings, the components it
 *    rendered are attached to the entry as evidence, inferred from the
 *    overlap alone, and none of them is given a share nobody measured.
 *
 * A production React frame therefore lists functions here, and its
 * components are in the interaction's own ranking
 * (`component-attribution.ts`), where the hook's names are joined to the
 * samples.
 *
 * ## The unattributed share, and its cross-check
 *
 * Time outside every reported script and outside the rendering update's
 * style, layout and paint has no cause LoAF can name. It is charged to
 * `unattributed` candidates, one per place in the frame it sits, never
 * shared out among the scripts that happen to be visible. Subtraction alone
 * cannot tell browser work from a gap in LoAF's accounting, so each of these
 * weights carries the verdict of a second signal: the share of in-frame
 * profiler samples with no JavaScript on the stack, compared with the share
 * of the frame outside every script (`crossCheckEmptyStacks`).
 *
 * Measured, the two move together. `innerhtml-rebuild`'s unforced frames are
 * 88.9-90.3% outside scripts with 88.9-91.7% of in-frame samples stackless;
 * its forced frames are 14.3-16.9% outside scripts with 10-30% stackless (4x,
 * both build modes, samples by `isWithinFrame`). The forced style and layout
 * is not in that second figure, and should not be: it ran with the script
 * that forced it still on the stack.
 *
 * The comparison is against time outside *scripts*, not against the
 * unattributed charge alone, because an empty stack cannot tell the two
 * apart: the rendering update's own layout also runs with no JavaScript on
 * the stack. `spans`' first frame is 0.1% unattributed and 15.8% outside
 * scripts, 26.2ms of it layout, with 2 of its 17 in-frame samples stackless
 * (development, 4x).
 *
 * ## What this module does not do
 *
 * It does not group frames by cause, and it does not rank one frame against
 * another. It does not merge the component view of a slice with the function
 * view of the same slice: they are two descriptions of the same milliseconds,
 * and adding them would count the time twice. It reads only what it is
 * handed.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import {
  type CandidateCause,
  type CauseEvidence,
  type CauseSubject,
  confidenceWeight,
  type NonEmptyEvidence,
  type RankedCauses,
  rankCauses,
  type UnattributedReason,
} from './attribution.ts';
import { type CommitAttribution, renderedEvidence } from './component-attribution.ts';
import {
  type CrossCheck,
  crossCheckEmptyStacks,
  measuredSupport,
  type WeightSupport,
} from './confidence.ts';
import { didRender } from './fiber-self-time.ts';
import {
  decomposeFrame,
  type FrameDecomposition,
  type FrameDenominator,
  type FrameSlice,
} from './frame-decomposition.ts';
import {
  attributeSampledFunctions,
  type FunctionAttribution,
} from './line-attribution.ts';
import {
  exceedsByMoreThanCoarsening,
  isWithinFrame,
  type LongAnimationFrame,
} from './loaf.ts';
import { independentSampleWeights, type ProfileTrace } from './profiler.ts';
import { type CaptureProvenance, formatMilliseconds } from './provenance.ts';
import {
  scriptEntrySiteKey,
  scriptEntrySiteOf,
  type ScriptSlice,
  scriptSlicePopulation,
} from './script-entry-attribution.ts';
import { type CapturedSignals, frameBeganIn } from './signals.ts';
import type { ResolvedProfile } from './source-map.ts';

/** Something about a frame's attribution that a report must say. */
export type FrameAttributionNote =
  | {
      /**
       * A commit with fiber timings landed inside a script slice, but its
       * render time does not fit between the slice's start and the commit, by
       * `byMs`. Part of the render ran somewhere else, in an earlier task or
       * an earlier frame, so the commit's components are not charged to this
       * frame. The slice falls back to sampled functions or to the entry.
       */
      readonly kind: 'commit-render-does-not-fit-script';
      readonly scriptIndex: number;
      readonly committedAtMs: number;
      readonly byMs: number;
    }
  | {
      /**
       * A commit landed inside the frame but outside every reported script,
       * so there is no script slice to divide by it. It is still listed in
       * the frame's `commits`.
       */
      readonly kind: 'commit-outside-every-script';
      readonly committedAtMs: number;
    };

/** The time in a frame that no candidate names a cause for. */
export interface UnattributedShare {
  /** The partition's unattributed charge, in milliseconds. */
  readonly ms: number;
  /** `ms` as a share of the frame's duration: the unattributed candidates' weights, summed. */
  readonly fraction: number;
  /**
   * Whether the profiler agrees about how much of the frame had no script
   * running. The same verdict every unattributed candidate's confidence
   * carries.
   */
  readonly check: CrossCheck;
}

/** One long animation frame, attributed. */
export interface FrameAttribution {
  /** Carried so that every millisecond figure here can be quoted with it. */
  readonly provenance: CaptureProvenance;
  readonly frame: LongAnimationFrame;
  readonly decomposition: FrameDecomposition;
  /**
   * The label of the interaction whose window the frame began in, or `null`
   * for a frame no interaction claims: one during load, or after the drive.
   */
  readonly interaction: string | null;
  /**
   * The whole every weight is a share of: the frame's own `duration`, which
   * ends at `paintTime` and not at presentation. Named because a share of
   * `duration` is a smaller share of what the user waited for
   * (`shareOfFrame` converts).
   */
  readonly denominator: Extract<FrameDenominator, 'frame-duration'>;
  /**
   * Every slice of the frame as a candidate, in descending weight order. The
   * weights sum to 1 on a frame whose record is consistent, which is every
   * frame in the corpus.
   */
  readonly causes: RankedCauses;
  readonly unattributed: UnattributedShare;
  /**
   * The React commits that landed inside the frame, with their own component
   * rankings. Empty for a frame with no React in it.
   */
  readonly commits: readonly CommitAttribution[];
  readonly notes: readonly FrameAttributionNote[];
}

/** The profiler's side of one frame's cross-check. */
interface InFrameSamples {
  /** As the trace holds them, for the evidence. */
  readonly samples: number;
  readonly samplesWithoutStack: number;
  /** The same two with bursts collapsed, which is what the check compares. */
  readonly independentSamples: number;
  readonly independentSamplesWithoutStack: number;
}

/** What the rest of the capture says about one frame. */
interface FrameContext {
  readonly provenance: CaptureProvenance;
  readonly interaction: string | null;
  /** The commits that landed in this frame, in commit order. */
  readonly commits: readonly CommitAttribution[];
  /**
   * For a script slice, the functions the profiler saw in every slice of the
   * same site and interaction, or `undefined` with no profile.
   */
  readonly pooledFunctions: (slice: ScriptSlice) => FunctionAttribution | undefined;
  /** `null` with no profile. */
  readonly inFrameSamples: InFrameSamples | null;
}

/** Why each non-script, non-rendering slice has no cause. */
const REASON_BY_SLICE = {
  'before-first-script': 'before-first-reported-script',
  'between-scripts': 'between-reported-scripts',
  'script-to-render': 'outside-script-and-rendering-update',
  'pre-style-and-layout': 'rendering-update-before-style-and-layout',
  'after-last-script': 'after-last-reported-script',
} as const satisfies Partial<Record<FrameSlice['kind'], UnattributedReason>>;

/** A commit attributed from fiber timings, which is the only kind a slice is divided by. */
type TimedCommit = CommitAttribution & {
  readonly basis: Extract<CommitAttribution['basis'], { tier: 'react-fiber-timings' }>;
};

function isTimed(commit: CommitAttribution): commit is TimedCommit {
  return commit.basis.tier === 'react-fiber-timings';
}

/** Whether a commit's timestamp falls inside a script slice, to within the timing grid. */
function landedIn(slice: ScriptSlice, commit: CommitAttribution): boolean {
  const at = commit.commit.committedAtMs;
  return (
    !exceedsByMoreThanCoarsening(slice.startMs, at) &&
    !exceedsByMoreThanCoarsening(at, slice.startMs + slice.durationMs)
  );
}

/**
 * How far a slice's timed commits fall short of fitting inside it, in
 * milliseconds, or 0 when they fit to within the timing grid.
 *
 * Two conditions, both LoAF's boundaries checking React's timers. Each
 * commit's render must have begun after the slice did: the hook reports only
 * when a commit finished, but the render cannot have ended later than that,
 * so `committedAt - totalMs` is the latest it can have begun. And together
 * the renders cannot be longer than the JavaScript the slice ran.
 */
function shortfallOfFit(slice: ScriptSlice, commits: readonly TimedCommit[]): number {
  let shortfallMs = 0;
  let totalMs = 0;
  for (const commit of commits) {
    const { totalMs: renderMs } = commit.basis.times;
    totalMs += renderMs;
    const latestStartMs = commit.commit.committedAtMs - renderMs;
    if (exceedsByMoreThanCoarsening(slice.startMs, latestStartMs)) {
      shortfallMs = Math.max(shortfallMs, slice.startMs - latestStartMs);
    }
  }
  if (exceedsByMoreThanCoarsening(totalMs, slice.interior.selfJavaScriptMs)) {
    shortfallMs = Math.max(shortfallMs, totalMs - slice.interior.selfJavaScriptMs);
  }
  return shortfallMs;
}

/** Milliseconds of one named thing in a frame, with the evidence for them. */
interface Charge {
  ms: number;
  readonly evidence: NonEmptyEvidence;
}

/** A component's self time in a frame, with the subject its commit named it by. */
interface ComponentCharge extends Charge {
  readonly subject: CauseSubject;
}

/**
 * The frame's whole and how a share of it is quoted, fixed once per frame so
 * that every candidate divides by the same thing.
 */
interface FrameShares {
  /** `ms` as a fraction of the frame, floored at 0. */
  readonly shareOf: (ms: number) => number;
  /** The support of any weight that is a measured duration over the frame. */
  readonly measured: WeightSupport;
}

/**
 * Charges each timed commit's rendered components to `components` by name, at
 * their summed self time with negative self times floored at 0, and returns
 * the milliseconds charged. Each charge carries the slice's script evidence
 * beside the commit's own, so the entry the render ran inside is named.
 */
function chargeTimedComponents(
  timed: readonly TimedCommit[],
  scriptEvidence: CauseEvidence,
  components: Map<string, ComponentCharge>,
): number {
  let renderedMs = 0;
  for (const commit of timed) {
    for (const cause of commit.causes.causes) {
      if (cause.subject.kind !== 'component') continue;
      const { name } = cause.subject;
      const selfMs = commit.basis.times.fibers.reduce(
        (sum, entry) =>
          entry.fiber.name === name && didRender(entry.participation)
            ? sum + Math.max(entry.selfMs, 0)
            : sum,
        0,
      );
      renderedMs += selfMs;
      const existing = components.get(name);
      if (existing === undefined) {
        components.set(name, {
          subject: cause.subject,
          ms: selfMs,
          evidence: [...cause.evidence, scriptEvidence],
        });
      } else {
        existing.ms += selfMs;
        existing.evidence.push(...cause.evidence, scriptEvidence);
      }
    }
  }
  return renderedMs;
}

/**
 * A script slice's own JavaScript, named by the strongest signal that can
 * divide it. See "How a script slice is named" in the module header; the
 * three branches below are its three cases, in order.
 *
 * `landed` is the commits whose timestamp fell in the slice. Component self
 * times are added to `components`, which the caller turns into candidates
 * once the whole frame has been walked, because one component can render in
 * more than one slice. Everything else is returned as candidates, with a note
 * for each commit whose render did not fit.
 */
function nameScriptJavaScript(
  slice: ScriptSlice,
  landed: readonly CommitAttribution[],
  pooled: FunctionAttribution | undefined,
  components: Map<string, ComponentCharge>,
  { shareOf, measured }: FrameShares,
): { candidates: CandidateCause[]; notes: FrameAttributionNote[] } {
  const site = scriptEntrySiteOf(slice);
  const { selfJavaScriptMs } = slice.interior;
  const scriptEvidence: CauseEvidence = {
    kind: 'loaf-script',
    scriptIndex: slice.scriptIndex,
    durationMs: slice.durationMs,
    resolvedFromCharPosition: false,
  };

  const timed = landed.filter(isTimed);
  const shortfallMs = shortfallOfFit(slice, timed);
  const notes: FrameAttributionNote[] =
    shortfallMs > 0
      ? timed.map((commit) => ({
          kind: 'commit-render-does-not-fit-script',
          scriptIndex: slice.scriptIndex,
          committedAtMs: commit.commit.committedAtMs,
          byMs: shortfallMs,
        }))
      : [];

  // 1. Fiber timings: components hold their self time, the entry the rest.
  if (timed.length > 0 && shortfallMs === 0) {
    const renderedMs = chargeTimedComponents(timed, scriptEvidence, components);
    const restMs = selfJavaScriptMs - renderedMs;
    const rest: CandidateCause[] =
      restMs > 0
        ? [
            {
              subject: { kind: 'script-entry', site, scope: 'outside-component-renders' },
              weight: confidenceWeight(shareOf(restMs), 'frame-slice-share', measured),
              tier: 'loaf-script-registration',
              evidence: [scriptEvidence],
            },
          ]
        : [];
    return { candidates: rest, notes };
  }

  // 2. Sampled functions, pooled over this site's slices in the interaction.
  const jsShare = shareOf(selfJavaScriptMs);
  if (pooled !== undefined && pooled.causes.causes.length > 0) {
    const candidates = pooled.causes.causes.flatMap((cause): CandidateCause[] => {
      const { support } = cause.weight.confidence;
      // Every weight `attributeSampledFunctions` builds is sampled.
      if (support.kind !== 'sampled') return [];
      return [
        {
          subject: cause.subject,
          weight: confidenceWeight(
            jsShare * cause.weight.fraction,
            'frame-slice-sample-share',
            { ...support, ofMeasuredShare: jsShare },
          ),
          tier: cause.tier,
          evidence: [...cause.evidence, scriptEvidence],
        },
      ];
    });
    return { candidates, notes };
  }

  // 3. The entry itself, with the components of any commit that landed in it
  // as evidence of what overlapped it.
  return {
    candidates: [
      {
        subject: { kind: 'script-entry', site, scope: 'whole-entry' },
        weight: confidenceWeight(jsShare, 'frame-slice-share', measured),
        tier: 'loaf-script-registration',
        evidence: [
          scriptEvidence,
          ...landed.flatMap((commit) => renderedEvidence(commit.components)),
        ],
      },
    ],
    notes,
  };
}

/**
 * The frame's whole, and the shares every candidate of the frame is quoted in.
 * Returned with the whole in milliseconds, which the cross-check also divides.
 */
function frameSharesOf(
  frame: LongAnimationFrame,
  decomposition: FrameDecomposition,
): { readonly wholeMs: number; readonly shares: FrameShares } {
  const sliced = decomposition.slices.reduce((sum, slice) => sum + slice.durationMs, 0);
  /*
   * The frame's duration, which the slices sum to on every corpus frame to
   * within 2e-9ms. The larger of the two only so that a record whose slices
   * overran its duration, which `decomposition.notes` would report, still
   * yields weights that sum to 1 rather than throwing: always produce
   * something. It can only lengthen the denominator, never shorten the frame.
   */
  const whole = Math.max(frame.durationMs, sliced);
  return {
    wholeMs: whole,
    shares: {
      shareOf: (ms) => (whole > 0 ? Math.max(ms, 0) / whole : 0),
      measured: measuredSupport(whole),
    },
  };
}

/** The style and layout a script slice forced, charged to its entry, or `null` for none. */
function forcedStyleAndLayoutCandidate(
  slice: ScriptSlice,
  { shareOf, measured }: FrameShares,
): CandidateCause | null {
  const { forcedStyleAndLayoutMs } = slice.interior;
  if (forcedStyleAndLayoutMs <= 0) return null;
  return {
    subject: {
      kind: 'browser-work',
      what: 'forced-style-and-layout',
      forcedBy: scriptEntrySiteOf(slice),
    },
    weight: confidenceWeight(
      shareOf(forcedStyleAndLayoutMs),
      'frame-slice-share',
      measured,
    ),
    tier: 'loaf-script-registration',
    evidence: [
      {
        kind: 'forced-style-and-layout',
        scriptIndex: slice.scriptIndex,
        durationMs: forcedStyleAndLayoutMs,
      },
    ],
  };
}

/** The rendering update's own style, layout or paint, which no script forced. */
function renderingUpdateCandidate(
  slice: Extract<FrameSlice, { kind: 'style' | 'layout' | 'paint' }>,
  { shareOf, measured }: FrameShares,
): CandidateCause {
  return {
    subject: { kind: 'browser-work', what: slice.kind, forcedBy: null },
    weight: confidenceWeight(shareOf(slice.durationMs), 'frame-slice-share', measured),
    tier: 'loaf-timing-only',
    evidence: [{ kind: 'frame-slice', slice: slice.kind, durationMs: slice.durationMs }],
  };
}

/**
 * The unattributed candidates, one per reason, each resting on subtraction and
 * carrying the frame's cross-check.
 */
function unattributedCandidates(
  unattributed: ReadonlyMap<UnattributedReason, Charge>,
  check: CrossCheck,
  inFrameSamples: InFrameSamples | null,
  { shareOf }: FrameShares,
): CandidateCause[] {
  /*
   * Where there was a profile, the raw empty-stack count is on the evidence
   * beside the slices, so the second signal is inspectable in the same place
   * as the first.
   */
  const emptyStackEvidence: CauseEvidence[] =
    inFrameSamples === null
      ? []
      : [
          {
            kind: 'empty-stack-share',
            samplesWithoutStack: inFrameSamples.samplesWithoutStack,
            ofSamplesInFrame: inFrameSamples.samples,
          },
        ];
  return [...unattributed].map(([reason, { ms, evidence }]) => ({
    subject: { kind: 'unattributed', reason },
    weight: confidenceWeight(shareOf(ms), 'frame-slice-share', {
      kind: 'subtraction',
      check,
    }),
    tier: 'unattributed',
    evidence: [...evidence, ...emptyStackEvidence],
  }));
}

/**
 * Attributes one frame. See the module header for how each slice is named.
 * Every weight is a share of the frame's duration.
 */
function attributeFrame(
  frame: LongAnimationFrame,
  context: FrameContext,
): FrameAttribution {
  const decomposition = decomposeFrame(frame);
  const { wholeMs, shares } = frameSharesOf(frame, decomposition);
  const { shareOf } = shares;

  const scriptMs = decomposition.slices.reduce(
    (sum, slice) => sum + (slice.kind === 'script' ? slice.durationMs : 0),
    0,
  );
  const { inFrameSamples } = context;
  const check = crossCheckEmptyStacks(
    shareOf(wholeMs - scriptMs),
    inFrameSamples === null
      ? null
      : {
          samplesWithoutStack: inFrameSamples.independentSamplesWithoutStack,
          ofSamplesInFrame: inFrameSamples.independentSamples,
        },
  );

  const candidates: CandidateCause[] = [];
  const notes: FrameAttributionNote[] = [];
  /** Component self time by name, summed across the frame's slices and commits. */
  const components = new Map<string, ComponentCharge>();
  /** Unattributed time by reason, summed across the slices that share one. */
  const unattributed = new Map<UnattributedReason, Charge>();
  const placed = new Set<CommitAttribution>();

  for (const slice of decomposition.slices) {
    switch (slice.kind) {
      case 'script': {
        const forced = forcedStyleAndLayoutCandidate(slice, shares);
        if (forced !== null) candidates.push(forced);

        // A commit on the boundary two adjacent slices share goes to the
        // earlier one, once.
        const landed = context.commits.filter(
          (commit) => !placed.has(commit) && landedIn(slice, commit),
        );
        for (const commit of landed) placed.add(commit);
        if (slice.interior.selfJavaScriptMs <= 0) break;

        const named = nameScriptJavaScript(
          slice,
          landed,
          context.pooledFunctions(slice),
          components,
          shares,
        );
        candidates.push(...named.candidates);
        notes.push(...named.notes);
        break;
      }

      case 'style':
      case 'layout':
      case 'paint':
        candidates.push(renderingUpdateCandidate(slice, shares));
        break;

      case 'before-first-script':
      case 'between-scripts':
      case 'script-to-render':
      case 'pre-style-and-layout':
      case 'after-last-script': {
        const reason = REASON_BY_SLICE[slice.kind];
        const evidence: CauseEvidence = {
          kind: 'frame-slice',
          slice: slice.kind,
          durationMs: slice.durationMs,
        };
        const existing = unattributed.get(reason);
        if (existing === undefined) {
          unattributed.set(reason, { ms: slice.durationMs, evidence: [evidence] });
        } else {
          existing.ms += slice.durationMs;
          existing.evidence.push(evidence);
        }
        break;
      }
    }
  }

  for (const commit of context.commits) {
    if (placed.has(commit)) continue;
    notes.push({
      kind: 'commit-outside-every-script',
      committedAtMs: commit.commit.committedAtMs,
    });
  }

  for (const { subject, ms, evidence } of components.values()) {
    candidates.push({
      subject,
      weight: confidenceWeight(shareOf(ms), 'fiber-self-time-share', shares.measured),
      tier: 'react-fiber-timings',
      evidence,
    });
  }

  candidates.push(...unattributedCandidates(unattributed, check, inFrameSamples, shares));

  const unattributedMs = decomposition.charges.unattributedMs;
  return {
    provenance: context.provenance,
    frame,
    decomposition,
    interaction: context.interaction,
    denominator: 'frame-duration',
    causes: rankCauses(candidates),
    unattributed: { ms: unattributedMs, fraction: shareOf(unattributedMs), check },
    commits: context.commits,
    notes,
  };
}

/** The samples inside one frame, by `isWithinFrame`, raw and independent. */
function inFrameSamplesOf(
  frame: LongAnimationFrame,
  profile: ProfileTrace,
  independence: readonly number[],
): InFrameSamples {
  const counts = {
    samples: 0,
    samplesWithoutStack: 0,
    independentSamples: 0,
    independentSamplesWithoutStack: 0,
  };
  for (const [index, sample] of profile.samples.entries()) {
    if (!isWithinFrame(frame, sample.atMs)) continue;
    // One weight per sample, by `independentSampleWeights`' contract.
    const independent = independence[index] ?? 1;
    counts.samples += 1;
    counts.independentSamples += independent;
    if (sample.stackId !== null) continue;
    counts.samplesWithoutStack += 1;
    counts.independentSamplesWithoutStack += independent;
  }
  return counts;
}

/** The label of the interaction whose window a frame began in. See `framesOfInteraction`. */
function interactionOf(
  signals: CapturedSignals,
  frame: LongAnimationFrame,
): string | null {
  return (
    signals.interactions.find((window) => frameBeganIn(frame, window))?.label ?? null
  );
}

/**
 * The sampled functions of every script slice in the capture, pooled by the
 * interaction its frame began in and the site LoAF named, and looked up by
 * that same pair. `labels` holds each frame's interaction label, in
 * `signals.frames` order.
 */
function functionPools(
  signals: CapturedSignals,
  resolved: ResolvedProfile,
  labels: readonly (string | null)[],
): (label: string | null, slice: ScriptSlice) => FunctionAttribution | undefined {
  /*
   * The pools: every script slice in the capture, grouped by the interaction
   * its frame began in and the site LoAF named, with one function
   * attribution per group. A slice finds its pool by that same pair, so
   * nothing depends on the slice objects being shared: each frame is
   * decomposed once here and again in `attributeFrame`, and the partition is
   * deterministic.
   */
  const poolKeyOf = (label: string | null, slice: ScriptSlice): string =>
    JSON.stringify([label, scriptEntrySiteKey(scriptEntrySiteOf(slice))]);

  const groups = new Map<string, ScriptSlice[]>();
  for (const [index, frame] of signals.frames.entries()) {
    for (const slice of decomposeFrame(frame).slices) {
      if (slice.kind !== 'script') continue;
      const key = poolKeyOf(labels[index] ?? null, slice);
      const group = groups.get(key) ?? [];
      group.push(slice);
      groups.set(key, group);
    }
  }

  const pools = new Map<string, FunctionAttribution>();
  for (const [key, slices] of groups) {
    pools.set(
      key,
      attributeSampledFunctions(
        resolved,
        signals.provenance,
        scriptSlicePopulation(slices),
      ),
    );
  }
  return (label, slice) => pools.get(poolKeyOf(label, slice));
}

/**
 * Attributes every long frame in a capture.
 *
 * Returns one `FrameAttribution` per entry of `signals.frames`, in the same
 * order: ranked candidate causes whose weights are shares of the frame's
 * `duration`, the unattributed share with its cross-check, and the commits
 * that landed in the frame. Always returns an attribution for every frame,
 * whatever signals are missing; each candidate's tier says what it was
 * working from.
 *
 * `resolved` is `resolveProfile(signals.profile)`, or `null` when the capture
 * has no profile, in which case no function is named and no unattributed
 * share is cross-checked. `commits` is every commit attribution the caller
 * holds for this capture; each is matched to the frame it recorded landing
 * in. Assumes both were built from `signals`.
 */
export function attributeFrames(
  signals: CapturedSignals,
  resolved: ResolvedProfile | null,
  commits: readonly CommitAttribution[],
): readonly FrameAttribution[] {
  const labels = signals.frames.map((frame) => interactionOf(signals, frame));
  const pooledFunctions =
    resolved === null ? null : functionPools(signals, resolved, labels);
  const independence =
    signals.profile === null ? null : independentSampleWeights(signals.profile);

  return signals.frames.map((frame, index) => {
    const label = labels[index] ?? null;
    return attributeFrame(frame, {
      provenance: signals.provenance,
      interaction: label,
      commits: commits.filter((commit) => commit.frame === frame),
      pooledFunctions: (slice) => pooledFunctions?.(label, slice),
      inFrameSamples:
        signals.profile === null || independence === null
          ? null
          : inFrameSamplesOf(frame, signals.profile, independence),
    });
  });
}

/** One line of prose for a frame-attribution note, with its milliseconds qualified. */
export function describeFrameNote(
  note: FrameAttributionNote,
  provenance: CaptureProvenance,
): string {
  switch (note.kind) {
    case 'commit-render-does-not-fit-script':
      return (
        `a React commit landed inside script ${String(note.scriptIndex)}, but its render is ` +
        `${formatMilliseconds(note.byMs, provenance)} too long to have run there, so its ` +
        'components are not charged to this frame'
      );
    case 'commit-outside-every-script':
      return 'a React commit landed inside the frame but outside every script it reported';
  }
}
