/**
 * Getting a fixture served, in either build mode, and torn down again.
 *
 * Both modes go through the fixture's own package scripts rather than through a
 * server written here: `vite` for development and `vite build` plus
 * `vite preview` for production. That is deliberate. The one piece of
 * configuration the whole tool depends on is the `Document-Policy: js-profiling`
 * response header — without it `window.Profiler` does not exist and the deep
 * signal is simply absent — and each fixture's `vite.config` sets that header
 * for both `server` and `preview`. A bespoke static server here would be a
 * second place for that header to be wrong, and the spike's own archive shows
 * how that goes: `spike/archive/probe.ts` carries its own static server with
 * its own copy of the header.
 *
 * This module knows nothing about profiling, attribution or what a fixture
 * does. It starts a process, waits for an HTTP answer, and kills the process
 * group on the way out.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type BuildMode, type FixtureDefinition, urlFor } from './fixtures.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How long a dev server, a production build or a preview server may take. */
const SERVER_READY_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 180_000;

export interface ServedFixture {
  readonly url: string;
  /** Whatever the server sent as `Document-Policy`, for the run envelope. */
  readonly documentPolicy: string | null;
  stop(): void;
}

/**
 * Spawns a workspace package script in its own process group.
 *
 * The process group matters: Vite spawns children, and killing only the
 * `pnpm` process leaves one of them holding the port. The next capture then
 * fails on a port clash that reads as a bug in the spike rather than as a
 * leaked process from the run before.
 */
function spawnPackageScript(packageName: string, script: string): ChildProcess {
  return spawn('pnpm', ['--filter', packageName, script], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** SIGTERMs the whole process group, tolerating a process that already died. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid addresses the group, which `detached` created.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone, which is the outcome we wanted anyway.
  }
}

/**
 * Runs a package script to completion, rejecting on a non-zero exit.
 *
 * Used for the production build. Its output is forwarded rather than captured,
 * because a build that fails for an ordinary reason — a type error in a fixture
 * — should read as a build failure in the terminal and not as a timeout inside
 * the spike.
 */
async function runPackageScript(packageName: string, script: string): Promise<void> {
  const child = spawnPackageScript(packageName, script);
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[${script}] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[${script}] ${chunk.toString()}`);
  });

  await new Promise<void>((settle, fail) => {
    const timer = setTimeout(() => {
      killGroup(child);
      fail(new Error(`\`${packageName} ${script}\` did not finish in time`));
    }, BUILD_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) settle();
      else
        fail(new Error(`\`${packageName} ${script}\` exited with code ${String(code)}`));
    });
  });
}

/**
 * Starts a long-running server script and resolves once the URL answers.
 *
 * Two failure modes are distinguished rather than collapsed into one timeout.
 * A server that *exits* — the usual cause being Vite's `strictPort` refusing a
 * port another run left occupied — fails immediately with whatever it wrote to
 * stderr, because waiting ninety seconds for a process that is already dead is
 * exactly the hour the handoff warns about losing. A server that stays up but
 * never answers times out.
 */
async function startServer(
  packageName: string,
  script: string,
  url: string,
): Promise<ServedFixture> {
  const child = spawnPackageScript(packageName, script);

  /*
   * Held in an object rather than two `let`s so that the compiler does not
   * narrow them to their initial values: the only writer is a callback the
   * control flow analysis cannot see, which makes a plain `let exitCode = null`
   * look permanently null and the check below look like dead code.
   */
  const observed: { stderr: string; exitCode: number | null } = {
    stderr: '',
    exitCode: null,
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    observed.stderr += chunk.toString();
    process.stderr.write(`[${script}] ${chunk.toString()}`);
  });
  child.on('exit', (code) => {
    observed.exitCode = code;
  });

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (observed.exitCode !== null) {
      throw new Error(
        `\`${packageName} ${script}\` exited with code ${String(observed.exitCode)} before ` +
          `answering at ${url}. A port clash with a leaked server from an earlier ` +
          `run is the usual cause.\n${observed.stderr}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return {
          url,
          documentPolicy: response.headers.get('document-policy'),
          stop: () => {
            killGroup(child);
          },
        };
      }
    } catch {
      // Not listening yet; the loop is the wait.
    }

    await new Promise((done) => setTimeout(done, 250));
  }

  killGroup(child);
  throw new Error(`\`${packageName} ${script}\` did not answer at ${url} in time`);
}

/**
 * Serves one fixture in one build mode and resolves once it answers.
 *
 * In production mode the fixture is rebuilt first, every time, rather than
 * reusing whatever is in `dist/`. A stale `dist` is the one failure that would
 * not announce itself: the capture would succeed, the dump would look complete,
 * and its positions would resolve through a source map describing code that is
 * no longer in the repo.
 *
 * The caller owns the returned handle and must call `stop()`.
 */
export async function serveFixture(
  fixture: FixtureDefinition,
  mode: BuildMode,
): Promise<ServedFixture> {
  const url = urlFor(fixture, mode);

  if (mode === 'production') {
    await runPackageScript(fixture.packageName, 'build');
    return await startServer(fixture.packageName, 'preview', url);
  }

  return await startServer(fixture.packageName, 'dev', url);
}
