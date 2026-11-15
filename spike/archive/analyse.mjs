// Ad-hoc, throwaway: the by-hand step-4 analysis of the three dumps.
import { readFileSync } from 'node:fs';

const root = '/Users/isaacunderwood/frontend_perf_mcp/spike/out';
const read = (f) => JSON.parse(readFileSync(`${root}/${f}`, 'utf8'));

const loaf = read('loaf.json');
const prof = read('profile.json');
const react = read('react-commits.json');

const p = prof.profile;
console.log('=== profiler session ===');
console.log('requested interval:', p.requestedSampleInterval, 'effective:', p.effectiveSampleInterval);
console.log('startedAt:', p.startedAt, 'stoppedAt:', p.stoppedAt);
const t = p.trace;
console.log('resources:', t.resources.length, 'frames:', t.frames.length, 'stacks:', t.stacks.length, 'samples:', t.samples.length);
console.log('sample timestamp range:', t.samples[0].timestamp, '→', t.samples.at(-1).timestamp);
console.log('page clock marks: interactionAt', loaf.clock.interactionAt, 'settledAt', loaf.clock.settledAt);
console.log();
console.log('=== resources ===');
t.resources.forEach((r, i) => console.log(' ', i, r));
console.log();

// Walk a stackId to its full frame chain, leaf first.
function stackChain(stackId) {
  const out = [];
  let id = stackId;
  while (id !== undefined && id !== null) {
    const s = t.stacks[id];
    if (!s) break;
    const f = t.frames[s.frameId];
    out.push(f);
    id = s.parentId;
  }
  return out;
}

const fmt = (f) =>
  `${f.name || '(anonymous)'}${f.resourceId !== undefined ? ` @ ${t.resources[f.resourceId]}:${f.line}:${f.column}` : ' @ (native)'}`;

// The keypress frame, identified by firstUIEventTimestamp being set and the
// frame containing the interaction mark.
const frames = loaf.entries.map((e) => e.toJSON);
const keyFrame = frames.find(
  (f) => f.firstUIEventTimestamp > loaf.clock.interactionAt - 20 && f.firstUIEventTimestamp > 0,
);
const windowStart = keyFrame.startTime;
const windowEnd = keyFrame.startTime + keyFrame.duration;
console.log(`=== keypress frame window: ${windowStart.toFixed(1)} → ${windowEnd.toFixed(1)} (${keyFrame.duration.toFixed(1)}ms) ===`);

const inWindow = t.samples.filter((s) => s.timestamp >= windowStart && s.timestamp <= windowEnd);
console.log(`samples inside it: ${inWindow.length} of ${t.samples.length}`);
console.log();

// Self time per leaf frame, and per (resource,line) for app code.
const leafCount = new Map();
const appLineCount = new Map();
for (const s of inWindow) {
  const chain = stackChain(s.stackId);
  if (chain.length === 0) { leafCount.set('(empty stack / idle)', (leafCount.get('(empty stack / idle)') ?? 0) + 1); continue; }
  const leaf = chain[0];
  const key = fmt(leaf);
  leafCount.set(key, (leafCount.get(key) ?? 0) + 1);
  // Deepest frame that belongs to the app's own source, not node_modules/deps.
  const appFrame = chain.find(
    (f) => f.resourceId !== undefined && /\/src\//.test(t.resources[f.resourceId]),
  );
  if (appFrame) {
    const k = `${t.resources[appFrame.resourceId]}:${appFrame.line}:${appFrame.column} (${appFrame.name || 'anonymous'})`;
    appLineCount.set(k, (appLineCount.get(k) ?? 0) + 1);
  }
}

const pct = (n) => `${((n / inWindow.length) * 100).toFixed(0)}%`;
console.log('--- leaf frames by sample count ---');
[...leafCount].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)} ${pct(n)}  ${k}`));
console.log();
console.log('--- deepest app-source frame per sample ---');
[...appLineCount].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)} ${pct(n)}  ${k}`));
console.log();

console.log('--- full stack of the single most common in-window sample ---');
const busiest = [...leafCount].sort((a, b) => b[1] - a[1])[0][0];
const example = inWindow.find((s) => { const c = stackChain(s.stackId); return c.length && fmt(c[0]) === busiest; });
if (example) stackChain(example.stackId).forEach((f, i) => console.log(`   #${i} ${fmt(f)}`));
console.log();

console.log('=== React hook records ===');
for (const c of react.commits) console.log(' ', JSON.stringify({ ...c, components: c.components?.map((x) => `${x.name}(tag ${x.tag}, actual ${x.actualDuration})`) }));
console.log();
console.log('=== React performance measures ===');
for (const m of react.measures) console.log(' ', JSON.stringify(m));
