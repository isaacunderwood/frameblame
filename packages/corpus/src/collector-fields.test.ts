/**
 * The fields the v0.3 collector change added, read from synthetic records.
 *
 * Synthetic because the readers accept two shapes and the corpus now holds
 * only one. These tests were written before the v0.3 re-capture, when no run
 * carried a fiber's `id`, `parentId` and render evidence, a commit's
 * `truncated`, or the forced style and layout split in the collector's own
 * projection; since it, every run carries all of them (asserted against the
 * corpus in `records.test.ts`) and no run carries the old shape. These tests
 * pin what the readers do with both, so that an older capture still reads as
 * what it is, and so that the shape-checking the corpus never exercises — a
 * commit linked on some fibers and not others, ids that break the scheme — is
 * exercised somewhere.
 *
 * The records are the smallest the readers accept, shaped like the
 * collector's output and nothing more. No figure in them is a measurement.
 */

import { describe, expect, it } from 'vitest';

import type { CorpusRun } from './corpus.ts';
import type { Json } from './json.ts';
import { framesOf } from './loaf-records.ts';
import { reactOf } from './react-records.ts';

/** A run whose only populated file is the one under test. */
function runWith(files: Partial<CorpusRun['files']>): CorpusRun {
  return {
    fixture: 'synthetic',
    mode: 'development',
    dir: '/nonexistent',
    files: { run: null, loaf: null, profile: null, react: null, sourceWindows: null, ...files },
  };
}

/** The render evidence a fiber that rendered in this commit would carry. */
const RENDERED = { flags: 1, hasAlternate: true, carriedOver: false };

function fiber(
  name: string,
  links: { id: number; parentId: number | null } | null,
  render: object = links === null ? {} : RENDERED,
): Json {
  return {
    ...links,
    ...render,
    name,
    tag: 0,
    lanes: 0,
    actualDuration: 1,
    selfBaseDuration: 1,
  };
}

function commitsOf(components: Json[], extra: object = {}) {
  return reactOf(
    runWith({
      react: {
        reactDevToolsHookInstalled: true,
        commits: [
          {
            kind: 'commit',
            committedAt: 100,
            collectionCost: 0.1,
            rendererId: 1,
            didError: false,
            priorityLevel: null,
            components,
            ...extra,
          },
        ],
        measures: [],
      },
    }),
  ).commits;
}

describe('fiber parent links', () => {
  it('reads a capture made before the collector recorded them as unrecorded, not as a guessed tree', () => {
    const [commit] = commitsOf([fiber('App', null), fiber('Child', null)]);

    expect(commit?.components.linkage).toBe('unrecorded');
    expect(commit?.components.fibers.map((f) => f.name)).toEqual(['App', 'Child']);
    // Nor as a walk known to be complete: the old collector never said.
    expect(commit?.truncated).toBeNull();
  });

  it('carries the truncation flag and each fiber’s raw render evidence where recorded', () => {
    const carried = { flags: 1, hasAlternate: true, carriedOver: true };
    const [commit] = commitsOf(
      [
        fiber('App', { id: 0, parentId: null }, { flags: 0, hasAlternate: true, carriedOver: false }),
        fiber('Stale', { id: 1, parentId: 0 }, carried),
      ],
      { truncated: true },
    );

    expect(commit?.truncated).toBe(true);
    expect(commit?.components).toMatchObject({
      linkage: 'recorded',
      fibers: [
        { name: 'App', render: { flags: 0, hasAlternate: true, carriedOver: false } },
        // A previous commit's object keeps its old `PerformedWork` bit, which is
        // why `carriedOver` is carried beside the flags rather than inferred.
        { name: 'Stale', render: carried },
      ],
    });
  });

  it('refuses links with no render evidence beside them', () => {
    expect(() => commitsOf([fiber('App', { id: 0, parentId: null }, {})])).toThrow(/flags/);
  });

  it('links each fiber to its nearest component ancestor where the collector recorded it', () => {
    const [commit] = commitsOf([
      fiber('App', { id: 0, parentId: null }),
      fiber('Sibling', { id: 1, parentId: 0 }),
      fiber('Child', { id: 2, parentId: 0 }),
      fiber('Grandchild', { id: 3, parentId: 2 }),
    ]);

    expect(commit?.components).toMatchObject({
      linkage: 'recorded',
      fibers: [
        { name: 'App', id: 0, parentId: null },
        { name: 'Sibling', id: 1, parentId: 0 },
        { name: 'Child', id: 2, parentId: 0 },
        { name: 'Grandchild', id: 3, parentId: 2 },
      ],
    });
  });

  it('refuses a commit linked on some fibers and not others', () => {
    expect(() =>
      commitsOf([fiber('App', { id: 0, parentId: null }), fiber('Child', null)]),
    ).toThrow(/1 of 2 fibers carry an id/);
  });

  it('refuses ids that break the scheme the self-time subtraction trusts', () => {
    // An id that is not the fiber's index.
    expect(() => commitsOf([fiber('App', { id: 1, parentId: null })])).toThrow(
      /is not the fiber's index/,
    );
    // A parent that is not an earlier fiber: the walk emits ancestors first.
    expect(() =>
      commitsOf([fiber('App', { id: 0, parentId: 1 }), fiber('Child', { id: 1, parentId: 0 })]),
    ).toThrow(/does not name an earlier fiber/);
  });
});

describe('the forced style and layout split', () => {
  /** One painted frame holding one script, with the split in whichever copies are given. */
  function scriptOf(serialisedSplit: object, projectedSplit: object) {
    const script = {
      name: 'script',
      entryType: 'script',
      startTime: 10,
      duration: 40,
      executionStart: 10,
      invoker: 'BUTTON.onclick',
      invokerType: 'event-listener',
      sourceURL: '',
      sourceFunctionName: '',
      sourceCharPosition: -1,
      pauseDuration: 0,
      forcedStyleAndLayoutDuration: 30,
      windowAttribution: 'self',
    };
    const [frame] = framesOf(
      runWith({
        loaf: {
          entries: [
            {
              toJSON: {
                startTime: 0,
                duration: 60,
                blockingDuration: 10,
                firstUIEventTimestamp: 0,
                renderStart: 55,
                styleAndLayoutStart: 56,
                styleDuration: 1,
                layoutDuration: 1,
                paintTime: 60,
                scripts: [{ ...script, ...serialisedSplit }],
              },
              scripts: [{ ...script, sourceLine: null, sourceColumn: null, ...projectedSplit }],
            },
          ],
        },
      }),
    );
    return frame?.scripts[0];
  }

  it('is absent, not zero, when neither copy of the entry carries it', () => {
    const script = scriptOf({}, { forcedStyleDuration: null, forcedLayoutDuration: null });

    expect(script?.forcedStyleDurationMs).toBeNull();
    expect(script?.forcedLayoutDurationMs).toBeNull();
  });

  it('is read from the collector projection where Chrome’s own serialisation lacks it', () => {
    const script = scriptOf({}, { forcedStyleDuration: 8, forcedLayoutDuration: 22 });

    expect(script?.forcedStyleDurationMs).toBe(8);
    expect(script?.forcedLayoutDurationMs).toBe(22);
  });

  it('prefers Chrome’s own serialisation, the authoritative copy, where both have it', () => {
    const script = scriptOf(
      { forcedStyleDuration: 8, forcedLayoutDuration: 22 },
      { forcedStyleDuration: 9, forcedLayoutDuration: 21 },
    );

    expect(script?.forcedStyleDurationMs).toBe(8);
    expect(script?.forcedLayoutDurationMs).toBe(22);
  });
});
