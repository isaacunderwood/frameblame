/**
 * The engine's entry point: one capture's signals in, every frame and every
 * interaction attributed, with what the answer was working from.
 *
 * Everything below this module answers one question about one kind of record.
 * This one asks them all of a capture and lays the answers side by side, at
 * the two grains the fixtures make claims at:
 *
 * - **Per frame** (`frame-attribution.ts`): where a long frame's time went,
 *   as ranked candidate causes whose weights are shares of the frame.
 * - **Per interaction**: what the interaction's renders and samples say,
 *   whether or not any frame crossed LoAF's 50ms threshold. `spans`'
 *   `state-owner-self` renders for 25.2ms and produces no long frame
 *   (development, 4x); `derive-in-render`'s production replay produced a long
 *   frame after 1 of its 24 presses (4x). LoAF reported two more in that run,
 *   neither from a press: one during the page load, starting at 48.9ms before
 *   the first press at 205.1ms, and one after the replay's window closed. An
 *   answer keyed on frames alone would say nothing about the first and almost
 *   nothing about the second.
 *
 * ## The three levels of claim
 *
 * `findings.md` settles what can be known at each level, and each has one
 * place in the answer:
 *
 * - **The component** is `InteractionAttribution.components`: measured from
 *   fiber timings in development, at `high` confidence; sampled against the
 *   hook's names where a production build withholds the timings.
 * - **The function** is `InteractionAttribution.functions`: a distribution
 *   over every sample taken inside the interaction's window, which for a
 *   replayed interaction is the replay. It is the population LoAF's
 *   threshold does not choose. A function is located by its definition site,
 *   and each share carries its independent sample count and range.
 * - **The statement** is not available from inside the page at any sample
 *   count, and `statementLevel` says so in the data. Nothing here can
 *   construct a claim finer than a function's definition site.
 *
 * ## Degrading, and saying so
 *
 * The same call works with any signal missing, and `workingFrom` names what
 * was missing and what that cost:
 *
 * - No profile: script time is charged to the entry LoAF named, no function
 *   is named, the unattributed share rests on subtraction alone, and a commit
 *   without fiber timings is named from the hook and left unweighed.
 * - No DevTools hook: no component is named, and the answer is source-level,
 *   the functions the profiler saw.
 * - No fiber timings (a production build): components are sampled, not
 *   measured.
 * - No source map for a script: its functions are named as the script was
 *   served, which in a production bundle means minified, with the reason on
 *   each position.
 *
 * ## What this module does not do
 *
 * It does not group frames by cause across a session, rank interactions
 * against each other, or decide what is slow. It holds no heuristic of its
 * own: every number here was computed by a module below it. It is pure, like
 * the rest of `core`.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import {
  attributeCommit,
  type CommitAttribution,
  componentsOfInteraction,
  type InteractionComponents,
} from './component-attribution.ts';
import { attributeFrames, type FrameAttribution } from './frame-attribution.ts';
import {
  attributeSampledFunctions,
  type FunctionAttribution,
} from './line-attribution.ts';
import type { CaptureProvenance } from './provenance.ts';
import type { ReactCommit } from './react.ts';
import type { CapturedSignals, InteractionWindow } from './signals.ts';
import { resolveProfile, type ResolvedProfile } from './source-map.ts';

/**
 * A signal the capture did not have, named with what its absence degraded.
 *
 * "Degrade in tiers, and name the tier": every candidate already carries the
 * tier it stands on, and this is the same statement made once for the whole
 * answer, so a reader knows what was missing before reading any number.
 */
export type Degradation =
  /** No profile: `Document-Policy: js-profiling` was not on the document response. */
  | { readonly kind: 'profiler-absent' }
  /** The DevTools hook was not installed, so React could have rendered unseen. */
  | { readonly kind: 'react-hook-absent' }
  /**
   * The hook reported commits, and none carried usable fiber timings: a
   * production build, or a capture that did not record how fibers nest.
   */
  | { readonly kind: 'fiber-timings-absent' }
  /**
   * Scripts the profiler sampled that had no usable source map, by served
   * URL: none shipped, or the one named could not be fetched or read. Their
   * functions are named as served. A script whose map merely does not cover
   * one position is not listed; that position says so itself.
   */
  | { readonly kind: 'source-map-absent'; readonly scriptUrls: readonly string[] };

/**
 * The function-level answer for one interaction, or why there is none.
 *
 * A union, so that "no profile" cannot be mistaken for "a profile with no
 * samples in the window": the second is a `sampled` attribution whose ranking
 * is empty.
 */
export type FunctionLevel =
  | { readonly kind: 'sampled'; readonly attribution: FunctionAttribution }
  | { readonly kind: 'unavailable'; readonly reason: 'no-profiler' };

/** One interaction, attributed at every level the capture supports. */
export interface InteractionAttribution {
  readonly interaction: InteractionWindow;
  /**
   * The long frames that began in the interaction's window, attributed. May
   * be empty, and that is a finding: the interaction ran under LoAF's 50ms
   * threshold.
   */
  readonly frames: readonly FrameAttribution[];
  /** Which components rendered, per commit and merged. See `component-attribution.ts`. */
  readonly components: InteractionComponents;
  /**
   * Which functions the interaction's samples ran in, over the whole
   * interaction window. For a replayed interaction this is the distribution
   * over the replay, and it does not depend on which presses produced a long
   * frame.
   */
  readonly functions: FunctionLevel;
}

/** One capture, attributed. */
export interface CaptureAttribution {
  /** Carried so that every millisecond figure here can be quoted with it. */
  readonly provenance: CaptureProvenance;
  /** What the capture lacked, and so what the answer degraded to. Empty when nothing was missing. */
  readonly workingFrom: readonly Degradation[];
  /** Every long frame, in start order. */
  readonly frames: readonly FrameAttribution[];
  /** Every interaction, in plan order. */
  readonly interactions: readonly InteractionAttribution[];
  /**
   * Every React commit, in commit order, including any that no interaction's
   * window and no frame contains. A commit is evidence on its own.
   */
  readonly commits: readonly CommitAttribution[];
  /**
   * Statement-level attribution is unavailable from inside the page. The JS
   * Self-Profiling API reports the line a function was *defined* on, so
   * every location in this answer is a definition site, at any sample count.
   * CDP's `positionTicks` can see the executing line; the in-page profiler
   * cannot. A constant, carried in the data so that a consumer does not have
   * to know it.
   */
  readonly statementLevel: 'unavailable-in-page';
}

/**
 * Attributes every commit in the capture, in commit order.
 *
 * A commit inside an interaction's window takes that interaction's
 * attribution of it, so the two views share one object. A commit no window
 * contains is attributed on its own, with its sample window opening at the
 * commit before it, or at the start of the page clock.
 */
function attributeCommits(
  signals: CapturedSignals,
  interactions: readonly InteractionComponents[],
  resolved: ResolvedProfile | null,
): CommitAttribution[] {
  const attributed = new Map<ReactCommit, CommitAttribution>();
  for (const interaction of interactions) {
    if (interaction.kind !== 'attributed') continue;
    for (const commit of interaction.commits) attributed.set(commit.commit, commit);
  }

  const { commits } = signals.react;
  return commits.map(
    (commit, index) =>
      attributed.get(commit) ??
      attributeCommit(signals, commit, commits[index - 1]?.committedAtMs ?? 0, resolved),
  );
}

/** What the capture lacked. See `Degradation`. */
function degradationsOf(
  signals: CapturedSignals,
  resolved: ResolvedProfile | null,
  commits: readonly CommitAttribution[],
): Degradation[] {
  const degradations: Degradation[] = [];
  if (resolved === null) degradations.push({ kind: 'profiler-absent' });
  if (!signals.react.hookInstalled) degradations.push({ kind: 'react-hook-absent' });
  if (
    commits.length > 0 &&
    commits.every((commit) => commit.basis.tier !== 'react-fiber-timings')
  ) {
    degradations.push({ kind: 'fiber-timings-absent' });
  }

  if (resolved !== null) {
    const unmapped = new Set<string>();
    for (const frame of resolved.frames) {
      if (frame.kind !== 'unmapped') continue;
      if (frame.definedAt.whyNot === 'no-mapping-at-position') continue;
      unmapped.add(frame.scriptUrl);
    }
    if (unmapped.size > 0) {
      degradations.push({ kind: 'source-map-absent', scriptUrls: [...unmapped] });
    }
  }
  return degradations;
}

/**
 * Attributes one capture: every long frame and every interaction, with ranked
 * candidate causes, the tier each stands on and how far each weight can be
 * trusted.
 *
 * Always returns an answer, whatever signals the capture lacks: `profile` may
 * be `null`, the hook may be absent, and source maps may be missing.
 * `workingFrom` names each absence, and the tiers on the candidates say what
 * each claim was derived from.
 *
 * Each interaction is attributed over its own window, so a label repeated
 * within the capture does not make one window answer for another. Every
 * timing in the result is page-clock milliseconds, and `provenance` carries
 * the build mode and throttle rate they must be quoted with.
 */
export function attributeCapture(signals: CapturedSignals): CaptureAttribution {
  const resolved = signals.profile === null ? null : resolveProfile(signals.profile);

  const perInteraction = signals.interactions.map((interaction) => ({
    interaction,
    components: componentsOfInteraction(signals, interaction, resolved),
  }));

  const commits = attributeCommits(
    signals,
    perInteraction.map((each) => each.components),
    resolved,
  );
  const frames = attributeFrames(signals, resolved, commits);

  const interactions = perInteraction.map(
    ({ interaction, components }): InteractionAttribution => ({
      interaction,
      frames: frames.filter((frame) => components.frames.includes(frame.frame)),
      components,
      functions:
        resolved === null
          ? { kind: 'unavailable', reason: 'no-profiler' }
          : {
              kind: 'sampled',
              attribution: attributeSampledFunctions(resolved, signals.provenance, {
                window: 'interaction',
                ranges: [
                  {
                    kind: 'interval',
                    fromMs: interaction.fromMs,
                    toMs: interaction.toMs,
                    end: 'inclusive',
                  },
                ],
              }),
            },
    }),
  );

  return {
    provenance: signals.provenance,
    workingFrom: degradationsOf(signals, resolved, commits),
    frames,
    interactions,
    commits,
    statementLevel: 'unavailable-in-page',
  };
}

/** One line of prose for a degradation: what was missing, and what the answer fell back to. */
export function describeDegradation(degradation: Degradation): string {
  switch (degradation.kind) {
    case 'profiler-absent':
      return (
        'no profile was captured: script time is charged to the entry LoAF named, which is ' +
        'where a listener was registered; no function is named; unattributed time rests on ' +
        'subtraction alone; and a commit without fiber timings is named and not weighed'
      );
    case 'react-hook-absent':
      return (
        "React's DevTools hook was not installed: no component is named, and the answer is " +
        'the functions the profiler saw'
      );
    case 'fiber-timings-absent':
      return (
        'no commit carried fiber render timings, which is what a production build reports: ' +
        'component shares are sampled rather than measured'
      );
    case 'source-map-absent':
      return (
        `no usable source map for ${degradation.scriptUrls.join(', ')}: functions there ` +
        'are named as the script was served, which may be minified'
      );
  }
}
