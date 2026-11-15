/**
 * The React tier's arithmetic: which recorded fibers took part in a commit,
 * and each one's self time within it.
 *
 * This is the half of the React tier that needs nothing but the commit record.
 * `component-attribution.ts` turns its self times into ranked candidates, and
 * falls back to the profiler where this module returns `untimed`.
 *
 * ## Self time
 *
 * A fiber's `actualDuration` is its subtree's render time. Self time is
 * `actualDuration - sum(children's actualDuration)`. That is React's own
 * formula (`react-dom-client.development.js:4419-4423`, 19.3.1), but React
 * applies it over every direct child fiber, host fibers included, and only
 * where the fiber's child list changed (`null === alternate ||
 * alternate.child !== fiber.child`). The engine applies it over the recorded
 * component fibers only: the children are the component fibers whose
 * `parentId` names this one, which is the nearest component above them. Host
 * fibers are not in the record, so their time, such as the DOM nodes created
 * on a mount, stays in the self time of the nearest component above them.
 * That is visible in `spans`' `initial-mount`: `App`, which mounts the
 * fixture's host elements, reads 35.7ms of self time against 25.5-26.5ms for
 * each of the four components mounted beneath it, though all five burn the
 * same 25ms (development, 4x).
 *
 * The subtraction runs only over fibers that took part in the commit. The two
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
 * ## What this module does not do
 *
 * It does not weight, rank or name a cause, read a profile or a span, or
 * decide which interaction a commit belongs to. It reports what the record
 * supports, and where the record supports nothing it says why, with a named
 * shortfall, rather than guessing.
 *
 * **Clock.** Every `…Ms` value here is a duration in milliseconds of the page
 * clock, `performance.now()`.
 */

import { exceedsByMoreThanCoarsening } from './loaf.ts';
import type { FiberId, LinkedFiber, ReactCommit } from './react.ts';

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
export function participationsOf(
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

/**
 * One fiber's entry in a map `participationsOf` built for its commit.
 *
 * Throws when the fiber has none. `participationsOf` sets an entry for every
 * fiber it is given, or throws itself, so reaching the throw means the map was
 * built for a different commit. Thrown rather than defaulted, because a
 * default would quietly relabel a fiber that rendered.
 */
export function participationIn(
  participation: ReadonlyMap<FiberId, FiberParticipation>,
  fiber: LinkedFiber,
): FiberParticipation {
  const entry = participation.get(fiber.id);
  if (entry === undefined) {
    throw new Error(
      `fiber ${String(fiber.id)} (${fiber.name}) has no participation: the map was not built ` +
        'by participationsOf over this commit',
    );
  }
  return entry;
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
 *
 * `participation` is `participationsOf` over this commit's fibers, for a
 * caller that has already built it; it is built here when omitted. Throws if
 * it lacks an entry for one of the commit's fibers.
 */
export function commitRenderTimes(
  commit: ReactCommit,
  participation?: ReadonlyMap<FiberId, FiberParticipation>,
): CommitRenderTiming {
  const components = commit.components;
  if (components.linkage === 'unrecorded') {
    return { kind: 'untimed', shortfall: 'fiber-linkage-unrecorded' };
  }

  const participationById = participation ?? participationsOf(components.fibers);
  const inCommit: {
    fiber: LinkedFiber;
    participation: Exclude<FiberParticipation, 'carried-over'>;
    actualMs: number;
  }[] = [];
  let carriedOverFibers = 0;

  for (const fiber of components.fibers) {
    const own = participationIn(participationById, fiber);
    if (own === 'carried-over') {
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

  let renderedSelfMs = 0;
  let bailedOutSelfMs = 0;
  for (const entry of fibers) {
    if (didRender(entry.participation)) renderedSelfMs += entry.selfMs;
    else bailedOutSelfMs += entry.selfMs;
  }

  return {
    kind: 'timed',
    times: {
      totalMs,
      fibers,
      renderedSelfMs,
      bailedOutSelfMs,
      carriedOverFibers,
      notes,
    },
  };
}
