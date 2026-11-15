/**
 * The React tier: which components rendered in a commit, and how much of the
 * commit each one's own render took.
 *
 * The primary signal is the DevTools hook's fiber tree with each fiber's
 * `actualDuration`, in a development build. It saw every component that
 * rendered in every scenario the corpus holds, including the `setState` owner,
 * the context consumer and every first mount, which React's own
 * `performance.measure` spans are structurally blind to. So spans enter here
 * as corroboration only: one attaches to a candidate as extra evidence and
 * never changes its weight or its rank. A ranking that moved with span
 * presence would put `DeepEqualProps`, which React names on every render,
 * above the components that did the new work.
 *
 * ## A commit is evidence on its own
 *
 * Nothing here requires a long animation frame. `spans`' `state-owner-self`
 * interaction renders `StateOwner` for 25.2ms (development, 4x) and produces no
 * long frame, being under LoAF's 50ms threshold. It also gets no span. The
 * fiber tree is the only signal that saw it. So a commit is attributed in its
 * own right, and the long frame it landed in is recorded beside the answer as
 * `null` when there was none, rather than being a precondition for one.
 *
 * ## Self time
 *
 * Which fibers took part in the commit, and each one's self time, come from
 * `fiber-self-time.ts`. Its header records why the subtraction runs over
 * in-commit fibers only, and why the self time of fibers React bailed out of
 * is charged to no component, which is what makes a commit's ranked weights
 * sum to less than 1.
 *
 * ## When the React tier is unavailable
 *
 * A production build still calls the hook on every commit, and still sets
 * `PerformedWork`, so *which* components rendered is still known. But
 * `actualDuration` is null and the names are minified: `b`, `m`, `h`, `g`, `v`
 * and `_` in `spans`. An answer of "nothing" would be a lie of omission, so the commit
 * degrades to the profiler and says so. Samples inside the commit's window are
 * charged to the innermost stack frame whose name is one of the commit's
 * rendered component names, and the share of samples is the weight. This
 * works because the hook's minified `name` and the profiler's minified
 * function name are the same identifier, read from the same bundle. In the
 * `spans` production capture every sample inside a component's render has
 * that component's frame, under exactly the name the hook reports, directly
 * beneath one shared React frame (minified `os`) and directly above the shared
 * `burn` helper (minified `d`).
 *
 * The tier is `profiler-unmapped`. The bundle ships a source map, but
 * resolving one is the next tier's job and is not done here, so every name is
 * reported as minified and every position as generated code.
 *
 * ## What this module does not do
 *
 * It does not split a frame among causes, resolve a source map, weigh a
 * commit against the frame it landed in, or decide whether an interaction was
 * slow, and it does not do the self-time subtraction itself. It answers one
 * question, which components rendered and their share of
 * the render, and states which tier the answer came from.
 *
 * **Clock.** Every `…Ms` timestamp is page-clock `performance.now()`
 * milliseconds; every `…Ms` duration is milliseconds of the same clock.
 */

import {
  type AttributionTier,
  type CandidateCause,
  type CauseEvidence,
  type CauseSubject,
  confidenceWeight,
  describeTier,
  type RankedCauses,
  rankCauses,
  type SourceLocation,
  type WeightBasis,
} from './attribution.ts';
import {
  type CommitRenderTimes,
  type CommitTimingNote,
  commitRenderTimes,
  didRender,
  type FiberParticipation,
  participationIn,
  participationsOf,
  type ReactTierShortfall,
  type RenderedParticipation,
} from './fiber-self-time.ts';
import {
  exceedsByMoreThanCoarsening,
  isWithinFrame,
  type LongAnimationFrame,
} from './loaf.ts';
import {
  type ProfiledFrame,
  profiledFramePosition,
  type ProfileTrace,
  stackFrames,
} from './profiler.ts';
import { type CaptureProvenance, formatMilliseconds } from './provenance.ts';
import type { FiberId, ReactCommit, ReactSpan } from './react.ts';
import {
  type CapturedSignals,
  framesOfInteraction,
  type InteractionWindow,
} from './signals.ts';

/**
 * One recorded component fiber and what the hook says it did, available at
 * every tier: in production the hook still reports which components rendered,
 * just not for how long.
 */
export interface CommitComponent {
  /** Its index in the commit's fiber list. */
  readonly fiberIndex: number;
  /** As the hook reported it, minified in a production build. */
  readonly name: string;
  /**
   * `not-recorded` for a capture made before the collector recorded render
   * evidence, where whether the fiber rendered is unknown.
   */
  readonly participation: FiberParticipation | 'not-recorded';
}

/** The page-clock window samples and spans were matched against, in milliseconds. */
export interface CommitSampleWindow {
  /**
   * Exclusive. The latest of the interaction's start, the previous commit, and
   * the interaction's last input action at or before this commit. See
   * `commitWindowStart`.
   */
  readonly fromMs: number;
  /** Inclusive. The commit itself. */
  readonly toMs: number;
}

/**
 * What a commit's attribution was derived from. A union on the tier, so a
 * degraded answer cannot be written without the reason it degraded.
 */
export type CommitAttributionBasis =
  | {
      readonly tier: 'react-fiber-timings';
      /**
       * Carries `bailedOutSelfMs`, the self time of fibers React bailed out
       * of, which is charged to no component. It is why a commit's ranked
       * weights can sum to less than 1: the shortfall is its positive part
       * over the denominator, and equals `bailedOutSelfMs` over it unless a
       * bailed-out fiber's self time went negative, which a
       * `negative-self-time` note reports.
       */
      readonly times: CommitRenderTimes;
    }
  | {
      /**
       * Sample shares, with component identity from the hook's names. The
       * names are joined against unresolved profiler frames, which is why
       * this is `profiler-unmapped` even where the bundle ships a source map.
       */
      readonly tier: 'profiler-unmapped';
      readonly shortfall: ReactTierShortfall;
      /** Samples with a stack inside the window, which is the denominator. */
      readonly samplesInWindow: number;
      /**
       * Of those, the samples charged to no candidate, which is why the ranked
       * weights sum to `1 - unchargedSamples / samplesInWindow`. Mostly
       * stacks that reach no rendered component's frame: React's own
       * reconciliation and commit work, or whatever ran in the window before
       * the render began. Also any whose innermost match was a name the
       * `ambiguous-minified-name` note reports.
       */
      readonly unchargedSamples: number;
    }
  | {
      /** The hook named the components, and nothing measured their cost. */
      readonly tier: 'unattributed';
      readonly shortfall: ReactTierShortfall;
      readonly reason: 'no-profiler';
    };

/** Something about a commit's attribution that a report must say. */
export type ComponentAttributionNote =
  | CommitTimingNote
  | {
      /**
       * A rendered component's name belongs to profiler frames at more than
       * one definition site somewhere in the capture's profile, so no sample
       * was charged to it. Minified names are reused across scopes, and at
       * least one of those sites is some other function. The samples stay in
       * the denominator, so the commit's ranked weights fall short of 1 by
       * their share.
       */
      readonly kind: 'ambiguous-minified-name';
      readonly componentName: string;
      readonly definitionSites: number;
    }
  | {
      /**
       * No sample with a stack fell inside the commit's window, so the
       * profiler has nothing to share out. The rendered components are still
       * listed in `components`; none is a candidate.
       */
      readonly kind: 'no-samples-in-window';
    };

/** One commit's component attribution. */
export interface CommitAttribution {
  readonly commit: ReactCommit;
  /** Carried so that every millisecond figure here can be quoted with it. */
  readonly provenance: CaptureProvenance;
  /**
   * The long animation frame the commit landed in, or `null`. `null` is a
   * finding, not missing data: it is what a render under LoAF's 50ms
   * threshold produces, and `state-owner-self` is one.
   */
  readonly frame: LongAnimationFrame | null;
  readonly sampleWindow: CommitSampleWindow;
  /** Every recorded component fiber, rendered or not, in walk order. */
  readonly components: readonly CommitComponent[];
  readonly basis: CommitAttributionBasis;
  /**
   * The rendered components, one candidate per name, weighted by their share
   * of the commit. Several fibers sharing a name, such as a list's rows, are
   * one candidate with one evidence entry per fiber.
   */
  readonly causes: RankedCauses;
  readonly notes: readonly ComponentAttributionNote[];
}

/** A non-empty list of evidence, as `CandidateCause` requires. */
type Evidence = [CauseEvidence, ...CauseEvidence[]];

/** One candidate's raw share before it becomes a weight, so commits can be merged. */
interface Tally {
  readonly name: string;
  readonly subject: CauseSubject;
  numerator: number;
  /** Created with its first entry, so a candidate can never lack evidence. */
  readonly evidence: Evidence;
}

/** A commit's tallies, with the denominator they are shares of. */
interface CommitTally {
  readonly basis: CommitAttributionBasis;
  readonly components: readonly CommitComponent[];
  readonly tallies: readonly Tally[];
  readonly denominator: number;
  readonly notes: readonly ComponentAttributionNote[];
}

/** The weight basis each tier's tallies are shares under. */
function weightBasisOf(tier: AttributionTier): WeightBasis {
  return tier === 'react-fiber-timings' ? 'fiber-self-time-share' : 'sample-share';
}

/**
 * Every recorded fiber as a `CommitComponent`, with its participation where
 * recorded. `participation` is `participationsOf` over the commit's fibers, or
 * `null` exactly when the commit's linkage is unrecorded.
 */
function componentsOf(
  commit: ReactCommit,
  participation: ReadonlyMap<FiberId, FiberParticipation> | null,
): CommitComponent[] {
  const components = commit.components;
  if (components.linkage === 'unrecorded' || participation === null) {
    return components.fibers.map((fiber, fiberIndex) => ({
      fiberIndex,
      name: fiber.name,
      participation: 'not-recorded',
    }));
  }
  return components.fibers.map((fiber) => ({
    fiberIndex: fiber.id,
    name: fiber.name,
    participation: participationIn(participation, fiber),
  }));
}

/**
 * Adds `numerator` and `evidence` to the tally for `name`, creating it with
 * `subject()` the first time the name is seen.
 */
function addToTally(
  tallies: Map<string, Tally>,
  name: string,
  subject: () => CauseSubject,
  numerator: number,
  evidence: Readonly<Evidence>,
): void {
  const existing = tallies.get(name);
  if (existing === undefined) {
    tallies.set(name, { name, subject: subject(), numerator, evidence: [...evidence] });
    return;
  }
  existing.numerator += numerator;
  existing.evidence.push(...evidence);
}

/**
 * The fiber tier: each rendered fiber's self time, grouped by name.
 *
 * The denominator is the summed positive self time of every in-commit fiber,
 * bailed-out ones included. On a consistent commit that is exactly the
 * commit's total, by the telescoping above. On one with a negative self time
 * it is larger than the total, which keeps the weights inside [0, 1]. The
 * `negative-self-time` note travels with the answer, so the larger
 * denominator is never silent.
 *
 * Spans attach as evidence on the candidate whose name they carry, if they
 * fell inside the commit's window. They never touch the numerator.
 */
function tallyFiberTimings(
  times: CommitRenderTimes,
  spans: readonly ReactSpan[],
  window: CommitSampleWindow,
): { tallies: Tally[]; denominator: number } {
  const tallies = new Map<string, Tally>();
  const denominator = times.fibers.reduce(
    (sum, entry) => sum + Math.max(entry.selfMs, 0),
    0,
  );

  for (const entry of times.fibers) {
    if (!didRender(entry.participation)) continue;
    addToTally(
      tallies,
      entry.fiber.name,
      () => ({
        kind: 'component',
        name: entry.fiber.name,
        nameIsMinified: false,
        definedAt: null,
      }),
      Math.max(entry.selfMs, 0),
      [
        {
          kind: 'fiber-render-time',
          componentName: entry.fiber.name,
          actualDurationMs: entry.actualDurationMs,
          selfDurationMs: entry.selfMs,
        },
      ],
    );
  }

  /*
   * A component span belongs to the commit its render preceded: it ends
   * before the commit and after the previous one. React emits it during the
   * render, so its end is at or before `committedAtMs`. Two coarsening steps
   * of slack on each side absorb the timing grid. Matched by name because a
   * span carries nothing else, so two same-named components in one commit
   * would share their spans.
   */
  for (const span of spans) {
    if (span.kind !== 'component') continue;
    const endMs = span.startTimeMs + span.durationMs;
    if (exceedsByMoreThanCoarsening(window.fromMs, span.startTimeMs)) continue;
    if (exceedsByMoreThanCoarsening(endMs, window.toMs)) continue;
    tallies.get(span.componentName)?.evidence.push({
      kind: 'react-component-span',
      componentName: span.componentName,
      durationMs: span.durationMs,
    });
  }

  return { tallies: [...tallies.values()], denominator };
}

/** A stable key for a profiler frame's definition site. */
function definitionSiteKey(frame: ProfiledFrame): string {
  return `${String(frame.resourceId)}:${String(frame.line)}:${String(frame.column)}`;
}

/**
 * Every named function in a profile, by name, with one frame per distinct
 * definition site.
 *
 * Built once per capture, over all of `profile.frames` rather than over the
 * samples in any one window. Whether a minified name is ambiguous is a
 * property of the bundle, not of which functions happened to be sampled
 * between two commits: a name with a second site anywhere in the profile is
 * shared by two functions, and a window that sampled only one of them cannot
 * tell which one it was. Deciding per window would charge a commit's samples
 * to a name that another window shows to be shared.
 *
 * What remains assumed: a name with exactly one site in the whole profile is
 * taken to be the component. A component that was never sampled, sharing its
 * minified name with one other function that was, would have that function's
 * samples charged to it. Nothing in an unmapped profile can rule that out; the
 * source map, which step 4 resolves, can.
 *
 * In the corpus every name the hook reported has exactly one site in its
 * capture's profile: `h` and `re` in `derive-in-render`, and `b`, `m`, `h`,
 * `g`, `v` and `_` in `spans` (production, 4x).
 */
type DefinitionSites = ReadonlyMap<string, readonly ProfiledFrame[]>;

/** Indexes a profile's frames by name and definition site. See `DefinitionSites`. */
function definitionSitesOf(profile: ProfileTrace): DefinitionSites {
  const byName = new Map<string, Map<string, ProfiledFrame>>();
  for (const frame of profile.frames) {
    if (frame.name === null) continue;
    const sites = byName.get(frame.name) ?? new Map<string, ProfiledFrame>();
    sites.set(definitionSiteKey(frame), frame);
    byName.set(frame.name, sites);
  }
  return new Map([...byName].map(([name, sites]) => [name, [...sites.values()]]));
}

/** Where a profiler frame's function is defined, in generated code. */
function generatedLocation(
  profile: ProfileTrace,
  frame: ProfiledFrame,
): SourceLocation | null {
  const position = profiledFramePosition(frame);
  if (frame.resourceId === null || position === null) return null;
  const resource = profile.resources[frame.resourceId];
  if (resource === undefined) return null;
  return { file: resource.url, position, throughSourceMap: false };
}

/** A component the hook says rendered, or one whose participation is unknown. */
type RenderedOrUnknown = CommitComponent & {
  readonly participation: RenderedParticipation | 'not-recorded';
};

/** Whether the hook says a component rendered, or did not record whether it did. */
function isRenderedOrUnknown(component: CommitComponent): component is RenderedOrUnknown {
  return component.participation === 'not-recorded' || didRender(component.participation);
}

/** A profile and its per-capture name index, built together. */
interface IndexedProfile {
  readonly profile: ProfileTrace;
  readonly sites: DefinitionSites;
}

/** The capture's profile with its name index, or `null` when there was no profiler. */
function indexProfile(profile: ProfileTrace | null): IndexedProfile | null {
  return profile === null ? null : { profile, sites: definitionSitesOf(profile) };
}

/**
 * The profiler tier: samples in the commit's window charged to rendered
 * components by name.
 *
 * Each sample with a stack is walked from the leaf outward to the first frame
 * whose name is a rendered component's. The innermost match is the one that
 * counts, because the leaf is where the time was spent. In `spans` the leaf is
 * the shared `burn` helper, and the frame beneath it is the component that
 * called it. A sample with no matching frame stays in the denominator only:
 * it is React's own reconciliation and commit work, or whatever ran in the
 * window before the render began.
 *
 * A name with more than one definition site in the capture's profile is not
 * charged at all (see `ambiguous-minified-name` and `DefinitionSites`). A
 * component is one function at one site, so a second site means another
 * function shares the minified name, and there is no way to tell which
 * samples were whose. Its samples are not passed on to a component further
 * out on the stack either: whichever function it was, its time is not that
 * outer component's self time.
 */
function tallySamples(
  components: readonly CommitComponent[],
  { profile, sites }: IndexedProfile,
  window: CommitSampleWindow,
  provenance: CaptureProvenance,
): {
  tallies: Tally[];
  samplesInWindow: number;
  unchargedSamples: number;
  notes: ComponentAttributionNote[];
} {
  // Where render evidence was not recorded, every fiber is a possible
  // renderer: nothing in the record can rule one out.
  const fibersByName = new Map<string, RenderedOrUnknown[]>();
  for (const component of components.filter(isRenderedOrUnknown)) {
    const fibers = fibersByName.get(component.name) ?? [];
    fibers.push(component);
    fibersByName.set(component.name, fibers);
  }

  const counts = new Map<string, number>();
  let samplesInWindow = 0;
  for (const sample of profile.samples) {
    if (sample.stackId === null) continue;
    if (sample.atMs <= window.fromMs || sample.atMs > window.toMs) continue;
    samplesInWindow += 1;

    const match = stackFrames(profile, sample.stackId).find(
      (frame) => frame.name !== null && fibersByName.has(frame.name),
    );
    if (match?.name == null) continue;
    counts.set(match.name, (counts.get(match.name) ?? 0) + 1);
  }

  // Reported rather than divided by: with nothing in the window, every
  // rendered component would otherwise carry a weight of 0 of 0.
  if (samplesInWindow === 0 && fibersByName.size > 0) {
    return {
      tallies: [],
      samplesInWindow,
      unchargedSamples: 0,
      notes: [{ kind: 'no-samples-in-window' }],
    };
  }

  const notes: ComponentAttributionNote[] = [];
  const tallies: Tally[] = [];
  const nameIsMinified = provenance.buildMode === 'production';
  let chargedSamples = 0;

  for (const [name, fibers] of fibersByName) {
    const nameSites = sites.get(name) ?? [];
    const ambiguous = nameSites.length > 1;
    const [site] = nameSites;
    if (ambiguous) {
      notes.push({
        kind: 'ambiguous-minified-name',
        componentName: name,
        definitionSites: nameSites.length,
      });
    }

    const samples = ambiguous ? 0 : (counts.get(name) ?? 0);
    chargedSamples += samples;
    tallies.push({
      name,
      subject: {
        kind: 'component',
        name,
        nameIsMinified,
        definedAt:
          !ambiguous && site !== undefined ? generatedLocation(profile, site) : null,
      },
      numerator: samples,
      evidence: [
        {
          kind: 'profiler-samples',
          samples,
          ofSamplesInWindow: samplesInWindow,
          window: 'since-previous-commit',
        },
        ...fibers.flatMap((fiber): CauseEvidence[] =>
          fiber.participation === 'not-recorded'
            ? []
            : [
                {
                  kind: 'fiber-rendered',
                  componentName: name,
                  participation: fiber.participation,
                },
              ],
        ),
      ],
    });
  }

  return {
    tallies,
    samplesInWindow,
    unchargedSamples: samplesInWindow - chargedSamples,
    notes,
  };
}

/** Picks the strongest tier a commit supports and tallies it there. */
function tallyCommit(
  signals: CapturedSignals,
  profile: IndexedProfile | null,
  commit: ReactCommit,
  window: CommitSampleWindow,
): CommitTally {
  // Built once and shared by both readers, so they cannot disagree about
  // which fibers took part.
  const participation =
    commit.components.linkage === 'recorded'
      ? participationsOf(commit.components.fibers)
      : null;
  const components = componentsOf(commit, participation);
  const timing = commitRenderTimes(commit, participation ?? undefined);

  if (timing.kind === 'timed') {
    const { times } = timing;
    const { tallies, denominator } = tallyFiberTimings(
      times,
      signals.react.spans,
      window,
    );
    return {
      basis: { tier: 'react-fiber-timings', times },
      components,
      tallies,
      denominator,
      notes: times.notes,
    };
  }

  if (profile === null) {
    return {
      basis: { tier: 'unattributed', shortfall: timing.shortfall, reason: 'no-profiler' },
      components,
      tallies: [],
      denominator: 0,
      notes: [],
    };
  }

  const sampled = tallySamples(components, profile, window, signals.provenance);
  return {
    basis: {
      tier: 'profiler-unmapped',
      shortfall: timing.shortfall,
      samplesInWindow: sampled.samplesInWindow,
      unchargedSamples: sampled.unchargedSamples,
    },
    components,
    tallies: sampled.tallies,
    denominator: sampled.samplesInWindow,
    notes: sampled.notes,
  };
}

/**
 * Turns tallies into ranked causes at one tier.
 *
 * A zero denominator gives every candidate a zero weight rather than a
 * division: a commit whose components all rendered in 0ms on the 100us grid
 * still names them, at no weight.
 */
function rankTallies(
  tier: AttributionTier,
  tallies: readonly Tally[],
  denominator: number,
): RankedCauses {
  const basis = weightBasisOf(tier);
  return rankCauses(
    tallies.map((tally): CandidateCause => ({
      subject: tally.subject,
      weight: confidenceWeight(
        denominator > 0 ? tally.numerator / denominator : 0,
        basis,
      ),
      tier,
      evidence: tally.evidence,
    })),
  );
}

/** The long frame a page-clock instant fell inside, or `null`. */
function frameAt(
  frames: readonly LongAnimationFrame[],
  atMs: number,
): LongAnimationFrame | null {
  return frames.find((frame) => isWithinFrame(frame, atMs)) ?? null;
}

/**
 * Attributes one commit to the components that rendered in it.
 *
 * `sinceMs` opens the commit's sample window, in page-clock milliseconds; the
 * window closes at the commit itself. `attributeInteractionComponents` passes
 * the latest of the interaction's start, the previous commit's
 * `committedAtMs` and the last input action at or before this commit (see
 * `commitWindowStart`). At the fiber tier the window decides only which spans
 * corroborate. At the profiler tier it decides which samples are shared out.
 *
 * Returns the strongest tier the commit supports: `react-fiber-timings` when
 * the record carries links and timings, else `profiler-unmapped` when a
 * profile exists, else `unattributed`, with the shortfall named in every
 * degraded case. Weights are shares of this commit, not of any frame. Assumes
 * `commit` is one of `signals.react.commits`, though only its own fields are
 * read.
 */
export function attributeCommit(
  signals: CapturedSignals,
  commit: ReactCommit,
  sinceMs: number,
): CommitAttribution {
  return attributeInWindow(signals, indexProfile(signals.profile), commit, sinceMs)
    .attribution;
}

/**
 * One commit's attribution over the window `(sinceMs, committedAtMs]`, with
 * the tallies it was ranked from, which an interaction merges across its
 * commits.
 */
function attributeInWindow(
  signals: CapturedSignals,
  profile: IndexedProfile | null,
  commit: ReactCommit,
  sinceMs: number,
): { attribution: CommitAttribution; tally: CommitTally } {
  const sampleWindow = { fromMs: sinceMs, toMs: commit.committedAtMs };
  const tally = tallyCommit(signals, profile, commit, sampleWindow);
  return {
    attribution: {
      commit,
      provenance: signals.provenance,
      frame: frameAt(signals.frames, commit.committedAtMs),
      sampleWindow,
      components: tally.components,
      basis: tally.basis,
      causes: rankTallies(tally.basis.tier, tally.tallies, tally.denominator),
      notes: tally.notes,
    },
    tally,
  };
}

/**
 * Where a commit's sample window opens, in page-clock milliseconds: the
 * latest of the interaction's start, the previous commit's `committedAtMs`,
 * and the last input action at or before the commit.
 *
 * The hook reports when a commit finished, never when its render began, so
 * the window can only bound the render. Each of the three is a point the
 * render cannot have started before:
 *
 * - The interaction's start, because the commit is being claimed for it.
 * - The previous commit, because React renders one commit at a time on the
 *   main thread, and the samples before it belong to that commit.
 * - The last action. The driver reads the page clock before it dispatches the
 *   input (`spike/drive.ts`), so nothing the action caused can precede that
 *   reading. Without this bound a commit's window would open at the previous
 *   commit and take in everything that ran between it and the user's input:
 *   on a page with a polling timer, that timer's samples would be shared out
 *   among the components the input made render.
 *
 * No corpus figure depends on the third bound. In every interaction's commit
 * windows, no stacked sample falls between the older bound and the action:
 * 0 of 96 in `derive-in-render` development and 0 of 69 in production, and 0
 * of 52 in `spans` in each build (4x).
 *
 * An action after the commit is ignored, because the commit cannot have been
 * caused by it. An interaction with no actions, such as a settle step that
 * contains a first mount, is bounded by the other two alone.
 */
function commitWindowStart(
  interaction: InteractionWindow,
  previous: ReactCommit | undefined,
  commit: ReactCommit,
): number {
  let sinceMs = Math.max(
    interaction.fromMs,
    previous?.committedAtMs ?? interaction.fromMs,
  );
  for (const action of interaction.actions) {
    if (action.atMs <= commit.committedAtMs) sinceMs = Math.max(sinceMs, action.atMs);
  }
  return sinceMs;
}

/**
 * An interaction's candidates merged across its commits, at the one tier they
 * all reached.
 */
export interface MergedComponents {
  readonly tier: AttributionTier;
  readonly causes: RankedCauses;
}

/** An interaction React committed in, with its commits' attributions. */
export interface AttributedInteraction {
  readonly kind: 'attributed';
  readonly interaction: InteractionWindow;
  /** Carried so that every millisecond figure here can be quoted with it. */
  readonly provenance: CaptureProvenance;
  /** The long frames that began in the window. May be empty. */
  readonly frames: readonly LongAnimationFrame[];
  readonly commits: readonly [CommitAttribution, ...CommitAttribution[]];
  /**
   * The commits' candidates merged by name, as shares of the interaction's
   * summed denominators, or `null` when its commits were attributed at
   * different tiers. A fiber-time share and a sample share are not the
   * same quantity, so they are not added together. The per-commit answers
   * are still there.
   */
  readonly merged: MergedComponents | null;
}

/** One interaction's component attribution, merged across its commits. */
export type InteractionComponents =
  | AttributedInteraction
  | {
      readonly kind: 'no-commit';
      readonly interaction: InteractionWindow;
      readonly provenance: CaptureProvenance;
      readonly frames: readonly LongAnimationFrame[];
      /**
       * `react-hook-absent` when the capture had no DevTools hook, so React
       * could have rendered unseen. `no-commit-in-window` when the hook was
       * there and React did not commit: a page with no React in it, or an
       * interaction React ignored.
       */
      readonly reason: 'react-hook-absent' | 'no-commit-in-window';
    };

/**
 * Attributes the commits inside one interaction's window to the components
 * that rendered in them.
 *
 * A commit belongs to the interaction whose window contains its
 * `committedAtMs`, inclusive at both ends. Its sample window opens at
 * `commitWindowStart`. A frame is not required: the interaction's frames are
 * reported beside the answer, and an interaction with none is still
 * attributed from its commits.
 *
 * Returns `null` when no interaction has that label.
 */
export function attributeInteractionComponents(
  signals: CapturedSignals,
  label: string,
): InteractionComponents | null {
  const interaction = signals.interactions.find((candidate) => candidate.label === label);
  if (interaction === undefined) return null;

  const frames = framesOfInteraction(signals, label);
  const { commits } = signals.react;
  const profile = indexProfile(signals.profile);

  const attributed: CommitAttribution[] = [];
  const tallies: CommitTally[] = [];
  for (const [index, commit] of commits.entries()) {
    if (
      commit.committedAtMs < interaction.fromMs ||
      commit.committedAtMs > interaction.toMs
    ) {
      continue;
    }
    const sinceMs = commitWindowStart(interaction, commits[index - 1], commit);
    const { attribution, tally } = attributeInWindow(signals, profile, commit, sinceMs);
    attributed.push(attribution);
    tallies.push(tally);
  }

  const [first, ...rest] = attributed;
  if (first === undefined) {
    return {
      kind: 'no-commit',
      interaction,
      provenance: signals.provenance,
      frames,
      reason: signals.react.hookInstalled ? 'no-commit-in-window' : 'react-hook-absent',
    };
  }

  return {
    kind: 'attributed',
    interaction,
    provenance: signals.provenance,
    frames,
    commits: [first, ...rest],
    merged: mergeTallies(tallies),
  };
}

/**
 * Merges commits' tallies by component name, when they share a tier.
 *
 * The merged weight is the summed numerators over the summed denominators. At
 * the fiber tier that is a component's self time across the interaction as a
 * share of all the interaction's render time. At the profiler tier it is its
 * samples as a share of all the samples in the interaction's commit windows.
 * A name's subject is taken from the first commit that carried it.
 */
function mergeTallies(commits: readonly CommitTally[]): MergedComponents | null {
  const [first] = commits;
  if (first === undefined) return null;
  const tier = first.basis.tier;
  if (commits.some((commit) => commit.basis.tier !== tier)) return null;

  const merged = new Map<string, Tally>();
  let denominator = 0;
  for (const commit of commits) {
    denominator += commit.denominator;
    for (const tally of commit.tallies) {
      addToTally(
        merged,
        tally.name,
        () => tally.subject,
        tally.numerator,
        tally.evidence,
      );
    }
  }

  return { tier, causes: rankTallies(tier, [...merged.values()], denominator) };
}

/** One line of prose for a React-tier shortfall. */
export function describeShortfall(shortfall: ReactTierShortfall): string {
  switch (shortfall) {
    case 'fiber-timings-absent':
      return 'fiber actualDuration is null, which is what a production build reports, so no self time can be computed';
    case 'fiber-linkage-unrecorded':
      return 'the capture did not record how the fibers nest or which of them rendered, so subtree time cannot be turned into self time';
  }
}

/**
 * One line of prose naming what a commit's attribution was working from, and,
 * when it degraded, from what and why. Meant to sit beside the ranked causes
 * in a report, so that a degraded answer can never be read as a full one.
 */
export function describeCommitBasis(basis: CommitAttributionBasis): string {
  switch (basis.tier) {
    case 'react-fiber-timings':
      return describeTier(basis.tier);
    case 'profiler-unmapped':
      return (
        `${describeTier(basis.tier)}, joined by name to the components React's DevTools ` +
        `hook reported; degraded from ${describeTier('react-fiber-timings')} because ` +
        `${describeShortfall(basis.shortfall)}. This tier does not resolve a source map ` +
        'even where the bundle ships one, so positions are in generated code too. ' +
        `${String(basis.unchargedSamples)} of the ${String(basis.samplesInWindow)} stacked ` +
        "samples in the commit's window were charged to no component"
      );
    case 'unattributed':
      return (
        `${describeTier(basis.tier)}: React's DevTools hook named the components that ` +
        `rendered, but ${describeShortfall(basis.shortfall)} and no profile was captured`
      );
  }
}

/**
 * One line of prose for a component-attribution note. `provenance` is the
 * capture's, and qualifies any millisecond figure the line quotes.
 */
export function describeComponentNote(
  note: ComponentAttributionNote,
  provenance: CaptureProvenance,
): string {
  switch (note.kind) {
    case 'negative-self-time':
      return `${note.componentName} (fiber ${String(note.fiberId)}) has children summing to ${formatMilliseconds(note.byMs, provenance)} more than its own subtree time; its self time is reported as negative, not clamped`;
    case 'walk-truncated':
      return "the collector's walk hit its fiber cap, so some ancestors' self times include fibers the record does not show";
    case 'ambiguous-minified-name':
      return `${note.componentName} names ${String(note.definitionSites)} different functions in the profile, so none of its samples were charged to it`;
    case 'no-samples-in-window':
      return "no profiler sample with a stack fell inside the commit's window, so the rendered components carry no weight";
  }
}
