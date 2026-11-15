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
 * A fiber's `actualDuration` is its subtree's render time. Self time is
 * `actualDuration - sum(children's actualDuration)`, which is what React
 * itself computes (`react-dom-client.development.js:4421`, 19.3.1). The
 * children are the fibers whose `parentId` names this one, and the
 * subtraction runs only over fibers that took part in the commit. The two
 * cases the collector's render evidence separates decide which those are (see
 * `FiberRenderEvidence` in `react.ts`):
 *
 * - A **carried-over** fiber is a previous commit's object that React never
 *   reached, holding a previous render's `actualDuration`. React leaves it out
 *   of its parent's `actualDuration` (`bubbleProperties`, :12823-12842), so it
 *   must be left out of the subtraction too, or the parent's self time goes
 *   negative by the stale figure. It is also no candidate: it did not render.
 * - A **bailed-out** fiber was cloned for this render and its function was not
 *   called. It is in the commit and its `actualDuration` is this commit's: it
 *   is reset to zero when React clones it, then accumulates its in-commit
 *   children's. So it is subtracted from its parent like any other in-commit
 *   child, and is not a candidate. `App` in `state-owner-self` is the case: it
 *   reads 25.2ms with `PerformedWork` clear (development, 4x), and all of that
 *   is `StateOwner`'s.
 *
 * Summed over every in-commit fiber the self times telescope to the commit's
 * own total, which is the `actualDuration` of its top-level fibers. That
 * total is the denominator. Adding up every fiber's `actualDuration` instead
 * counts each component once per ancestor: `spans`' `mount-toggle` commit
 * would come to 277.2ms against its real 151.2ms (development, 4x).
 *
 * The bailed-out fibers' self time is real time and is not dropped. It is
 * React reconciling the host elements beneath a component that did not
 * re-render. It is charged to no component, and it is what makes a commit's
 * ranked weights sum to less than 1. It is 0ms on all 29 timed commits in the corpus
 * (development, 4x), across the 4 bailed-out fibers they hold.
 *
 * ## When the React tier is unavailable
 *
 * A production build still calls the hook on every commit, and still sets
 * `PerformedWork`, so *which* components rendered is still known. But
 * `actualDuration` is null and the names are minified: `b`, `m`, `h`, `g`, `v`
 * in `spans`. An answer of "nothing" would be a lie of omission, so the commit
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
 * slow. It answers one question, which components rendered and their share of
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
import type { CaptureProvenance } from './provenance.ts';
import type { FiberId, LinkedFiber, ReactCommit, ReactSpan } from './react.ts';
import {
  type CapturedSignals,
  framesOfInteraction,
  type InteractionWindow,
} from './signals.ts';

/**
 * How one recorded fiber took part in its commit.
 *
 * - `mounted` — no alternate: the fiber was created in this commit, and a
 *   mount always runs the render function.
 * - `updated` — cloned, and its render function ran (`PerformedWork` set).
 * - `bailed-out` — cloned, and React skipped it. In the commit; did not render.
 * - `carried-over` — a previous commit's object React never reached. Not in
 *   the commit at all.
 */
export type FiberParticipation = 'mounted' | 'updated' | 'bailed-out' | 'carried-over';

/** The participations in which a component's render function ran. */
export type RenderedParticipation = 'mounted' | 'updated';

/** `PerformedWork`, bit 0 of a fiber's `flags`. See `FiberRenderEvidence`. */
const PERFORMED_WORK = 1;

/**
 * Whether a fiber rendered, decided as React DevTools decides it.
 *
 * DevTools' `recordProfilingDurations` counts a fiber when it has no previous
 * fiber (a mount), or when it is not the previous fiber itself (not carried
 * over) and `didFiberRender` holds, which for function, class, forwardRef,
 * memo and context consumer fibers is the `PerformedWork` bit. The order of
 * the tests matters and follows from that. `carriedOver` comes first because
 * a fiber that mounted in an earlier commit and was carried over into this
 * one still has no alternate. It is the earlier commit's object, never
 * cloned, so testing `hasAlternate` first would report it as mounting again.
 *
 * The props-and-state comparison DevTools falls back on for other fiber kinds
 * cannot be made from the record, which carries neither. Every fiber in the
 * corpus is a function component, so the bit is the whole test there.
 *
 * Assumes nothing about ancestors: a fiber's own `carriedOver` is what this
 * reads. `participationsOf` applies inheritance.
 */
export function fiberParticipation(fiber: LinkedFiber): FiberParticipation {
  if (fiber.render.carriedOver) return 'carried-over';
  if (!fiber.render.hasAlternate) return 'mounted';
  return (fiber.render.flags & PERFORMED_WORK) !== 0 ? 'updated' : 'bailed-out';
}

/** Whether a participation means the component's render function ran. */
export function didRender(
  participation: FiberParticipation,
): participation is RenderedParticipation {
  return participation === 'mounted' || participation === 'updated';
}

/**
 * Each fiber's participation, keyed by id, with carried-over inherited by
 * every descendant.
 *
 * The collector already propagates `carriedOver` down the tree: a fiber
 * beneath a carried-over one is itself a previous commit's object. This pass
 * re-derives that from the links rather than trusting it. A record in which a
 * carried-over parent had an in-commit child would otherwise make that child a
 * top-level fiber, and count its stale subtree into the commit's total.
 *
 * Throws on a `parentId` that names no fiber in the commit. The corpus reader
 * refuses those, so reaching this means a record no collector writes.
 */
function participationsOf(
  fibers: readonly LinkedFiber[],
): Map<FiberId, FiberParticipation> {
  const byId = new Map<FiberId, FiberParticipation>();
  // Walk order visits a parent before its children, and `parentId` is always
  // lower than `id` (both checked by the corpus reader), so one pass suffices.
  for (const fiber of fibers) {
    const own = fiberParticipation(fiber);
    if (fiber.parentId === null) {
      byId.set(fiber.id, own);
      continue;
    }
    const parent = byId.get(fiber.parentId);
    if (parent === undefined) {
      throw new Error(
        `fiber ${String(fiber.id)} (${fiber.name}) names parent ${String(fiber.parentId)}, ` +
          'which is not an earlier fiber in its commit',
      );
    }
    byId.set(fiber.id, parent === 'carried-over' ? 'carried-over' : own);
  }
  return byId;
}

/** One in-commit fiber's share of the render. */
export interface FiberSelfTime {
  readonly fiber: LinkedFiber;
  /** Never `carried-over`: those are not in the commit. */
  readonly participation: Exclude<FiberParticipation, 'carried-over'>;
  /** The subtree time React reported. */
  readonly actualDurationMs: number;
  /** The sum of the in-commit children's `actualDurationMs`. */
  readonly childrenMs: number;
  /**
   * `actualDurationMs - childrenMs`, signed. Never clamped. A value below zero
   * by more than the timing grid is reported as a note, because it means the
   * subtraction removed time the parent did not contain.
   */
  readonly selfMs: number;
}

/** Something about a commit's fiber timings that a report must say. */
export type CommitTimingNote =
  | {
      /**
       * A fiber's in-commit children add up to more than the fiber's own
       * subtree time, by more than the 100us timing grid explains (see
       * `COARSENED_TIMING_TOLERANCE_MS`).
       *
       * React builds a parent's `actualDuration` by adding its children's to
       * its own measured time, so this cannot happen in a consistent record.
       * The likely causes are a carried-over child the record failed to flag,
       * or a walk that linked a fiber to the wrong ancestor. Surfaced rather
       * than clamped, because a clamped zero would quietly hand the excess to
       * the children's weights.
       */
      readonly kind: 'negative-self-time';
      readonly fiberId: FiberId;
      readonly componentName: string;
      /** How far below zero, in milliseconds. Positive. */
      readonly byMs: number;
    }
  | {
      /**
       * The collector's walk hit its fiber cap, so some fibers are missing and
       * every ancestor of a missing one has its self time overstated by the
       * missing subtree. Nothing in the record says which ancestors.
       */
      readonly kind: 'walk-truncated';
    };

/** A commit's fiber timings, turned into self times. */
export interface CommitRenderTimes {
  /**
   * The commit's own render total: the summed `actualDurationMs` of its
   * top-level in-commit fibers. In milliseconds.
   */
  readonly totalMs: number;
  /** Every in-commit fiber, in walk order. Carried-over fibers are absent. */
  readonly fibers: readonly FiberSelfTime[];
  /** Summed `selfMs` of the fibers whose render function ran. */
  readonly renderedSelfMs: number;
  /**
   * Summed `selfMs` of the fibers React bailed out of: its reconciliation of
   * the host elements beneath components that did not re-render. Charged to
   * no component. `renderedSelfMs + bailedOutSelfMs` equals `totalMs` up to
   * float error, because the self times telescope.
   */
  readonly bailedOutSelfMs: number;
  /** How many recorded fibers were carried over and skipped. */
  readonly carriedOverFibers: number;
  readonly notes: readonly CommitTimingNote[];
}

/**
 * Why a commit could not be attributed at the React tier.
 *
 * - `fiber-timings-absent` — some in-commit fiber has a null
 *   `actualDuration`. Every fiber in a production build does: React populates
 *   the field only in development and profiling builds.
 * - `fiber-linkage-unrecorded` — the capture predates the collector change
 *   that recorded parent links and render evidence, so subtree time cannot be
 *   turned into self time, and which fibers rendered is not known.
 */
export type ReactTierShortfall = 'fiber-timings-absent' | 'fiber-linkage-unrecorded';

/** A commit's self times, or why it has none. */
export type CommitRenderTiming =
  | { readonly kind: 'timed'; readonly times: CommitRenderTimes }
  | { readonly kind: 'untimed'; readonly shortfall: ReactTierShortfall };

/**
 * Turns a commit's subtree times into self times, over the fibers that took
 * part in the commit.
 *
 * Returns `untimed` when the record cannot support the subtraction: no links
 * were recorded, or any in-commit fiber's `actualDuration` is null. Partial
 * timings are refused rather than used, because a null child would make its
 * parent's self time absorb the child's whole subtree. Every duration is in
 * milliseconds of the page clock.
 *
 * Assumes the record's ids and parent links follow the collector's scheme
 * (`id` is the fiber's index, `parentId` is null or an earlier id), which the
 * corpus reader checks. Throws if a parent link names no earlier fiber.
 */
export function commitRenderTimes(commit: ReactCommit): CommitRenderTiming {
  const components = commit.components;
  if (components.linkage === 'unrecorded') {
    return { kind: 'untimed', shortfall: 'fiber-linkage-unrecorded' };
  }

  const participation = participationsOf(components.fibers);
  const inCommit: {
    fiber: LinkedFiber;
    participation: Exclude<FiberParticipation, 'carried-over'>;
    actualMs: number;
  }[] = [];
  let carriedOverFibers = 0;

  for (const fiber of components.fibers) {
    const own = participation.get(fiber.id);
    if (own === undefined || own === 'carried-over') {
      carriedOverFibers += 1;
      continue;
    }
    if (fiber.actualDurationMs === null) {
      return { kind: 'untimed', shortfall: 'fiber-timings-absent' };
    }
    inCommit.push({ fiber, participation: own, actualMs: fiber.actualDurationMs });
  }

  // Each in-commit fiber's time is subtracted from its parent's. A
  // carried-over fiber's parent never sees it, which is the point: React left
  // that stale figure out of the parent's `actualDuration`.
  const childrenMs = new Map<FiberId, number>();
  let totalMs = 0;
  for (const { fiber, actualMs } of inCommit) {
    if (fiber.parentId === null) {
      totalMs += actualMs;
    } else {
      childrenMs.set(fiber.parentId, (childrenMs.get(fiber.parentId) ?? 0) + actualMs);
    }
  }

  const notes: CommitTimingNote[] = [];
  if (components.truncated) notes.push({ kind: 'walk-truncated' });

  const fibers: FiberSelfTime[] = inCommit.map(
    ({ fiber, participation: own, actualMs }) => {
      const children = childrenMs.get(fiber.id) ?? 0;
      if (exceedsByMoreThanCoarsening(children, actualMs)) {
        notes.push({
          kind: 'negative-self-time',
          fiberId: fiber.id,
          componentName: fiber.name,
          byMs: children - actualMs,
        });
      }
      return {
        fiber,
        participation: own,
        actualDurationMs: actualMs,
        childrenMs: children,
        selfMs: actualMs - children,
      };
    },
  );

  const sumSelf = (rendered: boolean): number =>
    fibers
      .filter((entry) => didRender(entry.participation) === rendered)
      .reduce((sum, entry) => sum + entry.selfMs, 0);

  return {
    kind: 'timed',
    times: {
      totalMs,
      fibers,
      renderedSelfMs: sumSelf(true),
      bailedOutSelfMs: sumSelf(false),
      carriedOverFibers,
      notes,
    },
  };
}

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
  /** Exclusive. The previous commit, or the interaction's start. */
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
       * A rendered component's name matched profiler frames at more than one
       * definition site inside the window, so its samples were not charged to
       * it. Minified names are reused across scopes, and at least one of those
       * frames was some other function. The samples stay in the denominator,
       * so the commit's ranked weights fall short of 1 by their share.
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

/** One candidate's raw share before it becomes a weight, so commits can be merged. */
interface Tally {
  readonly name: string;
  readonly subject: CauseSubject;
  numerator: number;
  readonly evidence: CauseEvidence[];
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

function componentsOf(commit: ReactCommit): CommitComponent[] {
  const components = commit.components;
  if (components.linkage === 'unrecorded') {
    return components.fibers.map((fiber, fiberIndex) => ({
      fiberIndex,
      name: fiber.name,
      participation: 'not-recorded',
    }));
  }
  const participation = participationsOf(components.fibers);
  return components.fibers.map((fiber) => ({
    fiberIndex: fiber.id,
    name: fiber.name,
    participation: participation.get(fiber.id) ?? 'carried-over',
  }));
}

function getOrCreate(
  tallies: Map<string, Tally>,
  name: string,
  subject: () => CauseSubject,
): Tally {
  const existing = tallies.get(name);
  if (existing !== undefined) return existing;
  const created: Tally = { name, subject: subject(), numerator: 0, evidence: [] };
  tallies.set(name, created);
  return created;
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
): Tally[] {
  const tallies = new Map<string, Tally>();

  for (const entry of times.fibers) {
    if (!didRender(entry.participation)) continue;
    const tally = getOrCreate(tallies, entry.fiber.name, () => ({
      kind: 'component',
      name: entry.fiber.name,
      nameIsMinified: false,
      definedAt: null,
    }));
    tally.numerator += Math.max(entry.selfMs, 0);
    tally.evidence.push({
      kind: 'fiber-render-time',
      componentName: entry.fiber.name,
      actualDurationMs: entry.actualDurationMs,
      selfDurationMs: entry.selfMs,
    });
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

  return [...tallies.values()];
}

/** A stable key for a profiler frame's definition site. */
function definitionSiteKey(frame: ProfiledFrame): string {
  return `${String(frame.resourceId)}:${String(frame.line)}:${String(frame.column)}`;
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
 * A name that matches frames at more than one definition site is not charged
 * at all (see `ambiguous-minified-name`). A component is one function at one
 * site, so a second site means another function shares the minified name, and
 * there is no way to tell which samples were whose.
 */
function tallySamples(
  components: readonly CommitComponent[],
  profile: ProfileTrace,
  window: CommitSampleWindow,
  provenance: CaptureProvenance,
): { tallies: Tally[]; samplesInWindow: number; notes: ComponentAttributionNote[] } {
  // Where render evidence was not recorded, every fiber is a possible
  // renderer: nothing in the record can rule one out.
  const rendered = components.filter(
    (component): component is RenderedOrUnknown =>
      component.participation === 'not-recorded' || didRender(component.participation),
  );
  const names = new Set(rendered.map((component) => component.name));

  const counts = new Map<string, number>();
  const sites = new Map<string, Map<string, ProfiledFrame>>();
  let samplesInWindow = 0;

  for (const sample of profile.samples) {
    if (sample.stackId === null) continue;
    if (sample.atMs <= window.fromMs || sample.atMs > window.toMs) continue;
    samplesInWindow += 1;

    const match = stackFrames(profile, sample.stackId).find(
      (frame) => frame.name !== null && names.has(frame.name),
    );
    if (match?.name == null) continue;

    counts.set(match.name, (counts.get(match.name) ?? 0) + 1);
    const nameSites = sites.get(match.name) ?? new Map<string, ProfiledFrame>();
    nameSites.set(definitionSiteKey(match), match);
    sites.set(match.name, nameSites);
  }

  const notes: ComponentAttributionNote[] = [];
  const tallies = new Map<string, Tally>();
  const nameIsMinified = provenance.buildMode === 'production';

  for (const component of rendered) {
    const nameSites = [...(sites.get(component.name)?.values() ?? [])];
    const ambiguous = nameSites.length > 1;
    const [site] = nameSites;

    const tally = getOrCreate(tallies, component.name, () => ({
      kind: 'component',
      name: component.name,
      nameIsMinified,
      definedAt:
        !ambiguous && site !== undefined ? generatedLocation(profile, site) : null,
    }));

    if (component.participation !== 'not-recorded') {
      tally.evidence.push({
        kind: 'fiber-rendered',
        componentName: component.name,
        participation: component.participation,
      });
    }

    // Once per name, on the first fiber that carries it.
    if (tally.evidence.some((evidence) => evidence.kind === 'profiler-samples')) continue;
    if (ambiguous) {
      notes.push({
        kind: 'ambiguous-minified-name',
        componentName: component.name,
        definitionSites: nameSites.length,
      });
    }
    const samples = ambiguous ? 0 : (counts.get(component.name) ?? 0);
    tally.numerator = samples;
    tally.evidence.push({
      kind: 'profiler-samples',
      samples,
      ofSamplesInWindow: samplesInWindow,
      window: 'commit-render',
    });
  }

  // Reported rather than divided by: with nothing in the window, every
  // rendered component would otherwise carry a weight of 0 of 0.
  if (samplesInWindow === 0 && rendered.length > 0) {
    notes.push({ kind: 'no-samples-in-window' });
    return { tallies: [], samplesInWindow, notes };
  }

  return { tallies: [...tallies.values()], samplesInWindow, notes };
}

/** Picks the strongest tier a commit supports and tallies it there. */
function tallyCommit(
  signals: CapturedSignals,
  commit: ReactCommit,
  window: CommitSampleWindow,
): CommitTally {
  const components = componentsOf(commit);
  const timing = commitRenderTimes(commit);

  if (timing.kind === 'timed') {
    const { times } = timing;
    const denominator = times.fibers.reduce(
      (sum, entry) => sum + Math.max(entry.selfMs, 0),
      0,
    );
    return {
      basis: { tier: 'react-fiber-timings', times },
      components,
      tallies: tallyFiberTimings(times, signals.react.spans, window),
      denominator,
      notes: times.notes,
    };
  }

  if (signals.profile === null) {
    return {
      basis: { tier: 'unattributed', shortfall: timing.shortfall, reason: 'no-profiler' },
      components,
      tallies: [],
      denominator: 0,
      notes: [],
    };
  }

  const sampled = tallySamples(components, signals.profile, window, signals.provenance);
  return {
    basis: {
      tier: 'profiler-unmapped',
      shortfall: timing.shortfall,
      samplesInWindow: sampled.samplesInWindow,
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
  const causes: CandidateCause[] = [];
  for (const tally of tallies) {
    const [first, ...rest] = tally.evidence;
    // Every tally is created by a loop that pushes at least one entry onto it
    // before the next tally is created, so `first` is always present. Skipped
    // rather than asserted, so that a future path that broke this would lose a
    // candidate visibly in a test instead of fabricating one.
    if (first === undefined) continue;
    causes.push({
      subject: tally.subject,
      weight: confidenceWeight(
        denominator > 0 ? tally.numerator / denominator : 0,
        basis,
      ),
      tier,
      evidence: [first, ...rest],
    });
  }
  return rankCauses(causes);
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
 * `sinceMs` opens the commit's sample window: page-clock milliseconds, the
 * later of the previous commit's `committedAtMs` and the start of the
 * interaction the commit belongs to. The window closes at the commit itself.
 * At the fiber tier it decides only which spans corroborate. At the profiler
 * tier it decides which samples are shared out.
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
  const sampleWindow = { fromMs: sinceMs, toMs: commit.committedAtMs };
  return commitAttributionOf(
    signals,
    commit,
    sampleWindow,
    tallyCommit(signals, commit, sampleWindow),
  );
}

function commitAttributionOf(
  signals: CapturedSignals,
  commit: ReactCommit,
  sampleWindow: CommitSampleWindow,
  tally: CommitTally,
): CommitAttribution {
  return {
    commit,
    frame: frameAt(signals.frames, commit.committedAtMs),
    sampleWindow,
    components: tally.components,
    basis: tally.basis,
    causes: rankTallies(tally.basis.tier, tally.tallies, tally.denominator),
    notes: tally.notes,
  };
}

/** One interaction's component attribution, merged across its commits. */
export type InteractionComponents =
  | {
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
      readonly merged: {
        readonly tier: AttributionTier;
        readonly causes: RankedCauses;
      } | null;
    }
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
 * `committedAtMs`, inclusive at both ends. Its sample window opens at the
 * previous commit or at the interaction's start, whichever is later. A frame
 * is not required: the interaction's frames are reported beside the answer,
 * and an interaction with none is still attributed from its commits.
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

  const attributed: CommitAttribution[] = [];
  const tallies: CommitTally[] = [];
  for (const [index, commit] of commits.entries()) {
    if (
      commit.committedAtMs < interaction.fromMs ||
      commit.committedAtMs > interaction.toMs
    ) {
      continue;
    }
    const previous = commits[index - 1];
    const sinceMs = Math.max(
      interaction.fromMs,
      previous?.committedAtMs ?? interaction.fromMs,
    );
    const window = { fromMs: sinceMs, toMs: commit.committedAtMs };
    const tally = tallyCommit(signals, commit, window);
    tallies.push(tally);
    attributed.push(commitAttributionOf(signals, commit, window, tally));
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
function mergeTallies(
  commits: readonly CommitTally[],
): { tier: AttributionTier; causes: RankedCauses } | null {
  const [first] = commits;
  if (first === undefined) return null;
  const tier = first.basis.tier;
  if (commits.some((commit) => commit.basis.tier !== tier)) return null;

  const merged = new Map<string, Tally>();
  let denominator = 0;
  for (const commit of commits) {
    denominator += commit.denominator;
    for (const tally of commit.tallies) {
      const target = getOrCreate(merged, tally.name, () => tally.subject);
      target.numerator += tally.numerator;
      target.evidence.push(...tally.evidence);
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
        `${describeTier(basis.tier)}, joined to the components React's DevTools hook ` +
        `reported by name; degraded from ${describeTier('react-fiber-timings')} because ` +
        `${describeShortfall(basis.shortfall)}. Source maps are not resolved at this tier, ` +
        'even where the bundle ships one, so component names and positions are as the ' +
        'bundle shipped them'
      );
    case 'unattributed':
      return (
        `${describeTier(basis.tier)}: React's DevTools hook named the components that ` +
        `rendered, but ${describeShortfall(basis.shortfall)} and no profile was captured`
      );
  }
}

/** One line of prose for a component-attribution note. */
export function describeComponentNote(note: ComponentAttributionNote): string {
  switch (note.kind) {
    case 'negative-self-time':
      return `${note.componentName} (fiber ${String(note.fiberId)}) has children summing to ${note.byMs.toFixed(1)}ms more than its own subtree time; its self time is reported as negative, not clamped`;
    case 'walk-truncated':
      return "the collector's walk hit its fiber cap, so some ancestors' self times include fibers the record does not show";
    case 'ambiguous-minified-name':
      return `${note.componentName} matched ${String(note.definitionSites)} different functions in the profile, so none of its samples were charged to it`;
    case 'no-samples-in-window':
      return "no profiler sample with a stack fell inside the commit's window, so the rendered components carry no weight";
  }
}
