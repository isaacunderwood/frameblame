/**
 * One capture: serve a fixture, drive it, and write everything the browser said
 * to a run directory.
 *
 * This is the v0.1 spike's `main` grown into something a corpus can be built
 * from. It still does no attribution, no correlation and no scoring — the point
 * is to record what the three signals actually contained, so the engine's
 * record types can be derived from dumps rather than from specifications that
 * describe fields Chrome does not ship.
 *
 * Three things changed from the snapshot version, all of them open items at the
 * bottom of `findings.md`:
 *
 * 1. **A timestamped run directory per capture**, rather than overwriting one
 *    output directory. Overwriting is how the cold run's evidence was lost —
 *    the 226ms frame with 14 of 21 samples carrying no JavaScript, which
 *    `findings.md` still cites and can no longer re-derive from any file in the
 *    repo.
 * 2. **A drive plan per fixture**, so a replay of many interactions is the
 *    normal case. One frame yields five to seven samples; replay is what turns
 *    a ranked guess into a stable distribution, which makes it a core
 *    mechanism rather than a nicety.
 * 3. **A window of served text around every attributed position**, so the
 *    resolution chain can be re-derived with no server running.
 *
 * What it deliberately does not do: interpret anything, write to a shared
 * location, or reuse a browser or server between runs. Each capture is
 * independent, because a corpus whose entries can influence each other is not a
 * corpus.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from '@playwright/test';

import {
  installCollectors,
  MAX_PROFILE_SAMPLES,
  REQUESTED_SAMPLE_INTERVAL_MS,
  SOURCE_LINE_COLUMN_FEATURES,
} from './collectors.ts';
import { drive, type StepRecord } from './drive.ts';
import { type BuildMode, type FixtureDefinition } from './fixtures.ts';
import { captureResources } from './resources.ts';
import { serveFixture } from './servers.ts';
import { collectSourceWindows, loafScriptUrls } from './source-windows.ts';

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));

/** Where run directories are created, one per capture. */
export const RUNS_ROOT = resolve(SPIKE_DIR, 'out');

/**
 * 4x, applied through CDP because Playwright has no API for it.
 *
 * Lighthouse's mobile default, and so the one throttle rate a reader might
 * already have intuition for. It travels in the envelope of every file this
 * writes: a millisecond figure without the build mode and the throttle rate
 * that produced it is indefensible, and these files will outlive the terminal
 * that printed them.
 *
 * Worth knowing when reading a dump: it does not scale every fixture equally.
 * `derive-in-render`'s cost is real computation and scales with the rate, while
 * the vanilla fixtures burn a fixed number of wall-clock milliseconds in a
 * busy-wait and do not. Each fixture's `ground-truth.json` says which it is.
 */
export const CPU_THROTTLE_RATE = 4;

export interface RunOptions {
  readonly fixture: FixtureDefinition;
  readonly mode: BuildMode;
  /** Install React's DevTools global hook. `SPIKE_SKIP_REACT_HOOK=1` turns it off. */
  readonly installReactHook: boolean;
  /** Enable the Blink features that populate LoAF's `sourceLine`/`sourceColumn`. */
  readonly enableSourceLineColumn: boolean;
  /** Defaults to `RUNS_ROOT`. */
  readonly runsRoot?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly runDir: string;
  readonly fixture: string;
  readonly mode: BuildMode;
  readonly longFrames: number;
  readonly samples: number;
  readonly commits: number;
  readonly measures: number;
  readonly sourceWindows: number;
  readonly unresolvedPositions: number;
  /** Actions that produced no long frame — see `ActionRecord.sawNewFrame`. */
  readonly actionsWithoutFrame: number;
}

/**
 * A run's summary as one line of counts, for the console.
 *
 * Shared by `pnpm spike:dump` and `pnpm spike:corpus`, which print the same
 * thing after every capture. These are counts of records rather than
 * measurements, so no build mode or throttle rate needs to travel with them.
 * Unresolved positions and interactions that produced no long frame are named
 * only when there are some.
 */
export function describeRunSummary(summary: RunSummary): string {
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

/** What the page hands back once the drive is finished. */
interface CollectedStreams {
  loaf: unknown[];
  commits: unknown[];
  measures: unknown[];
  profilerAvailable: boolean;
  timeOrigin: number;
  /** Whatever the fixture published about itself; null for most fixtures. */
  fixtureProbe: unknown;
}

/** What `stopProfile` resolves to, as it crosses out of the page. */
interface CollectedProfile {
  trace: ProfilerTrace | null;
  requestedSampleInterval: number;
  effectiveSampleInterval: number | null;
  startedAt: number;
  stoppedAt: number;
}

/**
 * A directory name that sorts chronologically and says what it holds.
 *
 * Colons are legal in a POSIX path but make a directory awkward to address from
 * a shell and illegal on Windows, so the ISO timestamp is punctuated with
 * hyphens instead.
 */
function runDirectoryName(fixture: FixtureDefinition, mode: BuildMode): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}__${fixture.id}__${mode}`;
}

/** How the build mode is quoted in the envelope and in any figure from it. */
function describeBuildMode(mode: BuildMode): string {
  return mode === 'production'
    ? 'production (vite build, sourcemap: true, served by vite preview)'
    : 'development (vite dev server)';
}

/**
 * Serves one fixture in one build mode, drives its plan, and writes the run.
 *
 * Returns a summary of what was collected. Throws if `window.Profiler` is
 * absent, which means the document was served without
 * `Document-Policy: js-profiling` and the deep signal — the only signal that
 * can see a component — cannot be collected at all. Failing loudly matters
 * here: the degraded tier is a legitimate runtime state for the *tool*, but a
 * corpus entry collected without the profiler would silently be evidence for
 * much less than it appears to be.
 *
 * All page-side timestamps in the output are `performance.now()` milliseconds
 * relative to the page's `timeOrigin`, which is recorded with them.
 */
export async function collectRun(options: RunOptions): Promise<RunSummary> {
  const { fixture, mode, installReactHook, enableSourceLineColumn } = options;
  const runId = runDirectoryName(fixture, mode);
  const runDir = resolve(options.runsRoot ?? RUNS_ROOT, runId);

  const served = await serveFixture(fixture, mode);
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      // Headed: the headless shell does not drive a real compositor, and a
      // signal about animation frames collected without one is not evidence.
      headless: false,
      args: enableSourceLineColumn
        ? [`--enable-blink-features=${SOURCE_LINE_COLUMN_FEATURES.join(',')}`]
        : [],
    });

    const page = await browser.newPage();
    await installCollectors(page, {
      installReactHook,
      profileFromLoad: fixture.capturesFirstMount,
      sampleInterval: REQUESTED_SAMPLE_INTERVAL_MS,
      maxBufferSize: MAX_PROFILE_SAMPLES,
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE_RATE });

    await page.goto(served.url, { waitUntil: 'load' });
    await page.locator(fixture.readySelector).waitFor({ state: 'visible' });

    const profilerAvailable = await page.evaluate(
      () => window.__frameblameSpike__?.profilerAvailable ?? false,
    );
    if (!profilerAvailable) {
      throw new Error(
        `window.Profiler is absent at ${served.url} — the document was not served ` +
          `with Document-Policy: js-profiling (it sent ${
            served.documentPolicy ?? '(no such header)'
          }), so the deep signal cannot be collected.`,
      );
    }

    /*
     * Load-time records are dropped and the profiler started here, which is
     * right for every fixture whose claim is about an interaction: module
     * evaluation and first paint are not what is being studied, and leaving
     * them in makes every file harder to read.
     *
     * A fixture that declares a claim about the first mount gets neither. Its
     * profiler was constructed in the init script, before the document's own
     * scripts ran, and clearing the buffers here would throw away the very
     * frames and commits it exists to record. See `capturesFirstMount`.
     */
    if (!fixture.capturesFirstMount) {
      await page.evaluate(() => {
        window.__frameblameSpike__?.reset();
      });

      await page.evaluate(
        ([sampleInterval, maxBufferSize]) => {
          window.__frameblameSpike__?.startProfile(
            sampleInterval ?? 5,
            maxBufferSize ?? 0,
          );
        },
        [REQUESTED_SAMPLE_INTERVAL_MS, MAX_PROFILE_SAMPLES],
      );
    }

    const driveStartedAt = await page.evaluate(
      () => window.__frameblameSpike__?.mark('frameblame:drive-start') ?? 0,
    );
    const steps: StepRecord[] = await drive(page, fixture);
    const driveFinishedAt = await page.evaluate(
      () => window.__frameblameSpike__?.mark('frameblame:drive-end') ?? 0,
    );

    const profile = await page.evaluate(
      async (): Promise<CollectedProfile | undefined> =>
        await window.__frameblameSpike__?.stopProfile(),
    );

    const streams = await page.evaluate((): CollectedStreams => {
      const collector = window.__frameblameSpike__;
      return {
        loaf: collector?.loaf ?? [],
        commits: collector?.commits ?? [],
        measures: collector?.measures ?? [],
        profilerAvailable: collector?.profilerAvailable ?? false,
        timeOrigin: collector?.timeOrigin ?? 0,
        fixtureProbe: collector?.fixtureProbe() ?? null,
      };
    });

    /*
     * Fetched now, before anything else touches the page, and from inside it:
     * see `spike/resources.ts` on why the same origin and cache state matter.
     * The union of both signals' URLs is captured, since neither list contains
     * the other.
     */
    const trace = profile?.trace ?? null;
    const resourceUrls = new Set<string>([
      ...(trace?.resources ?? []),
      ...loafScriptUrls(streams.loaf),
    ]);
    const resources = await captureResources(page, [...resourceUrls]);
    const sourceWindows = collectSourceWindows(trace, streams.loaf, resources.texts);

    /**
     * Repeated in every file of the run. A millisecond figure without the build
     * mode and the throttle rate that produced it is indefensible, and these
     * files are meant to be read one at a time, years later, by someone who
     * does not have the others open.
     */
    const envelope = {
      runId,
      fixture: fixture.id,
      mode,
      buildMode: describeBuildMode(mode),
      url: served.url,
      documentPolicy: served.documentPolicy,
      cpuThrottleRate: CPU_THROTTLE_RATE,
      browser: `chromium ${browser.version()}`,
      sourceLineColumnFeaturesEnabled: enableSourceLineColumn,
      reactDevToolsHookInstalled: installReactHook,
      collectedAt: new Date().toISOString(),
      clock: {
        note:
          'All page-side timestamps are performance.now() milliseconds relative ' +
          'to timeOrigin. The profiler samples share this clock: the first sample ' +
          'lands 0.1-0.9ms after the reading taken immediately before the Profiler ' +
          'was constructed (v0.3 re-capture, 4x, both build modes; 0.0-0.7ms in the ' +
          'capture before), so no reconciliation is needed. See findings.md.',
        timeOrigin: streams.timeOrigin,
        driveStartedAt,
        driveFinishedAt,
      },
    };

    const actionsWithoutFrame = steps.reduce(
      (total, step) =>
        total + step.actions.filter((action) => !action.sawNewFrame).length,
      0,
    );

    const summary: RunSummary = {
      runId,
      runDir,
      fixture: fixture.id,
      mode,
      longFrames: streams.loaf.length,
      samples: trace?.samples.length ?? 0,
      commits: streams.commits.length,
      measures: streams.measures.length,
      sourceWindows: sourceWindows.windows.length,
      unresolvedPositions: sourceWindows.unresolved.length,
      actionsWithoutFrame,
    };

    await mkdir(runDir, { recursive: true });

    const files: readonly [string, unknown][] = [
      // The file to read first: what was run, what it produced, and which
      // interaction each frame belonged to.
      [
        'run.json',
        {
          ...envelope,
          summary,
          plan: fixture.drive,
          steps,
          sampling: {
            requestedSampleIntervalMs: profile?.requestedSampleInterval ?? null,
            effectiveSampleIntervalMs: profile?.effectiveSampleInterval ?? null,
            maxBufferSize: MAX_PROFILE_SAMPLES,
            note:
              'Chrome clamps the sampling period upward to a compile-time floor ' +
              'of 10ms (16 on Windows) that no flag reads, so a request of 5 is ' +
              'answered with 10. The median cadence that gives is a property of the ' +
              'session rather than a constant: 14.5ms in the v0.3 re-capture, ' +
              '12.2ms in the capture before it, on the same machine and settings ' +
              '(4x, both build modes).',
          },
          profilerWindow: {
            startedAt: profile?.startedAt ?? null,
            stoppedAt: profile?.stoppedAt ?? null,
          },
        },
      ],
      [
        'loaf.json',
        {
          ...envelope,
          /*
           * Stored beside the frames rather than in its own file, because what
           * a fixture publishes about itself is only meaningful against the
           * frames it describes — `innerhtml-rebuild`'s probe records how late
           * a task posted at the end of its listener was delivered, which is
           * the difference between the frame's residual being work and being
           * idle. Verbatim and uninterpreted; see the fixture's ground truth.
           */
          fixtureProbe: streams.fixtureProbe,
          entries: streams.loaf,
        },
      ],
      [
        'profile.json',
        { ...envelope, profile: profile ?? null, resourceSources: resources.sources },
      ],
      [
        'react-commits.json',
        { ...envelope, commits: streams.commits, measures: streams.measures },
      ],
      [
        'source-windows.json',
        {
          ...envelope,
          note:
            'A window of the text each script actually served, around every ' +
            'position the signals attributed work to. This is the middle link of ' +
            "findings.md's resolution chain, which the v0.1 dumps could not " +
            "reproduce because they stored each script's length but not its text.",
          byResource: sourceWindows.byResource,
          unresolved: sourceWindows.unresolved,
          windows: sourceWindows.windows,
        },
      ],
    ];

    for (const [name, content] of files) {
      await writeFile(
        resolve(runDir, name),
        `${JSON.stringify(content, null, 2)}\n`,
        'utf8',
      );
    }

    return summary;
  } finally {
    await browser?.close();
    served.stop();
  }
}
