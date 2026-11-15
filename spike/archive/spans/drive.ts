/**
 * Drives the span-selectivity app: clicks each trigger, and reports which
 * components React gave a `performance.measure` span to versus which actually
 * rendered (from the fiber tree's actualDuration).
 */
import { spawn } from 'node:child_process';

import { chromium } from '@playwright/test';

const DIR = '/private/tmp/claude-501/-Users-isaacunderwood-frontend-perf-mcp/0fd99662-eedd-4a17-88b3-3b4777964158/scratchpad/spans';
const URL_UNDER_TEST = 'http://localhost:5186/';

async function main() {
  const server = spawn('node_modules/vite/bin/vite.js', [], { cwd: DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (c: Buffer) => process.stderr.write(`[vite] ${c.toString()}`));
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(URL_UNDER_TEST)).ok;
    } catch {
      await new Promise((d) => setTimeout(d, 250));
    }
  }
  if (!up) throw new Error('vite never answered');

  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const measures: unknown[] = [];
      const commits: unknown[] = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          measures.push({ name: e.name, startTime: e.startTime, duration: e.duration });
        }
      }).observe({ type: 'measure', buffered: true });

      function nameOf(type: unknown): string | null {
        if (typeof type === 'function') return (type as { name?: string }).name ?? '(anon)';
        if (typeof type === 'object' && type !== null) {
          const w = type as { displayName?: string; render?: unknown; type?: unknown; _context?: unknown };
          if (w.displayName) return w.displayName;
          if (w.render) return nameOf(w.render);
          if (w.type) return nameOf(w.type);
        }
        return null;
      }
      const renderers = new Map<number, unknown>();
      let next = 1;
      (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers,
        checkDCE() {},
        inject(r: unknown) {
          const id = next;
          next += 1;
          renderers.set(id, r);
          return id;
        },
        onCommitFiberRoot(_id: number, root: { current: unknown }) {
          const out: unknown[] = [];
          const pending: any[] = [root.current];
          let visited = 0;
          while (pending.length > 0 && visited < 5000) {
            const f = pending.pop();
            visited += 1;
            if (!f) continue;
            const n = nameOf(f.type);
            if (n !== null) {
              out.push({ name: n, actualDuration: f.actualDuration ?? null, flags: f.flags, lanes: f.lanes });
            }
            if (f.child) pending.push(f.child);
            if (f.sibling) pending.push(f.sibling);
          }
          commits.push({ at: performance.now(), components: out });
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
      (window as unknown as { __spans: unknown }).__spans = { measures, commits };
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });
    await page.locator('[data-t="bump"]').waitFor({ state: 'visible' });

    const report = async (label: string) => {
      const s = await page.evaluate(() => {
        const w = (window as unknown as { __spans: { measures: any[]; commits: any[] } }).__spans;
        const out = { measures: [...w.measures], commits: [...w.commits] };
        w.measures.length = 0;
        w.commits.length = 0;
        return out;
      });
      console.log(`\n## ${label}`);
      console.log(
        `   spans:   ${s.measures
          .map((m) => `${JSON.stringify(m.name).replaceAll('\\u200b', 'ZWSP:')}=${m.duration.toFixed(1)}`)
          .join(' | ')}`,
      );
      for (const c of s.commits) {
        console.log(
          `   rendered: ${c.components
            .map((x: any) => `${x.name}(actual=${x.actualDuration === null ? 'null' : x.actualDuration.toFixed(1)})`)
            .join(' ')}`,
        );
      }
    };

    await report('initial mount');
    await page.locator('[data-t="bump"]').click();
    await page.waitForTimeout(600);
    await report('bump: App setState → props change for PropsChanged, context for ContextConsumer');
    await page.locator('[data-t="self"]').click();
    await page.waitForTimeout(600);
    await report('self: StateOwner own setState, no prop change');
    await page.locator('[data-t="mount"]').click();
    await page.waitForTimeout(600);
    await report('mount: LateMount mounts for the first time');
    await page.locator('[data-t="bump"]').click();
    await page.waitForTimeout(600);
    await report('bump again (LateMount now present, props unchanged)');
  } finally {
    await browser.close();
    if (server.pid !== undefined) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
}

await main();
