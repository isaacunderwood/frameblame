/**
 * One capture, from the command line: `pnpm spike:dump`.
 *
 * This is the script the v0.1 spike was. Its question — do Long Animation
 * Frames, the JS Self-Profiling API and React's commit callbacks line up well
 * enough to name the component and line behind a janky frame? — has been
 * answered, in `findings.md`, and the answer is yes with named limits. So its
 * job has changed: it no longer exists to decide whether the join holds, but to
 * produce one entry of the corpus the engine is tested against, reproducibly
 * and without overwriting the last one.
 *
 * Everything it used to do inline now lives in a module beside it, and this
 * file is only the command-line face of `collectRun`: which fixture, which
 * build mode, which of the two diagnostic knobs. The capture itself is
 * `spike/collect-run.ts`; the whole corpus is `spike/capture-corpus.ts`.
 *
 * Usage:
 *
 * ```
 * pnpm spike:dump                                 # derive-in-render, development
 * pnpm spike:dump spans production                # any fixture, either mode
 * SPIKE_SKIP_REACT_HOOK=1 pnpm spike:dump         # is React's measure hook-independent?
 * SPIKE_SOURCE_LINE_COLUMN=1 pnpm spike:dump      # what the Blink flag would add
 * ```
 *
 * Never run two captures at once, in two terminals or two agents. Each fixture
 * binds a fixed port and they will fight over it, and even where they do not,
 * two browsers burning the same CPU make every millisecond figure in both runs
 * meaningless.
 */

import { collectRun, describeRunSummary } from './collect-run.ts';
import { type BuildMode, FIXTURES, fixtureById } from './fixtures.ts';

/** Parses the mode argument, defaulting to development. */
function parseMode(value: string | undefined): BuildMode {
  if (value === undefined || value === 'development' || value === 'dev') {
    return 'development';
  }
  if (value === 'production' || value === 'prod') return 'production';
  throw new Error(
    `unknown build mode ${JSON.stringify(value)}; use development or production`,
  );
}

async function main(): Promise<void> {
  const [fixtureArg, modeArg] = process.argv.slice(2);

  const fixture = fixtureById(
    fixtureArg ?? process.env.SPIKE_FIXTURE ?? 'derive-in-render',
  );
  const mode = parseMode(modeArg ?? process.env.SPIKE_MODE);

  console.log(`[spike] ${fixture.id} (${mode}) — ${fixture.summary}`);

  const summary = await collectRun({
    fixture,
    mode,
    installReactHook: process.env.SPIKE_SKIP_REACT_HOOK !== '1',
    enableSourceLineColumn: process.env.SPIKE_SOURCE_LINE_COLUMN === '1',
  });

  console.log(`[spike] ${describeRunSummary(summary)}`);
  console.log(`[spike] wrote ${summary.runDir}`);
}

if (process.argv.includes('--list')) {
  for (const fixture of FIXTURES) console.log(`${fixture.id}\t${fixture.summary}`);
} else {
  await main();
}
