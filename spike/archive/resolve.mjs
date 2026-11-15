// Ad-hoc: resolve the profiler's generated line:column back to original source
// through the inline source map Vite's dev transform attaches.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TraceMap, originalPositionFor } from '/Users/isaacunderwood/frontend_perf_mcp/node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs';

const ROOT = '/Users/isaacunderwood/frontend_perf_mcp';
const server = spawn('pnpm', ['--filter', '@frameblame/fixture-derive-in-render', 'dev'], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let text = null;
for (let i = 0; i < 80; i += 1) {
  try {
    const res = await fetch('http://localhost:5181/src/OrderTable.tsx');
    if (res.ok) { text = await res.text(); break; }
  } catch {}
  await wait(250);
}
if (!text) { process.kill(-server.pid, 'SIGTERM'); throw new Error('dev server never answered'); }

const m = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/.exec(text);
console.log('served module bytes:', text.length, '| has inline source map:', Boolean(m));

const servedLines = text.split('\n');
const show = (line, col) => {
  const src = servedLines[line - 1] ?? '';
  return `${JSON.stringify(src.slice(Math.max(0, col - 30), col + 40))} (col ${col})`;
};

const map = new TraceMap(JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')));
const positions = [
  [27, 108, 'leaf frame, 2 samples'],
  [25, 27, 'OrderTable frame, 1 sample'],
  [61, 81, 'deeper app frame, 1 sample'],
];

for (const [line, column, label] of positions) {
  console.log(`\n--- generated ${line}:${column} (${label}) ---`);
  console.log('  served text:', show(line, column));
  // The profiler reports 1-based columns; source maps are 0-based in column.
  for (const colBase of [column, column - 1]) {
    const orig = originalPositionFor(map, { line, column: colBase });
    console.log(`  column ${colBase} ->`, JSON.stringify(orig));
  }
}

const original = readFileSync(`${ROOT}/fixtures/derive-in-render/src/OrderTable.tsx`, 'utf8').split('\n');
console.log('\n--- original OrderTable.tsx lines 32-37 ---');
for (let i = 32; i <= 37; i += 1) console.log(`  ${i}: ${original[i - 1]}`);

process.kill(-server.pid, 'SIGTERM');
