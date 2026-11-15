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
 * fiber that disagrees with its commit about linkage, ids that break the
 * scheme — is exercised somewhere.
 *
 * One block here is not about the v0.3 fields: a phase span's originator rows.
 * The corpus exercises them only where React happened to emit an update span,
 * which is chance (see `records.test.ts`), so the by-label parsing is pinned
 * here, where it does not depend on a capture.
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
    files: {
      run: null,
      loaf: null,
      profile: null,
      react: null,
      sourceWindows: null,
      ...files,
    },
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

/**
 * The commit-level key the linked collector writes. Its presence, not anything
 * on a fiber, is what makes a commit `recorded` — see `readComponents`.
 */
const LINKED = { truncated: false };

function commitsOf(components: Json[], commit: object = {}) {
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
            ...commit,
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
    // Nor as a walk known to be complete: the old collector never said, so the
    // unrecorded variant has no `truncated` at all.
    expect(commit?.components).not.toHaveProperty('truncated');
  });

  it('carries the truncation flag and each fiber’s raw render evidence where recorded', () => {
    const carried = { flags: 1, hasAlternate: true, carriedOver: true };
    const [commit] = commitsOf(
      [
        fiber(
          'App',
          { id: 0, parentId: null },
          { flags: 0, hasAlternate: true, carriedOver: false },
        ),
        fiber('Stale', { id: 1, parentId: 0 }, carried),
      ],
      { truncated: true },
    );

    expect(commit?.components).toMatchObject({
      linkage: 'recorded',
      truncated: true,
      fibers: [
        { name: 'App', render: { flags: 0, hasAlternate: true, carriedOver: false } },
        // A previous commit's object keeps its old `PerformedWork` bit, which is
        // why `carriedOver` is carried beside the flags rather than inferred.
        { name: 'Stale', render: carried },
      ],
    });
  });

  it('reads linkage off the commit, so an empty recorded commit is still recorded', () => {
    const [commit] = commitsOf([], LINKED);

    expect(commit?.components).toEqual({
      linkage: 'recorded',
      truncated: false,
      fibers: [],
    });
  });

  it('refuses links with no render evidence beside them, naming the full path', () => {
    expect(() =>
      commitsOf([fiber('App', { id: 0, parentId: null }, {})], LINKED),
    ).toThrow('commits.0.components.0.flags is undefined, expected a number');
  });

  it('refuses a linked fiber with no parentId key, which is a missing link rather than a root', () => {
    // An id and render evidence, and no `parentId` key at all.
    const withoutParent = fiber('App', null, { ...RENDERED, id: 0 });

    expect(() => commitsOf([withoutParent], LINKED)).toThrow(
      'commits.0.components.0.parentId is undefined',
    );
  });

  it('links each fiber to its nearest component ancestor where the collector recorded it', () => {
    const [commit] = commitsOf(
      [
        fiber('App', { id: 0, parentId: null }),
        fiber('Sibling', { id: 1, parentId: 0 }),
        fiber('Child', { id: 2, parentId: 0 }),
        fiber('Grandchild', { id: 3, parentId: 2 }),
      ],
      LINKED,
    );

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

  it('refuses a recorded commit with a fiber that carries no links', () => {
    expect(() =>
      commitsOf([fiber('App', { id: 0, parentId: null }), fiber('Child', null)], LINKED),
    ).toThrow('commits.0.components.1.id is undefined, expected a number');
  });

  it('refuses an unrecorded commit with a fiber that carries links', () => {
    expect(() =>
      commitsOf([fiber('App', null), fiber('Child', { id: 1, parentId: 0 })]),
    ).toThrow(
      /commits\.0\.components\.1\.id is present, but the commit carries no `truncated`/,
    );
  });

  it('refuses ids that break the scheme the self-time subtraction trusts', () => {
    // An id that is not the fiber's index.
    expect(() => commitsOf([fiber('App', { id: 1, parentId: null })], LINKED)).toThrow(
      /commits\.0\.components\.0\.id: id 1 is not the fiber's index 0/,
    );
    // A parent that is not an earlier fiber: the walk emits ancestors first.
    expect(() =>
      commitsOf(
        [fiber('App', { id: 0, parentId: 1 }), fiber('Child', { id: 1, parentId: 0 })],
        LINKED,
      ),
    ).toThrow(
      /commits\.0\.components\.0\.parentId: parentId 1 does not name an earlier fiber/,
    );
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
              scripts: [
                { ...script, sourceLine: null, sourceColumn: null, ...projectedSplit },
              ],
            },
          ],
        },
      }),
    );
    return frame?.scripts[0];
  }

  it('is absent, not zero, when neither copy of the entry carries it', () => {
    const script = scriptOf(
      {},
      { forcedStyleDuration: null, forcedLayoutDuration: null },
    );

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

describe('a phase span’s originator', () => {
  function originatorOf(properties: Json) {
    const [span] = reactOf(
      runWith({
        react: {
          reactDevToolsHookInstalled: true,
          commits: [],
          measures: [
            {
              name: 'Update Blocked',
              startTime: 80,
              duration: 7,
              detail: { devtools: { properties } },
            },
          ],
        },
      }),
    ).spans;
    return span?.kind === 'phase' ? span.originator : undefined;
  }

  it('reads a method-only row as no component, not as a component named after the method', () => {
    // The shape of the corpus's `Update Blocked` span at mount.
    expect(originatorOf([['Method name', 'root.render()']])).toEqual({
      componentName: null,
      methodName: 'root.render()',
    });
  });

  it('reads both rows by label, whatever their order', () => {
    expect(
      originatorOf([
        ['Method name', 'setState()'],
        ['Component name', 'StateOwner'],
      ]),
    ).toEqual({ componentName: 'StateOwner', methodName: 'setState()' });
  });
});
