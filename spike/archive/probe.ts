/**
 * Adversarial-review probe. Scratchpad only; does not touch the repo.
 *
 * Differences from spike/dump-raw-streams.ts:
 *  - replays N keystrokes so sample statistics can be aggregated (item 2)
 *  - captures every LoAF field Chrome serialises, per frame (item 5)
 *  - captures `measure` entries including `detail` (selective-span question)
 *  - can run against the production build served statically (item 6)
 *  - can start K concurrent Profiler instances (item 2)
 *
 * env:
 *   PROBE_MODE=dev|prod            default dev
 *   PROBE_PRESSES=20               keystroke pairs ('n' then Backspace)
 *   PROBE_INTERVAL=5               requested profiler sampleInterval ms
 *   PROBE_PROFILERS=1              how many concurrent Profiler instances
 *   PROBE_THROTTLE=4               CDP CPU throttle rate
 *   PROBE_HOOK=1                   install the React DevTools hook
 *   PROBE_OUT=<path>               output json
 *   PROBE_BLINK=1                  --enable-blink-features for LoAF source line/col
 *   PROBE_EXTRA_ARGS=a,b           extra chromium args
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { chromium, type Browser, type Page } from '@playwright/test';

const REPO_ROOT = '/Users/isaacunderwood/frontend_perf_mcp';
const DIST_DIR = join(REPO_ROOT, 'fixtures/derive-in-render/dist');
const FILTER_INPUT = '[data-fixture="filter-input"]';

const MODE = process.env.PROBE_MODE === 'prod' ? 'prod' : 'dev';
const PRESSES = Number(process.env.PROBE_PRESSES ?? 20);
const REQUESTED_INTERVAL = Number(process.env.PROBE_INTERVAL ?? 5);
const PROFILERS = Number(process.env.PROBE_PROFILERS ?? 1);
const THROTTLE = Number(process.env.PROBE_THROTTLE ?? 4);
const INSTALL_HOOK = process.env.PROBE_HOOK !== '0';
const DEV_URL = 'http://localhost:5181/';
const PROD_PORT = 5183;
const PROD_URL = `http://localhost:${String(PROD_PORT)}/`;
const URL_UNDER_TEST = MODE === 'prod' ? PROD_URL : DEV_URL;
const OUT = process.env.PROBE_OUT ?? `/tmp/probe-${MODE}.json`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Static server for the already-built dist, with the profiling policy header. */
function startProdServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST_DIR, rel);
    void stat(file).then(
      () => {
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Document-Policy': 'js-profiling',
          'Cache-Control': 'no-store',
        });
        createReadStream(file).pipe(res);
      },
      () => {
        res.writeHead(404, { 'Document-Policy': 'js-profiling' });
        res.end('not found');
      },
    );
  });
  return new Promise((done) => {
    server.listen(PROD_PORT, () => {
      done(server);
    });
  });
}

async function startDevServer(): Promise<ChildProcess> {
  const server = spawn('pnpm', ['--filter', '@frameblame/fixture-derive-in-render', 'dev'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (c: Buffer) => process.stderr.write(`[fixture] ${c.toString()}`));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(DEV_URL);
      if (r.ok) return server;
    } catch {
      /* not up yet */
    }
    await new Promise((d) => setTimeout(d, 250));
  }
  throw new Error('dev server never answered');
}

async function installCollectors(page: Page, withHook: boolean, profilerCount: number) {
  await page.addInitScript(
    ([installHook, nProfilers]: [boolean, number]) => {
      const loaf: unknown[] = [];
      const commits: unknown[] = [];
      const measures: unknown[] = [];
      const profilers: Profiler[] = [];
      let startedAt = 0;

      function componentName(type: unknown): string | null {
        if (typeof type === 'function') {
          const c = type as { displayName?: unknown; name?: unknown };
          if (typeof c.displayName === 'string') return c.displayName;
          if (typeof c.name === 'string' && c.name !== '') return c.name;
          return '(anonymous)';
        }
        if (typeof type === 'object' && type !== null) {
          const w = type as { displayName?: unknown; render?: unknown; type?: unknown };
          if (typeof w.displayName === 'string') return w.displayName;
          if (w.render !== undefined) return componentName(w.render);
          if (w.type !== undefined) return componentName(w.type);
        }
        return null;
      }

      function describeCommit(root: ReactFiberRoot): unknown[] {
        const out: unknown[] = [];
        const pending: ReactFiber[] = [];
        if (root.current) pending.push(root.current);
        let visited = 0;
        while (pending.length > 0 && visited < 10_000) {
          const fiber = pending.pop();
          if (!fiber) break;
          visited += 1;
          const name = componentName(fiber.type);
          if (name !== null) {
            out.push({
              name,
              tag: fiber.tag,
              actualDuration: fiber.actualDuration ?? null,
              selfBaseDuration: fiber.selfBaseDuration ?? null,
              treeBaseDuration:
                (fiber as unknown as { treeBaseDuration?: number }).treeBaseDuration ?? null,
            });
          }
          if (fiber.child) pending.push(fiber.child);
          if (fiber.sibling) pending.push(fiber.sibling);
        }
        return out;
      }

      if (installHook) {
        const renderers = new Map<number, unknown>();
        let next = 1;
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          renderers,
          checkDCE() {},
          inject(renderer) {
            const id = next;
            next += 1;
            renderers.set(id, renderer);
            return id;
          },
          onCommitFiberRoot(rendererId, root, priorityLevel, didError) {
            const committedAt = performance.now();
            commits.push({
              committedAt,
              rendererId,
              didError,
              priorityLevel: typeof priorityLevel === 'number' ? priorityLevel : null,
              components: describeCommit(root),
            });
          },
          onPostCommitFiberRoot() {},
          onCommitFiberUnmount() {},
          on() {},
          off() {},
          sub() {
            return () => {};
          },
          emit() {},
        };
      }

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const frame = entry as PerformanceLongAnimationFrameTiming;
          const scripts = Array.from(frame.scripts, (s) => ({
            ...(s.toJSON() as Record<string, unknown>),
            sourceLine: s.sourceLine ?? null,
            sourceColumn: s.sourceColumn ?? null,
          }));
          loaf.push({ ...(entry.toJSON() as Record<string, unknown>), scripts });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const measure = entry as PerformanceMeasure;
          let detail: unknown = null;
          try {
            detail = JSON.parse(JSON.stringify(measure.detail ?? null));
          } catch {
            detail = '<unserialisable>';
          }
          measures.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            detail,
          });
        }
      }).observe({ type: 'measure', buffered: true });

      window.__probe__ = {
        profilerAvailable: typeof Profiler === 'function',
        loaf,
        commits,
        measures,
        startProfile(sampleInterval: number, maxBufferSize: number) {
          startedAt = performance.now();
          for (let i = 0; i < nProfilers; i += 1) {
            profilers.push(new Profiler({ sampleInterval, maxBufferSize }));
          }
        },
        async stopProfile() {
          const traces = [];
          for (const p of profilers) {
            traces.push({ effectiveSampleInterval: p.sampleInterval, trace: await p.stop() });
          }
          return { traces, startedAt, stoppedAt: performance.now() };
        },
        now() {
          return performance.now();
        },
        reset() {
          loaf.splice(0);
          commits.splice(0);
          measures.splice(0);
        },
      };
    },
    [withHook, profilerCount] as [boolean, number],
  );
}

/** Follows inline *and* external sourceMappingURL annotations. */
async function captureResourceSources(page: Page, urls: readonly string[]) {
  return await page.evaluate(async (resourceUrls: string[]) => {
    const sources: Record<string, unknown> = {};
    for (const url of resourceUrls) {
      try {
        const text = await (await fetch(url)).text();
        const annotation = /\/\/# sourceMappingURL=(\S+)/.exec(text);
        let sourceMap: unknown = null;
        const inline =
          /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/.exec(
            text,
          );
        if (inline?.[1] !== undefined) {
          const bytes = Uint8Array.from(atob(inline[1]), (c) => c.charCodeAt(0));
          sourceMap = JSON.parse(new TextDecoder().decode(bytes));
        } else if (annotation?.[1] !== undefined) {
          const mapUrl = new URL(annotation[1], url).href;
          sourceMap = await (await fetch(mapUrl)).json();
        }
        sources[url] = { length: text.length, sourceMap, text: text.length < 4_000_000 ? text : null };
      } catch (error) {
        sources[url] = { length: -1, sourceMap: null, text: null, error: String(error) };
      }
    }
    return sources;
  }, [...urls]);
}

async function main(): Promise<void> {
  let devServer: ChildProcess | undefined;
  let prodServer: Server | undefined;
  if (MODE === 'prod') prodServer = await startProdServer();
  else devServer = await startDevServer();

  let browser: Browser | undefined;
  try {
    const args = process.env.PROBE_BLINK === '1'
      ? ['--enable-blink-features=LongAnimationFrameSourceLineColumn,LongAnimationFrameSourceLineColumnInterface']
      : [];
    if (process.env.PROBE_EXTRA_ARGS) args.push(...process.env.PROBE_EXTRA_ARGS.split(','));
    browser = await chromium.launch({ headless: false, args });

    const page = await browser.newPage();
    await installCollectors(page, INSTALL_HOOK, PROFILERS);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

    await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
    await page.locator(FILTER_INPUT).waitFor({ state: 'visible' });

    const profilerAvailable = await page.evaluate(
      () => window.__probe__?.profilerAvailable ?? false,
    );
    if (!profilerAvailable) throw new Error('window.Profiler absent');

    await page.evaluate(() => {
      window.__probe__?.reset();
    });
    await page.evaluate(
      ([i, m]) => {
        window.__probe__?.startProfile(i ?? 5, m ?? 0);
      },
      [REQUESTED_INTERVAL, 400_000],
    );

    // Replay: 'n' then Backspace, so every press re-runs the full derive and
    // the query oscillates between two states rather than shrinking to nothing.
    const presses: { index: number; key: string; queryLength: number; at: number }[] = [];
    for (let i = 0; i < PRESSES; i += 1) {
      const key = i % 2 === 0 ? 'n' : 'Backspace';
      const before = await page.evaluate(() => window.__probe__?.loaf.length ?? 0);
      const at = await page.evaluate(() => window.__probe__?.now() ?? 0);
      await page.locator(FILTER_INPUT).press(key);
      try {
        await page.waitForFunction(
          (n) => (window.__probe__?.loaf.length ?? 0) > (n as number),
          before,
          { timeout: 5000 },
        );
      } catch {
        /* a press that produced no long frame is itself data */
      }
      presses.push({ index: i, key, queryLength: i % 2 === 0 ? 1 : 0, at });
      await page.waitForTimeout(150);
    }

    const profile = await page.evaluate(async () => await window.__probe__?.stopProfile());
    const streams = await page.evaluate(() => ({
      loaf: window.__probe__?.loaf ?? [],
      commits: window.__probe__?.commits ?? [],
      measures: window.__probe__?.measures ?? [],
    }));

    const resourceUrls = new Set<string>();
    for (const t of profile?.traces ?? []) for (const r of t.trace.resources) resourceUrls.add(r);
    const resourceSources = await captureResourceSources(page, [...resourceUrls]);

    await writeFile(
      resolve(OUT),
      `${JSON.stringify(
        {
          mode: MODE,
          url: URL_UNDER_TEST,
          buildMode: MODE === 'prod' ? 'production (vite build, sourcemap: true)' : 'development',
          cpuThrottleRate: THROTTLE,
          browser: browser.version(),
          requestedSampleInterval: REQUESTED_INTERVAL,
          profilerInstances: PROFILERS,
          reactHookInstalled: INSTALL_HOOK,
          blinkSourceLineColumn: process.env.PROBE_BLINK === '1',
          extraArgs: args,
          collectedAt: new Date().toISOString(),
          presses,
          profile,
          resourceSources,
          ...streams,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const total = (profile?.traces ?? []).reduce((n, t) => n + t.trace.samples.length, 0);
    console.log(
      `[probe] mode=${MODE} frames=${String(streams.loaf.length)} samples=${String(total)} ` +
        `measures=${String(streams.measures.length)} commits=${String(streams.commits.length)} -> ${OUT}`,
    );
  } finally {
    await browser?.close();
    if (devServer?.pid !== undefined) {
      try {
        process.kill(-devServer.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    prodServer?.close();
  }
}

await main();
