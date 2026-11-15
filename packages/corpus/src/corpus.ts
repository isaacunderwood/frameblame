/**
 * Reading the captured corpus off disk.
 *
 * This is the impure edge of the project, and it exists so that `packages/core`
 * never needs one. The engine takes signal records and returns attributions; it
 * has no clock, no DOM and no I/O. Something still has to open a run directory,
 * so that something is here, in its own package, with `node` in its `types` and
 * `core`'s deliberately absent.
 *
 * What it does *not* do is define the engine's record types. The dumps are the
 * evidence those types will be derived from — the specifications describe
 * fields Chrome does not ship, and omit behaviour it has — and deciding their
 * shape here, in a loader, would be deciding it in the wrong place. So the
 * accessors below narrow only as far as reading the corpus requires, and
 * anything beyond that is handed back as parsed JSON for a caller to interpret.
 *
 * The corpus itself is written by `pnpm spike:corpus`. See `corpus/README.md`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isJsonRecord, type Json } from './json.ts';

/*
 * Re-exported so that `Json` can be imported from either module. It is defined
 * in `json.ts` because it is a property of JSON rather than of this corpus, and
 * because the guards that keep it from decaying into `any` live beside it.
 */
export type { Json };

/** Repo root, four levels up from this file's directory at `packages/corpus/src`. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const CORPUS_ROOT = resolve(REPO_ROOT, 'corpus');
export const FIXTURES_ROOT = resolve(REPO_ROOT, 'fixtures');

/** Both modes are always captured. Production is not the weaker case. */
export type BuildMode = 'development' | 'production';

export const BUILD_MODES: readonly BuildMode[] = ['development', 'production'];

/** The five files `collectRun` writes, by the key they are loaded under. */
const RUN_FILES = {
  run: 'run.json',
  loaf: 'loaf.json',
  profile: 'profile.json',
  react: 'react-commits.json',
  sourceWindows: 'source-windows.json',
} as const;

export type RunFileKey = keyof typeof RUN_FILES;

export interface CorpusRun {
  readonly fixture: string;
  readonly mode: BuildMode;
  /** Absolute path to the run directory inside `corpus/`. */
  readonly dir: string;
  /** The five files, parsed. */
  readonly files: Readonly<Record<RunFileKey, Json>>;
}

/**
 * The envelope every file of a run carries.
 *
 * Duplicated across the five files on purpose, so that one of them read alone,
 * years later, still says which build and which throttle rate produced its
 * numbers. Narrowed here because the corpus's own consistency check is the one
 * thing that must read it before anything else is trusted.
 */
export interface RunEnvelope {
  readonly runId: string;
  readonly fixture: string;
  readonly mode: string;
  readonly buildMode: string;
  readonly cpuThrottleRate: number;
  readonly browser: string;
  readonly collectedAt: string;
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

/**
 * Every fixture in the repo, by directory name.
 *
 * Derived from the filesystem — a directory under `fixtures/` with a
 * `ground-truth.json` in it — rather than from a list kept somewhere. A fixture
 * added without a ground truth is not a fixture, and a fixture with one that
 * the corpus does not cover should fail a test rather than be invisible to it.
 */
export function listFixtures(): string[] {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(resolve(FIXTURES_ROOT, entry.name, 'ground-truth.json')),
    )
    .map((entry) => entry.name)
    .sort();
}

/** A fixture's declared contract, parsed. */
export function loadGroundTruth(fixture: string): Json {
  return readJson(resolve(FIXTURES_ROOT, fixture, 'ground-truth.json'));
}

/** Whether a fixture and mode were captured into the corpus. */
export function hasCorpusRun(fixture: string, mode: BuildMode): boolean {
  return existsSync(resolve(CORPUS_ROOT, fixture, mode, RUN_FILES.run));
}

/**
 * Loads one captured run: all five files, parsed, with no interpretation.
 *
 * Throws if the directory or any of the five files is missing, because a
 * partial run is worse than an absent one — it would let a test pass on the
 * strength of whichever half happened to be there.
 */
export function loadCorpusRun(fixture: string, mode: BuildMode): CorpusRun {
  const dir = resolve(CORPUS_ROOT, fixture, mode);

  const files = {} as Record<RunFileKey, Json>;
  for (const [key, name] of Object.entries(RUN_FILES)) {
    const path = resolve(dir, name);
    if (!existsSync(path)) {
      throw new Error(
        `corpus run ${fixture}/${mode} is missing ${name}. ` +
          'Recapture it with `pnpm spike:corpus ' +
          `${fixture}\`.`,
      );
    }
    files[key as RunFileKey] = readJson(path);
  }

  return { fixture, mode, dir, files };
}

/** Every run the corpus holds, in fixture then mode order. */
export function loadCorpus(): CorpusRun[] {
  const runs: CorpusRun[] = [];
  for (const fixture of listFixtures()) {
    for (const mode of BUILD_MODES) {
      if (hasCorpusRun(fixture, mode)) runs.push(loadCorpusRun(fixture, mode));
    }
  }
  return runs;
}

/**
 * The envelope of one file of a run, or throws naming what was wrong.
 *
 * Every millisecond figure in the corpus is meaningless without the build mode
 * and throttle rate, so a file that cannot produce them is treated as broken
 * rather than as merely incomplete.
 */
export function envelopeOf(run: CorpusRun, key: RunFileKey): RunEnvelope {
  const file = run.files[key];
  if (!isJsonRecord(file)) {
    throw new Error(`${run.fixture}/${run.mode}: ${RUN_FILES[key]} is not an object`);
  }

  const { runId, fixture, mode, buildMode, cpuThrottleRate, browser, collectedAt } = file;
  if (
    typeof runId !== 'string' ||
    typeof fixture !== 'string' ||
    typeof mode !== 'string' ||
    typeof buildMode !== 'string' ||
    typeof cpuThrottleRate !== 'number' ||
    typeof browser !== 'string' ||
    typeof collectedAt !== 'string'
  ) {
    throw new Error(
      `${run.fixture}/${run.mode}: ${RUN_FILES[key]} has no complete envelope — ` +
        'it cannot say which build and throttle rate produced its numbers',
    );
  }

  return { runId, fixture, mode, buildMode, cpuThrottleRate, browser, collectedAt };
}

/**
 * Reads a repo-relative file as text.
 *
 * Used for two things, and both matter. Ground truths anchor every line number
 * they declare to the text that should be on that line, so a drifted fixture
 * fails as a broken fixture rather than as a wrong attribution. And the vanilla
 * fixtures serve their scripts out of `public/`, byte-identically in both build
 * modes, which makes the repo's own copy the served text — so a LoAF character
 * offset from a dump can be resolved against it with no capture of the text at
 * all.
 */
export function readRepoFile(repoRelativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');
}

export function repoPath(repoRelativePath: string): string {
  return resolve(REPO_ROOT, repoRelativePath);
}
