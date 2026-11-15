/**
 * Prints full resolved stacks for the samples inside each long frame, with the
 * source map's `name` field, so we can see whether component identity and the
 * call site are recoverable from the stack alone (no React hook).
 *
 * node stacks.ts <dump.json> [frameIndex]
 */
import { readFileSync } from 'node:fs';

import { TraceMap, originalPositionFor, generatedPositionFor } from '@jridgewell/trace-mapping';

const path = process.argv[2]!;
const only = process.argv[3] === undefined ? null : Number(process.argv[3]);
const d = JSON.parse(readFileSync(path, 'utf8')) as any;
const trace = d.profile.traces[0].trace as {
  resources: string[];
  frames: { name: string; resourceId?: number; line?: number; column?: number }[];
  stacks: { parentId?: number; frameId: number }[];
  samples: { timestamp: number; stackId?: number }[];
};

const maps = new Map<string, TraceMap>();
const texts = new Map<string, string>();
for (const [url, src] of Object.entries<any>(d.resourceSources ?? {})) {
  if (src?.sourceMap) maps.set(url, new TraceMap(src.sourceMap));
  if (typeof src?.text === 'string') texts.set(url, src.text);
}

function resolve(frameId: number) {
  const f = trace.frames[frameId]!;
  const url = f.resourceId === undefined ? null : trace.resources[f.resourceId]!;
  const map = url ? maps.get(url) : undefined;
  let line0: any = null;
  let line1: any = null;
  let greatest: any = null;
  let least: any = null;
  if (map && f.line !== undefined && f.column !== undefined) {
    line0 = originalPositionFor(map, { line: f.line, column: f.column - 1 });
    line1 = originalPositionFor(map, { line: f.line, column: f.column });
    greatest = originalPositionFor(map, { line: f.line, column: f.column - 1, bias: 1 });
    least = originalPositionFor(map, { line: f.line, column: f.column - 1, bias: 2 });
  }
  return { f, url, line0, line1, greatest, least };
}

function label(frameId: number) {
  const { f, url, line0, line1, greatest, least } = resolve(frameId);
  const short = url ? url.split('/').pop()!.slice(0, 40) : '(no resource)';
  const o = (p: any) => (p ? `${p.source ?? '?'}:${p.line ?? '?'}:${p.column ?? '?'}${p.name ? ` name=${p.name}` : ''}` : '-');
  return (
    `${(f.name || '(anon)').padEnd(22)} gen ${short}:${f.line}:${f.column}\n` +
    `        col-1 → ${o(line0)}\n` +
    `        col   → ${o(line1)}\n` +
    `        GLB   → ${o(greatest)}\n` +
    `        LUB   → ${o(least)}`
  );
}

function chain(stackId: number | undefined) {
  const out: number[] = [];
  let id = stackId;
  let guard = 0;
  while (id !== undefined && guard < 200) {
    const s = trace.stacks[id];
    if (!s) break;
    out.push(s.frameId);
    id = s.parentId;
    guard += 1;
  }
  return out;
}

const frames: any[] = d.loaf ?? [];
for (const [i, e] of frames.entries()) {
  if (only !== null && i !== only) continue;
  const start = e.startTime;
  const end = e.startTime + e.duration;
  const inFrame = trace.samples.filter((s) => s.timestamp >= start && s.timestamp <= end);
  console.log(`\n### frame[${i}] ${start.toFixed(1)}–${end.toFixed(1)} (${e.duration.toFixed(1)}ms), ${inFrame.length} samples`);
  for (const s of inFrame) {
    const ids = chain(s.stackId);
    console.log(` sample @${s.timestamp.toFixed(1)} depth=${ids.length}`);
    for (const [depth, id] of ids.entries()) {
      if (depth > 6) {
        console.log(`   ... ${ids.length - depth} more`);
        break;
      }
      console.log(`   #${depth} ${label(id)}`);
    }
  }
}

// round-trip check: does generatedPositionFor(original culprit line) land on the
// generated position the profiler reported?
console.log('\n### round trip for OrderTable.tsx culprit lines');
for (const [url, map] of maps) {
  const sources: string[] = (map as any)._decoded ? [] : [];
  void sources;
  const names = (JSON.parse(readFileSync(path, 'utf8')) as any).resourceSources[url].sourceMap.sources as string[];
  const src = names.find((s) => s.includes('OrderTable'));
  if (!src) continue;
  for (const line of [34, 35, 36, 32]) {
    for (const column of [0, 4, 5, 9, 10]) {
      const g = generatedPositionFor(map, { source: src, line, column });
      if (g.line !== null) console.log(`  ${url.split('/').pop()} ${src}:${line}:${column} → gen ${g.line}:${g.column}`);
    }
  }
}
