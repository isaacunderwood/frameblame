/**
 * The whole corpus, in one serial pass: `pnpm spike:corpus`.
 *
 * Every fixture, in both build modes, captured one at a time and promoted into
 * `corpus/<fixture>/<mode>/`. That directory is the engine's test input — the
 * point of steps 1 to 3 of the handoff is that `packages/core` can be handed a
 * real dump from disk and the matching `ground-truth.json` with no browser
 * anywhere in sight.
 *
 * Two things this is careful about, both of them `findings.md` corrections
 * rather than style:
 *
 * - **Strictly serial.** Each fixture binds a fixed port, so two captures at
 *   once fight over it; and even on different ports, two browsers sharing a
 *   CPU make every millisecond figure in both runs meaningless. There is no
 *   concurrency switch here on purpose.
 * - **A warm-up run that is captured and then not promoted.** The first run of
 *   a session behaves differently enough to mislead — 84ms frames against
 *   59-63ms once warm, and the cold run that opened the v0.1 spike produced a
 *   226ms frame with 14 of 21 samples carrying no JavaScript at all. Promoting
 *   it would put an outlier in the corpus; dropping it silently would hide
 *   that the corpus is warm-run data. So it is run, kept in `spike/out/`,
 *   named in the manifest, and left out of `corpus/`.
 *
 * What it does not do: decide anything about the dumps it collects. Validating
 * a run against a fixture's ground truth belongs to the accuracy suite, which
 * reads `corpus/` and never launches a browser.
 */

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRun, CPU_THROTTLE_RATE, type RunSummary } from './collect-run.ts';
import {
  type BuildMode,
  FIXTURES,
  type FixtureDefinition,
  fixtureById,
} from './fixtures.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_ROOT = resolve(REPO_ROOT, 'corpus');

/** Both modes, always. Production is not the weaker case — see `findings.md`. */
const MODES: readonly BuildMode[] = ['development', 'production'];

/**
 * The warm-up: the cheapest fixture, in the mode that needs no build.
 *
 * Its only job is to be first, so that nothing promoted into the corpus is.
 */
const WARM_UP_FIXTURE = 'derive-in-render';

interface PromotedRun extends RunSummary {
  /** Where in `corpus/` the run was copied to, repo-relative. */
  readonly corpusPath: string;
}

async function promote(
  summary: RunSummary,
  fixture: FixtureDefinition,
  mode: BuildMode,
): Promise<PromotedRun> {
  const destination = resolve(CORPUS_ROOT, fixture.id, mode);

  // `force` so a re-capture replaces an entry rather than failing, and
  // `recursive` because the run directory is a directory of files. The run it
  // came from stays in `spike/out/` either way, so a promotion is never the
  // only copy of anything.
  await mkdir(dirname(destination), { recursive: true });
  await cp(summary.runDir, destination, { recursive: true, force: true });

  return { ...summary, corpusPath: `corpus/${fixture.id}/${mode}` };
}

function describe(summary: RunSummary): string {
  return (
    `${summary.longFrames.toString()} frames, ` +
    `${summary.samples.toString()} samples, ` +
    `${summary.commits.toString()} commits, ` +
    `${summary.measures.toString()} measures, ` +
    `${summary.sourceWindows.toString()} windows` +
    (summary.unresolvedPositions > 0
      ? `, ${summary.unresolvedPositions.toString()} unresolved`
      : '') +
    (summary.actionsWithoutFrame > 0
      ? `, ${summary.actionsWithoutFrame.toString()} silent interactions`
      : '')
  );
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
  const fixtures =
    requested.length > 0
      ? FIXTURES.filter((fixture) => requested.includes(fixture.id))
      : FIXTURES;

  if (fixtures.length === 0) {
    throw new Error(`no fixture matched ${requested.join(', ')}`);
  }

  const skipWarmUp = process.argv.includes('--no-warm-up');
  const started = Date.now();

  let warmUp: RunSummary | null = null;
  if (!skipWarmUp) {
    console.log('\n=== warm-up (captured, not promoted) ===');
    warmUp = await collectRun({
      // Throws if the id is wrong, which is better than silently warming up
      // something else and reporting that the corpus is warm-run data.
      fixture: fixtureById(WARM_UP_FIXTURE),
      mode: 'development',
      installReactHook: true,
      enableSourceLineColumn: false,
    });
    console.log(`[warm-up] ${describe(warmUp)}`);
  }

  const promoted: PromotedRun[] = [];

  for (const fixture of fixtures) {
    for (const mode of MODES) {
      console.log(`\n=== ${fixture.id} (${mode}) ===`);
      console.log(`    ${fixture.summary}`);

      const summary = await collectRun({
        fixture,
        mode,
        installReactHook: true,
        enableSourceLineColumn: false,
      });

      console.log(`    ${describe(summary)}`);
      promoted.push(await promote(summary, fixture, mode));
    }
  }

  await mkdir(CORPUS_ROOT, { recursive: true });
  await writeFile(
    resolve(CORPUS_ROOT, 'manifest.json'),
    `${JSON.stringify(
      {
        $comment: [
          'What the corpus holds and how it was collected. Written by',
          'spike/capture-corpus.ts; edit the script, not this file.',
          '',
          'Every entry is one fixture in one build mode. The numbers here are',
          'counts of records, not measurements: the millisecond figures live in',
          'the run directories, each stamped with the build mode and CPU',
          'throttle rate that produced it.',
        ],
        capturedAt: new Date().toISOString(),
        cpuThrottleRate: CPU_THROTTLE_RATE,
        durationMs: Date.now() - started,
        warmUp:
          warmUp === null
            ? null
            : {
                $comment:
                  'Run first and deliberately not promoted: the first run of a ' +
                  'session behaves differently enough to mislead. Its dump is in ' +
                  'spike/out/ under the run id below if the difference is of interest.',
                ...warmUp,
              },
        runs: promoted,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n[corpus] ${promoted.length.toString()} run(s) in ${seconds}s`);
  for (const run of promoted) console.log(`[corpus] ${run.corpusPath}`);
}

await main();
