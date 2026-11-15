/**
 * Vanilla / forced-layout probe.
 *
 * Answers: (a) does LoAF's sourceCharPosition point at *user* code when the
 * jank is not inside a framework, (b) does one frame ever carry several useful
 * script entries, (c) do styleDuration / layoutDuration /
 * forcedStyleAndLayoutDuration ever become non-zero, and does the LoAF
 * decomposition still close when they do.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { chromium } from '@playwright/test';

const DIR = '/private/tmp/claude-501/-Users-isaacunderwood-frontend-perf-mcp/0fd99662-eedd-4a17-88b3-3b4777964158/scratchpad/vanilla';
const PORT = 5185;
const URL_UNDER_TEST = `http://localhost:${String(PORT)}/`;
const OUT = process.env.OUT ?? '/tmp/vanilla.json';
const THROTTLE = Number(process.env.THROTTLE ?? 4);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0] ?? '/';
    const file = join(DIR, normalize(p === '/' ? '/index.html' : p));
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
        res.writeHead(404);
        res.end();
      },
    );
  });
  return new Promise((d) => {
    server.listen(PORT, () => d(server));
  });
}

async function main() {
  const server = await serve();
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
      const w = window as unknown as { __loaf: unknown[]; __p?: Profiler; __trace?: unknown };
      w.__loaf = loaf;
      w.__p = typeof Profiler === 'function' ? new Profiler({ sampleInterval: 5, maxBufferSize: 100000 }) : undefined;
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });

    await page.evaluate(() => {
      (window as unknown as { __loaf: unknown[] }).__loaf.splice(0);
    });

    for (let i = 0; i < 6; i += 1) {
      await page.locator('#go').click();
      await page.waitForTimeout(500);
    }
    const afterGo = await page.evaluate(() => (window as unknown as { __loaf: unknown[] }).__loaf.length);
    if (process.env.FORCE === '1') await page.evaluate(() => { (window as unknown as { __force: boolean }).__force = true; });
    for (let i = 0; i < 4; i += 1) {
      await page.locator('#layout').click();
      await page.waitForTimeout(600);
    }

    const trace = await page.evaluate(async () => {
      const w = window as unknown as { __p?: Profiler };
      return w.__p ? await w.__p.stop() : null;
    });
    const loaf = await page.evaluate(() => (window as unknown as { __loaf: unknown[] }).__loaf);
    const timing = await page.evaluate(() => (window as unknown as { __timing: unknown[] }).__timing);
    const sources: Record<string, string> = {};
    for (const name of ['app.js', 'vendor.js']) {
      sources[name] = await readFile(join(DIR, name), 'utf8');
    }

    await writeFile(
      OUT,
      `${JSON.stringify(
        { throttle: THROTTLE, browser: browser.version(), afterGoFrames: afterGo, loaf, trace, sources, timing },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`[vanilla] frames=${loaf.length} (first ${afterGo} from #go) samples=${trace?.samples.length ?? 0} -> ${OUT}`);
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
