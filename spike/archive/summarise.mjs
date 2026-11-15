// Ad-hoc: one compact summary line per spike run, for the reproducibility check.
import { readFileSync } from 'node:fs';
import { TraceMap, originalPositionFor } from '/Users/isaacunderwood/frontend_perf_mcp/node_modules/.pnpm/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping/dist/trace-mapping.mjs';

const dir = process.argv[2];
const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const loaf = read('loaf.json');
const prof = read('profile.json');
const react = read('react-commits.json');
const t = prof.profile.trace;

const frames = loaf.entries.map((e) => e.toJSON);
// The keypress frame is the one whose first UI event is at or after the mark
// taken immediately before the press.
const key = frames
  .filter((f) => f.firstUIEventTimestamp >= loaf.clock.interactionAt - 5)
  .sort((a, b) => a.startTime - b.startTime)[0];

if (!key) {
  console.log(`${dir}: NO keypress frame among ${frames.length} LoAF entries`);
  process.exit(0);
}

const start = key.startTime;
const end = key.startTime + key.duration;
const inWindow = t.samples.filter((s) => s.timestamp >= start && s.timestamp <= end);
const idle = inWindow.filter((s) => s.stackId === undefined).length;

function chain(stackId) {
  const out = [];
  let id = stackId;
  while (id !== undefined) {
    const s = t.stacks[id];
    if (!s) break;
    out.push(t.frames[s.frameId]);
    id = s.parentId;
  }
  return out;
}

// Resolve every in-window sample's deepest OrderTable.tsx frame to an original
// line, using the source map captured alongside this run.
const mapRaw = Object.fromEntries(
  Object.entries(prof.resourceSources ?? {}).map(([url, r]) => [url, r.sourceMap]),
);
const counts = new Map();
for (const s of inWindow) {
  const appFrame = chain(s.stackId).find(
    (f) => f.resourceId !== undefined && /\/src\/OrderTable\.tsx/.test(t.resources[f.resourceId]),
  );
  if (!appFrame) continue;
  const url = t.resources[appFrame.resourceId];
  const map = mapRaw[url];
  if (!map) { counts.set('unmapped', (counts.get('unmapped') ?? 0) + 1); continue; }
  const pos = originalPositionFor(new TraceMap(map), { line: appFrame.line, column: appFrame.column });
  const k = `${pos.source}:${pos.line}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

const script = (key.scripts ?? [])[0];
const measure = react.measures.find((m) => m.name.includes('OrderTable'));
const hookCommit = react.commits.find((c) => c.components);
const orderTableFiber = hookCommit?.components?.find((c) => c.name === 'OrderTable');

console.log(
  [
    `frame ${key.duration.toFixed(0)}ms`,
    `blocking ${key.blockingDuration.toFixed(0)}ms`,
    `loafScript ${script ? script.duration.toFixed(0) : '-'}ms (${script ? script.sourceFunctionName : '-'})`,
    `reactMeasure ${measure ? measure.duration.toFixed(0) : '-'}ms`,
    `fiberActual ${orderTableFiber ? orderTableFiber.actualDuration.toFixed(0) : '-'}ms`,
    `samples ${inWindow.length} (idle ${idle})`,
    `mapped ${[...counts].map(([k, n]) => `${k}×${n}`).join(' ') || 'none'}`,
  ].join(' | '),
);
