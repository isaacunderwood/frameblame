/**
 * The profiler tier of the React join: a commit's window of samples charged
 * to the components the DevTools hook says rendered, by the minified name the
 * hook and the profiler share.
 *
 * This is what `component-attribution.ts` falls back to when a commit carries
 * no fiber timings, which is every commit of a production build. Its header,
 * under "When the React tier is unavailable", says why the join works at all:
 * the hook's `name` and the profiler's function name are the same identifier,
 * read from the same bundle, and a source map's `names` gives the component
 * its real name back. This module holds the join itself: the per-capture
 * index of names to definition sites, the walk that charges each sample to
 * the innermost rendered component on its stack, and the tier each candidate
 * and each commit stands on.
 *
 * ## What this module does not do
 *
 * It does not pick the tier a commit is attributed at, turn tallies into
 * weights, or merge commits; `component-attribution.ts` does all three, and
 * owns the tally types this module fills in. It reads the hook's record of
 * which components rendered and the profile it is handed, and nothing else.
 * It imports only types from `component-attribution.ts`, so the two modules
 * have no cycle at runtime.
 *
 * **Clock.** Every `…Ms` value is page-clock `performance.now()` milliseconds.
 */

import type { AttributionTier, CauseEvidence, CauseSubject } from './attribution.ts';
import type {
  CommitComponent,
  CommitSampleWindow,
  ComponentAttributionNote,
  Remainder,
  Tally,
} from './component-attribution.ts';
import { didRender, type RenderedParticipation } from './fiber-self-time.ts';
import { type ProfileTrace, type SampleCounts, stackFrames } from './profiler.ts';
import type { CaptureProvenance } from './provenance.ts';
import {
  definitionSite,
  type FrameResolution,
  generatedSiteKey,
  type ResolvedProfile,
} from './source-map.ts';

/**
 * The `fiber-rendered` evidence for every component the hook says rendered:
 * which components took part, with nothing about how long they took. Empty
 * where the record does not say which fibers rendered.
 *
 * Here rather than in `component-attribution.ts` because the join puts it on
 * every sampled candidate, and this module may import nothing at runtime from
 * the module that calls it.
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

/**
 * A resolved profile and its per-capture name index, built together. The
 * resolution carries each sample's independence weight
 * (`ResolvedProfile.independence`), which every share here is counted in.
 */
export interface IndexedProfile {
  readonly resolved: ResolvedProfile;
  readonly sites: DefinitionSites;
}

/**
 * The capture's resolved profile with its name index, or `null` when there
 * was no profiler. Built once per capture, so that the name index, like the
 * maps, is computed once.
 */
export function indexProfile(resolved: ResolvedProfile | null): IndexedProfile | null {
  if (resolved === null) return null;
  return { resolved, sites: definitionSitesOf(resolved.trace) };
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
  resolved: ResolvedProfile,
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
        resolved.frames[site]?.kind === 'mapped',
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
export function tallySamples(
  components: readonly CommitComponent[],
  { resolved, sites }: IndexedProfile,
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
  const { trace: profile, independence: weights } = resolved;
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
      !ambiguous && site !== undefined ? resolved.frames[site] : undefined;
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
