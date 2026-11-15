/**
 * Does CDP's V8 CPU profiler give what the JS Self-Profiling API cannot:
 * (a) a sampling interval below 10ms, and (b) `positionTicks` — per-line hit
 * counts *inside* a function?
 *
 * env: CDP_MODE=dev|prod, CDP_INTERVAL=<microseconds>, CDP_PRESSES=n
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { chromium } from '@playwright/test';

const REPO_ROOT = '/Users/isaacunderwood/frontend_perf_mcp';
const DIST_DIR = join(REPO_ROOT, 'fixtures/derive-in-render/dist');
const MODE = process.env.CDP_MODE === 'prod' ? 'prod' : 'dev';
const INTERVAL_US = Number(process.env.CDP_INTERVAL ?? 100);
const PRESSES = Number(process.env.CDP_PRESSES ?? 6);
const PROD_PORT = 5184;
const URL_UNDER_TEST = MODE === 'prod' ? `http://localhost:${String(PROD_PORT)}/` : 'http://localhost:5181/';
const OUT = process.env.CDP_OUT ?? `/tmp/cdp-${MODE}.json`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function startProdServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0] ?? '/';
    const file = join(DIST_DIR, normalize(p === '/' ? '/index.html' : p));
    void stat(file).then(
      () => {
        res.writeHead(200, {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        createReadStream(file).pipe(res);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  return new Promise((d) => {
    server.listen(PROD_PORT, () => d(server));
  });
}

async function startDevServer(): Promise<ChildProcess> {
  const s = spawn('pnpm', ['--filter', '@frameblame/fixture-derive-in-render', 'dev'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch('http://localhost:5181/')).ok) return s;
    } catch {
      /* wait */
    }
    await new Promise((d) => setTimeout(d, 250));
  }
  throw new Error('dev server never answered');
}

async function main() {
  let dev: ChildProcess | undefined;
  let prod: Server | undefined;
  if (MODE === 'prod') prod = await startProdServer();
  else dev = await startDevServer();

  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const loaf: unknown[] = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          loaf.push({
            ...(e.toJSON() as Record<string, unknown>),
            scripts: Array.from(
              (e as PerformanceLongAnimationFrameTiming).scripts,
              (s) => s.toJSON() as Record<string, unknown>,
            ),
          });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
      (window as unknown as { __loaf: unknown[] }).__loaf = loaf;
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
    await page.locator('[data-fixture="filter-input"]').waitFor({ state: 'visible' });

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: INTERVAL_US });
    await cdp.send('Profiler.start');

    for (let i = 0; i < PRESSES; i += 1) {
      await page.locator('[data-fixture="filter-input"]').press(i % 2 === 0 ? 'n' : 'Backspace');
      await page.waitForTimeout(400);
    }

    const { profile } = await cdp.send('Profiler.stop');
    const loaf = await page.evaluate(() => (window as unknown as { __loaf: unknown[] }).__loaf);

    await writeFile(
      OUT,
      `${JSON.stringify(
        { mode: MODE, intervalRequestedUs: INTERVAL_US, throttle: 4, browser: browser.version(), profile, loaf },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(
      `[cdp] mode=${MODE} nodes=${profile.nodes.length} samples=${profile.samples?.length ?? 0} ` +
        `span=${(profile.endTime - profile.startTime) / 1000}ms loafFrames=${loaf.length} -> ${OUT}`,
    );
  } finally {
    await browser.close();
    if (dev?.pid !== undefined) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    prod?.close();
  }
}

await main();
