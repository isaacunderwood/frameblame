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
 * is charged to no component.
 *
 * ## The remainder is a candidate
 *
 * Whatever a commit's components do not account for is in the ranking as an
 * explicit `unattributed` candidate with its own reason, so the weights sum to
 * 1 and the shortfall is never something a reader has to compute. At the fiber
 * tier it is the bailed-out fibers' self time, measured like the rest. At the
 * profiler tier it is the stacked samples that reached no rendered component.
 * With neither timings nor a profile it is the whole commit: the hook named
 * the components that rendered, they are listed as that candidate's evidence,
 * and no share is invented for any of them. This is the same decision the
 * frame partition makes about time outside every script, made for a commit.
 *
 * ## Confidence
 *
 * A fiber self time is a measurement, so its weight is `high` and exact to
 * the timing grid. A sample share is an estimate over the independent samples
 * in the commit's window, bursts collapsed (`independentSampleWeights`), and
 * its weight says how many there were. 2 to 15 stacked samples fall in a
 * `spans` production commit's window (4x), so those weights are `low` and say
 * so; merged over a replay's commits they are not.
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
 * Where the bundle ships a source map, each charged component's definition
 * site is resolved through it (`source-map.ts`), and the map's `names` array
 * gives the component its real name back: `h` is `OrderTable` at
 * `OrderTable.tsx:32:16` in `derive-in-render`, and all six minified names in
 * `spans` come back as the components the ground truth declares (production,
 * 4x). The commit is then `profiler-mapped`. The join itself still runs on
 * the minified identifier, because that is the one thing the hook and the
 * profiler share. Without a usable map the commit is `profiler-unmapped`, and
 * the names are reported as minified and the positions as generated code,
 * with the reason on each position.
 *
 * ## What this module does not do
 *
 * It does not split a frame among causes or weigh a commit against the frame
 * it landed in (`frame-attribution.ts` does), or decide whether an interaction
 * was slow, and it does not do the self-time subtraction itself. It answers
 * one question, which components rendered and their share of the render, and
 * states which tier the answer came from and how far each share can be
 * trusted.
 *
 * **Clock.** Every `…Ms` timestamp is page-clock `performance.now()`
 * milliseconds; every `…Ms` duration is milliseconds of the same clock.
 */

import {
  ATTRIBUTION_TIERS,
  type AttributionTier,
  type CandidateCause,
  type CauseEvidence,
  type CauseSubject,
  confidenceWeight,
  describeTier,
  type NonEmptyEvidence,
  type RankedCauses,
  rankCauses,
  type UnattributedReason,
  type WeightBasis,
} from './attribution.ts';
import { measuredSupport, sampleShareSupport, type WeightSupport } from './confidence.ts';
import {
  type CommitRenderTimes,
  type CommitTimingNote,
  commitRenderTimes,
  didRender,
  type FiberParticipation,
  type FiberSelfTime,
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
  independentSampleWeights,
  type ProfileTrace,
  type SampleCounts,
  stackFrames,
} from './profiler.ts';
import { type CaptureProvenance, formatMilliseconds } from './provenance.ts';
import type { FiberId, ReactCommit, ReactSpan } from './react.ts';
import {
  type CapturedSignals,
  framesOfInteraction,
  type InteractionWindow,
} from './signals.ts';
import {
  definitionSite,
  type FrameResolution,
  generatedSiteKey,
  resolveProfile,
  type ResolvedProfile,
} from './source-map.ts';

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
       * of, which is charged to no component. Its positive part is the
       * ranking's `unattributed` candidate, with reason
       * `bailed-out-reconciliation`, and equals `bailedOutSelfMs` unless a
       * bailed-out fiber's self time went negative, which a
       * `negative-self-time` note reports.
       */
      readonly times: CommitRenderTimes;
    }
  | {
      /**
       * Sample shares, with component identity from the hook's names, joined
       * to the profiler's frames by the minified identifier both report.
       * `profiler-mapped` when every candidate's definition site resolved
       * through a source map, and so has its real name back;
       * `profiler-unmapped` when any did not, or there is no candidate.
       */
      readonly tier: 'profiler-mapped' | 'profiler-unmapped';
      readonly shortfall: ReactTierShortfall;
      /**
       * Samples with a stack inside the window, as the trace holds them. The
       * weights' denominator is this count with bursts collapsed, which each
       * weight's confidence carries.
       */
      readonly samplesInWindow: number;
      /**
       * Of those, the samples charged to no component: the ranking's
       * `unattributed` candidate, with reason
       * `no-rendered-component-on-stack`. Mostly stacks that reach no
       * rendered component's frame: React's own reconciliation and commit
       * work, or whatever ran in the window before the render began. Also any
       * whose innermost match was a name the `ambiguous-minified-name` note
       * reports.
       */
      readonly unchargedSamples: number;
    }
  | {
      /**
       * The hook named the components, and nothing measured their cost. The
       * ranking is one `unattributed` candidate holding the whole commit,
       * with the components that rendered as its evidence.
       */
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
   * of the commit, then whatever they do not account for as one
   * `unattributed` candidate. Several fibers sharing a name, such as a list's
   * rows, are one candidate with one evidence entry per fiber.
   */
  readonly causes: RankedCauses;
  readonly notes: readonly ComponentAttributionNote[];
}

/** One candidate's raw share before it becomes a weight, so commits can be merged. */
interface Tally {
  /** The hook's name, which the join and the merge key on. */
  readonly name: string;
  readonly subject: CauseSubject;
  /** The tier this candidate stands on. Shared by a commit's fiber tallies. */
  readonly tier: AttributionTier;
  numerator: number;
  /** Created with its first entry, so a candidate can never lack evidence. */
  readonly evidence: NonEmptyEvidence;
}

/**
 * The part of a commit no component is charged with, in the same unit as the
 * commit's tallies, so that it merges across commits the way they do.
 */
interface Remainder {
  readonly reason: UnattributedReason;
  numerator: number;
  readonly evidence: NonEmptyEvidence;
}

/**
 * What a commit's numerators and denominator are counted in, which decides
 * both what can be added together and what a weight's confidence rests on.
 *
 * - `fiber-self-time` — milliseconds of fiber self time. Measured.
 * - `independent-samples` — samples in the commit's window, bursts collapsed.
 *   An estimate.
 * - `whole-commit` — one, for a commit nothing measured: the remainder is the
 *   commit, and it is what is left by subtraction with no second signal.
 */
type ShareUnit = 'fiber-self-time' | 'independent-samples' | 'whole-commit';

/** A commit's tallies, with the denominator they are shares of. */
interface CommitTally {
  readonly basis: CommitAttributionBasis;
  readonly unit: ShareUnit;
  readonly components: readonly CommitComponent[];
  readonly tallies: readonly Tally[];
  /** `null` when the components account for everything. */
  readonly remainder: Remainder | null;
  readonly denominator: number;
  readonly notes: readonly ComponentAttributionNote[];
}

/** The weight basis each unit's shares are quoted under. */
function weightBasisOf(unit: ShareUnit): WeightBasis {
  return unit === 'independent-samples' ? 'sample-share' : 'fiber-self-time-share';
}

/**
 * The support behind a share of `numerator` in `denominator`, both in `unit`.
 *
 * Fiber self time is exact to the timing grid, which as a share is two
 * coarsening steps over the denominator's milliseconds; with no denominator
 * nothing is distinguishable, and the grid is the whole. A sample share
 * carries its independent counts. A commit nothing measured is a subtraction
 * that no profile was there to check.
 */
function supportOf(
  unit: ShareUnit,
  numerator: number,
  denominator: number,
): WeightSupport {
  switch (unit) {
    case 'fiber-self-time':
      return measuredSupport(denominator);
    case 'independent-samples':
      return sampleShareSupport(numerator, denominator);
    case 'whole-commit':
      return {
        kind: 'subtraction',
        check: { verdict: 'unchecked', reason: 'no-profiler' },
      };
  }
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
 * the subject and tier `subject()` returns the first time the name is seen.
 */
function addToTally(
  tallies: Map<string, Tally>,
  name: string,
  subject: () => { readonly subject: CauseSubject; readonly tier: AttributionTier },
  numerator: number,
  evidence: Readonly<NonEmptyEvidence>,
): void {
  const existing = tallies.get(name);
  if (existing === undefined) {
    tallies.set(name, { name, ...subject(), numerator, evidence: [...evidence] });
    return;
  }
  existing.numerator += numerator;
  existing.evidence.push(...evidence);
}

/**
 * Adds `numerator` and `evidence` to a remainder, or starts one with `reason`
 * when there is none yet. Never mutates the evidence it is handed, so a
 * commit's own remainder survives being merged into an interaction's.
 */
function addToRemainder(
  remainder: Remainder | null,
  reason: UnattributedReason,
  numerator: number,
  evidence: Readonly<NonEmptyEvidence>,
): Remainder {
  if (remainder === null) return { reason, numerator, evidence: [...evidence] };
  remainder.numerator += numerator;
  remainder.evidence.push(...evidence);
  return remainder;
}

/** A fiber's timings as evidence, rendered or bailed out of. */
function fiberRenderTimeEvidence(entry: FiberSelfTime): CauseEvidence {
  return {
    kind: 'fiber-render-time',
    componentName: entry.fiber.name,
    actualDurationMs: entry.actualDurationMs,
    selfDurationMs: entry.selfMs,
  };
}

/**
 * The `fiber-rendered` evidence for every component the hook says rendered:
 * which components took part, with nothing about how long they took. Empty
 * where the record does not say which fibers rendered.
 */
export function renderedEvidence(
  components: readonly CommitComponent[],
): CauseEvidence[] {
  return components.flatMap((component): CauseEvidence[] =>
    component.participation !== 'not-recorded' && didRender(component.participation)
      ? [
          {
            kind: 'fiber-rendered',
            componentName: component.name,
            participation: component.participation,
          },
        ]
      : [],
  );
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
): { tallies: Tally[]; remainder: Remainder | null; denominator: number } {
  const tallies = new Map<string, Tally>();
  const denominator = times.fibers.reduce(
    (sum, entry) => sum + Math.max(entry.selfMs, 0),
    0,
  );

  /*
   * The remainder: the positive self time of fibers React bailed out of,
   * which is its reconciliation beneath components that did not render. Each
   * such fiber is a piece of evidence, with the same timings a rendered one
   * carries. 0ms on every timed corpus commit (development, 4x), so the
   * candidate is absent there.
   */
  let remainder: Remainder | null = null;
  for (const entry of times.fibers) {
    if (didRender(entry.participation) || entry.selfMs <= 0) continue;
    remainder = addToRemainder(remainder, 'bailed-out-reconciliation', entry.selfMs, [
      fiberRenderTimeEvidence(entry),
    ]);
  }

  for (const entry of times.fibers) {
    if (!didRender(entry.participation)) continue;
    addToTally(
      tallies,
      entry.fiber.name,
      () => ({
        subject: {
          kind: 'component',
          name: entry.fiber.name,
          nameIsMinified: false,
          definedAt: null,
        },
        tier: 'react-fiber-timings',
      }),
      Math.max(entry.selfMs, 0),
      [fiberRenderTimeEvidence(entry)],
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

  return { tallies: [...tallies.values()], remainder, denominator };
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
 * samples charged to it. Nothing in an unmapped profile can rule that out. A
 * source map could, by checking that the one site resolves to a function the
 * hook's component could be; the join does not do that yet, and on a mapped
 * profile it only renames the candidate after the fact.
 *
 * In the corpus every name the hook reported has exactly one site in its
 * capture's profile: `h` and `re` in `derive-in-render`, and `b`, `m`, `h`,
 * `g`, `v` and `_` in `spans` (production, 4x).
 */
type DefinitionSites = ReadonlyMap<string, readonly number[]>;

/**
 * Indexes a profile's frames by name and definition site, as the index into
 * `profile.frames` of the first frame seen at each site. See
 * `DefinitionSites`.
 */
function definitionSitesOf(profile: ProfileTrace): DefinitionSites {
  const byName = new Map<string, Map<string, number>>();
  for (const [frameId, frame] of profile.frames.entries()) {
    if (frame.name === null) continue;
    const sites = byName.get(frame.name) ?? new Map<string, number>();
    const key = generatedSiteKey(frame);
    if (!sites.has(key)) sites.set(key, frameId);
    byName.set(frame.name, sites);
  }
  return new Map([...byName].map(([name, sites]) => [name, [...sites.values()]]));
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
  /**
   * The profile's frames resolved through its source maps, computed on first
   * use. Lazy because only the profiler tier reads it: a development commit
   * with fiber timings never needs React's 1.7MB development map (for a 3.1MB
   * served script) decoded.
   */
  readonly resolved: () => ResolvedProfile;
  /**
   * How much independent evidence each sample is, one weight per sample,
   * computed on first use. See `independentSampleWeights`.
   */
  readonly independence: () => readonly number[];
}

/**
 * The capture's profile with its name index, or `null` when there was no
 * profiler. `alreadyResolved` is the same profile's resolution where a caller
 * holds one, so that the maps are decoded once per capture.
 */
function indexProfile(
  profile: ProfileTrace | null,
  alreadyResolved?: ResolvedProfile,
): IndexedProfile | null {
  if (profile === null) return null;
  let resolved = alreadyResolved;
  let independence: readonly number[] | undefined;
  return {
    profile,
    sites: definitionSitesOf(profile),
    resolved: () => (resolved ??= resolveProfile(profile)),
    independence: () => (independence ??= independentSampleWeights(profile)),
  };
}

/**
 * A commit's tier at the profiler: whether its components came back through a
 * source map.
 *
 * Returns `profiler-mapped` when every rendered name with a single definition
 * site in the profile resolved through a source map, and at least one did,
 * and `profiler-unmapped` otherwise. It is decided from the sites rather than
 * from the window's samples, so that a commit whose window happened to catch
 * no sample stands at the same tier as its neighbours. A name never sampled
 * anywhere has no site and decides nothing; an ambiguous name keeps the
 * commit unmapped, because its candidate cannot be resolved.
 */
function commitProfilerTier(
  renderedNames: Iterable<string>,
  sites: DefinitionSites,
  resolved: () => ResolvedProfile,
): 'profiler-mapped' | 'profiler-unmapped' {
  const sampledNames = [...renderedNames]
    .map((name) => sites.get(name) ?? [])
    .filter((nameSites) => nameSites.length > 0);
  const allMapped =
    sampledNames.length > 0 &&
    sampledNames.every(
      ([site, ...others]) =>
        others.length === 0 &&
        site !== undefined &&
        resolved().frames[site]?.kind === 'mapped',
    );
  return allMapped ? 'profiler-mapped' : 'profiler-unmapped';
}

/**
 * A sampled component's subject, and the tier it stands on, from its one
 * definition site's resolution, or `undefined` when it has no single site.
 *
 * The name is the map's name for the identifier at the definition site, where
 * there is one. For a function declaration that is the function's own name,
 * which is how `h` becomes `OrderTable`. Without it the hook's name stands,
 * minified in production, and the position stays generated with the reason
 * the map did not apply. `nameIsMinified` is whether the hook's name is.
 */
function sampledComponentSubject(
  hookName: string,
  resolution: FrameResolution | undefined,
  nameIsMinified: boolean,
): { readonly subject: CauseSubject; readonly tier: AttributionTier } {
  const mapped = resolution?.kind === 'mapped' ? resolution : null;
  const realName = mapped?.originalName ?? null;
  return {
    subject: {
      kind: 'component',
      name: realName ?? hookName,
      nameIsMinified: realName === null && nameIsMinified,
      definedAt: resolution === undefined ? null : definitionSite(resolution),
    },
    tier: mapped === null ? 'profiler-unmapped' : 'profiler-mapped',
  };
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
 *
 * The commit's tier is `commitProfilerTier`'s, and each candidate's is
 * `sampledComponentSubject`'s.
 *
 * Numerators and the denominator are independent samples, bursts collapsed,
 * so that a burst in the window is one observation of whatever it caught. The
 * raw counts are kept beside them, for the evidence and the basis. The
 * remainder is the stacked samples charged to no component.
 */
function tallySamples(
  components: readonly CommitComponent[],
  { profile, sites, resolved, independence }: IndexedProfile,
  window: CommitSampleWindow,
  provenance: CaptureProvenance,
): {
  tier: 'profiler-mapped' | 'profiler-unmapped';
  tallies: Tally[];
  remainder: Remainder | null;
  /** Independent stacked samples in the window: the weights' denominator. */
  denominator: number;
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

  const counts = new Map<string, SampleCounts>();
  const inWindow: SampleCounts = { samples: 0, independent: 0 };
  const weights = independence();
  for (const [index, sample] of profile.samples.entries()) {
    if (sample.stackId === null) continue;
    if (sample.atMs <= window.fromMs || sample.atMs > window.toMs) continue;
    // One weight per sample, by `independentSampleWeights`' contract.
    const independent = weights[index] ?? 1;
    inWindow.samples += 1;
    inWindow.independent += independent;

    const match = stackFrames(profile, sample.stackId).find(
      (frame) => frame.name !== null && fibersByName.has(frame.name),
    );
    if (match?.name == null) continue;
    const count = counts.get(match.name) ?? { samples: 0, independent: 0 };
    count.samples += 1;
    count.independent += independent;
    counts.set(match.name, count);
  }
  const samplesInWindow = inWindow.samples;

  const tier = commitProfilerTier(fibersByName.keys(), sites, resolved);

  // Reported rather than divided by: with nothing in the window, every
  // rendered component would otherwise carry a weight of 0 of 0.
  if (samplesInWindow === 0 && fibersByName.size > 0) {
    return {
      tier,
      tallies: [],
      remainder: null,
      denominator: 0,
      samplesInWindow,
      unchargedSamples: 0,
      notes: [{ kind: 'no-samples-in-window' }],
    };
  }

  const notes: ComponentAttributionNote[] = [];
  const tallies: Tally[] = [];
  const nameIsMinified = provenance.buildMode === 'production';
  const charged: SampleCounts = { samples: 0, independent: 0 };

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

    const count = ambiguous ? undefined : counts.get(name);
    const samples = count?.samples ?? 0;
    charged.samples += samples;
    charged.independent += count?.independent ?? 0;

    const resolution =
      !ambiguous && site !== undefined ? resolved().frames[site] : undefined;
    tallies.push({
      name,
      ...sampledComponentSubject(name, resolution, nameIsMinified),
      numerator: count?.independent ?? 0,
      evidence: [
        {
          kind: 'profiler-samples',
          samples,
          ofSamplesInWindow: samplesInWindow,
          window: 'since-previous-commit',
        },
        ...renderedEvidence(fibers),
      ],
    });
  }

  const unchargedSamples = samplesInWindow - charged.samples;
  return {
    tier,
    tallies,
    remainder:
      unchargedSamples === 0
        ? null
        : {
            reason: 'no-rendered-component-on-stack',
            // Floored at 0: the two sums add the same weights in different
            // orders, so they can differ by a float hair.
            numerator: Math.max(inWindow.independent - charged.independent, 0),
            evidence: [
              {
                kind: 'profiler-samples',
                samples: unchargedSamples,
                ofSamplesInWindow: samplesInWindow,
                window: 'since-previous-commit',
              },
            ],
          },
    denominator: inWindow.independent,
    samplesInWindow,
    unchargedSamples,
    notes,
  };
}

/**
 * The remainder of a commit nothing measured: all of it. The components the
 * hook saw render are its evidence, so they are named without any of them
 * being given a share. `null` when the record does not say which fibers
 * rendered, since a candidate needs evidence.
 */
function unmeasuredRemainder(components: readonly CommitComponent[]): Remainder | null {
  const [first, ...rest] = renderedEvidence(components);
  if (first === undefined) return null;
  return { reason: 'no-profiler', numerator: 1, evidence: [first, ...rest] };
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
    const { tallies, remainder, denominator } = tallyFiberTimings(
      times,
      signals.react.spans,
      window,
    );
    return {
      basis: { tier: 'react-fiber-timings', times },
      unit: 'fiber-self-time',
      components,
      tallies,
      remainder,
      denominator,
      notes: times.notes,
    };
  }

  if (profile === null) {
    const remainder = unmeasuredRemainder(components);
    return {
      basis: { tier: 'unattributed', shortfall: timing.shortfall, reason: 'no-profiler' },
      unit: 'whole-commit',
      components,
      tallies: [],
      remainder,
      // One commit, all of it the remainder; nothing to divide when the
      // record names no rendered fiber to stand as its evidence.
      denominator: remainder === null ? 0 : 1,
      notes: [],
    };
  }

  const sampled = tallySamples(components, profile, window, signals.provenance);
  return {
    basis: {
      tier: sampled.tier,
      shortfall: timing.shortfall,
      samplesInWindow: sampled.samplesInWindow,
      unchargedSamples: sampled.unchargedSamples,
    },
    unit: 'independent-samples',
    components,
    tallies: sampled.tallies,
    remainder: sampled.remainder,
    denominator: sampled.denominator,
    notes: sampled.notes,
  };
}

/**
 * Turns tallies into ranked causes, each at its own tally's tier, followed by
 * the remainder as an `unattributed` candidate where there is one.
 *
 * `unit` is what the numerators and `denominator` are counted in, and decides
 * each weight's basis and support. A zero denominator gives every candidate a
 * zero weight rather than a division: a commit whose components all rendered
 * in 0ms on the 100us grid still names them, at no weight. A remainder of
 * nothing is omitted, like any zero-width slice.
 */
function rankTallies(
  tallies: readonly Tally[],
  remainder: Remainder | null,
  denominator: number,
  unit: ShareUnit,
): RankedCauses {
  const weightOf = (numerator: number) =>
    confidenceWeight(
      denominator > 0 ? numerator / denominator : 0,
      weightBasisOf(unit),
      supportOf(unit, denominator > 0 ? numerator : 0, denominator),
    );

  const candidates = tallies.map((tally): CandidateCause => ({
    subject: tally.subject,
    weight: weightOf(tally.numerator),
    tier: tally.tier,
    evidence: tally.evidence,
  }));
  if (remainder !== null && remainder.numerator > 0) {
    candidates.push({
      subject: { kind: 'unattributed', reason: remainder.reason },
      weight: weightOf(remainder.numerator),
      tier: 'unattributed',
      evidence: remainder.evidence,
    });
  }
  return rankCauses(candidates);
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
 * the record carries links and timings, else `profiler-mapped` or
 * `profiler-unmapped` when a profile exists, by whether the rendered
 * components' definition sites resolved through a source map, else
 * `unattributed`, with the shortfall named in every
 * degraded case. Weights are shares of this commit, not of any frame, and
 * sum to 1: what the components do not account for is an explicit
 * `unattributed` candidate. Assumes `commit` is one of
 * `signals.react.commits`, though only its own fields are read. `resolved`
 * is `resolveProfile(signals.profile)` where the caller already holds it.
 */
export function attributeCommit(
  signals: CapturedSignals,
  commit: ReactCommit,
  sinceMs: number,
  resolved?: ResolvedProfile,
): CommitAttribution {
  return attributeInWindow(
    signals,
    indexProfile(signals.profile, resolved),
    commit,
    sinceMs,
  ).attribution;
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
      causes: rankTallies(tally.tallies, tally.remainder, tally.denominator, tally.unit),
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
 * An interaction's candidates merged across its commits, at the least-mapped
 * tier among them. See `mergeTallies` for which tiers merge.
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
   * summed denominators, or `null` when its commits' shares are of different
   * quantities. A fiber-time share and a sample share are not the same
   * quantity, so they are not added together; a mapped and an unmapped
   * sample share are, at the weaker of the two tiers. The per-commit answers
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
 * Returns `null` when no interaction has that label. `resolved` is
 * `resolveProfile(signals.profile)` where the caller already holds it.
 */
export function attributeInteractionComponents(
  signals: CapturedSignals,
  label: string,
  resolved?: ResolvedProfile,
): InteractionComponents | null {
  const interaction = signals.interactions.find((candidate) => candidate.label === label);
  if (interaction === undefined) return null;

  const frames = framesOfInteraction(signals, label);
  const { commits } = signals.react;
  const profile = indexProfile(signals.profile, resolved);

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
 * The least-mapped of a non-empty list of tiers, by `ATTRIBUTION_TIERS`'s
 * strongest-first order, so that a merge never claims more than its weakest
 * commit stood on.
 */
function weakestTier<Tier extends AttributionTier>(
  tiers: readonly [Tier, ...Tier[]],
): Tier {
  return tiers.reduce((weakest, tier) =>
    ATTRIBUTION_TIERS.indexOf(tier) > ATTRIBUTION_TIERS.indexOf(weakest) ? tier : weakest,
  );
}

/**
 * Merges commits' tallies by component name, when their tiers share a weight
 * basis, and returns `null` when they do not.
 *
 * The merged weight is the summed numerators over the summed denominators. At
 * the fiber tier that is a component's self time across the interaction as a
 * share of all the interaction's render time. At the profiler tier it is its
 * samples as a share of all the samples in the interaction's commit windows.
 * `profiler-mapped` and `profiler-unmapped` commits merge, because both are
 * sample shares and a map changes a candidate's name, not its count; the
 * merge takes the least-mapped tier among them, and each candidate keeps its
 * own. A fiber-time share and a sample share are different quantities and do
 * not merge. A name's subject is taken from the first commit that carried it.
 *
 * The commits' remainders merge the same way, into one `unattributed`
 * candidate: summed numerators over the same summed denominator. Commits
 * that share a unit share a remainder's reason, so there is one to carry.
 * Merged commits nothing measured are a count of commits, every one of them
 * unattributed.
 */
function mergeTallies(commits: readonly CommitTally[]): MergedComponents | null {
  const [first, ...rest] = commits;
  if (first === undefined) return null;
  const { unit } = first;
  if (rest.some((commit) => commit.unit !== unit)) return null;
  const tier = weakestTier([
    first.basis.tier,
    ...rest.map((commit) => commit.basis.tier),
  ]);

  const merged = new Map<string, Tally>();
  let remainder: Remainder | null = null;
  let denominator = 0;
  for (const commit of commits) {
    denominator += commit.denominator;
    for (const tally of commit.tallies) {
      addToTally(
        merged,
        tally.name,
        () => ({ subject: tally.subject, tier: tally.tier }),
        tally.numerator,
        tally.evidence,
      );
    }
    if (commit.remainder === null) continue;
    const { reason, numerator, evidence } = commit.remainder;
    remainder = addToRemainder(remainder, reason, numerator, evidence);
  }

  return {
    tier,
    causes: rankTallies([...merged.values()], remainder, denominator, unit),
  };
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
    case 'profiler-mapped':
    case 'profiler-unmapped':
      return (
        `${describeTier(basis.tier)}, joined by name to the components React's DevTools ` +
        `hook reported; degraded from ${describeTier('react-fiber-timings')} because ` +
        `${describeShortfall(basis.shortfall)}. ` +
        (basis.tier === 'profiler-mapped'
          ? 'Definition sites come from the source map, and names too where the map carries ' +
            'one; a candidate still marked minified did not get its name back. '
          : 'Names are as the hook reported them, minified in a production build, and ' +
            'positions are in generated code where any are given. ') +
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
