/**
 * Analyses a probe dump: LoAF decomposition arithmetic, per-frame sample
 * counts, and source-mapped resolution of every in-frame sample.
 *
 * node analyse.ts <dump.json> [--json]
 */
import { readFileSync } from 'node:fs';

import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

interface Frame {
  readonly name: string;
  readonly resourceId?: number;
  readonly line?: number;
  readonly column?: number;
}
interface Trace {
  resources: string[];
  frames: Frame[];
  stacks: { parentId?: number; frameId: number }[];
  samples: { timestamp: number; stackId?: number }[];
}

const path = process.argv[2];
if (!path) throw new Error('usage: analyse.ts <dump.json>');
const d = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

console.log(`# ${path}`);
console.log(
  `mode=${d.mode} build=${d.buildMode} throttle=${d.cpuThrottleRate}x browser=${d.browser} ` +
    `profilers=${d.profilerInstances} requestedInterval=${d.requestedSampleInterval}`,
);

const traces: { effectiveSampleInterval: number; trace: Trace }[] = d.profile?.traces ?? [];
for (const [i, t] of traces.entries()) {
  console.log(
    `trace[${i}] effectiveSampleInterval=${t.effectiveSampleInterval} samples=${t.trace.samples.length} ` +
      `frames=${t.trace.frames.length} resources=${t.trace.resources.length}`,
  );
}

// ---------------------------------------------------------------------------
// sample cadence
// ---------------------------------------------------------------------------
const all = traces[0]?.trace;
if (all) {
  const ts = all.samples.map((s) => s.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i += 1) gaps.push(ts[i]! - ts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]!;
  const dupes = gaps.filter((g) => g === 0).length;
  console.log(
    `cadence: n=${gaps.length} min=${q(0).toFixed(2)} p10=${q(0.1).toFixed(2)} median=${q(0.5).toFixed(2)} ` +
      `p90=${q(0.9).toFixed(2)} max=${q(0.999).toFixed(2)} zeroGaps=${dupes} ` +
      `span=${(ts[ts.length - 1]! - ts[0]!).toFixed(1)}ms`,
  );
}

// ---------------------------------------------------------------------------
// LoAF decomposition
// ---------------------------------------------------------------------------
function dec(e: any) {
  const scripts: any[] = e.scripts ?? [];
  const scriptTotal = scripts.reduce((n, s) => n + s.duration, 0);
  const end = e.startTime + e.duration;
  const preScript = scripts.length > 0 ? scripts[0].startTime - e.startTime : null;
  const styleLayout = (e.styleDuration ?? 0) + (e.layoutDuration ?? 0);
  const paint = e.paintTime != null ? e.paintTime - (e.styleAndLayoutStart + styleLayout) : null;
  const renderPhase = e.renderStart ? end - e.renderStart : null;
  const scriptEnd = scripts.length > 0 ? scripts[0].startTime + scripts[0].duration : null;
  return {
    startTime: +e.startTime.toFixed(1),
    duration: +e.duration.toFixed(1),
    blocking: e.blockingDuration,
    renderStart: e.renderStart,
    styleAndLayoutStart: e.styleAndLayoutStart,
    style: e.styleDuration,
    layout: e.layoutDuration,
    paintTime: e.paintTime,
    presentationTime: e.presentationTime,
    firstUIEvent: e.firstUIEventTimestamp,
    nScripts: scripts.length,
    scriptTotal: +scriptTotal.toFixed(1),
    forced: scripts.reduce((n, s) => n + (s.forcedStyleAndLayoutDuration ?? 0), 0),
    preScriptGap: preScript == null ? null : +preScript.toFixed(1),
    scriptEndToRenderStart:
      scriptEnd == null || !e.renderStart ? null : +(e.renderStart - scriptEnd).toFixed(1),
    renderPhase: renderPhase == null ? null : +renderPhase.toFixed(1),
    paintSlice: paint == null ? null : +paint.toFixed(1),
    // what the spec-ish fields account for, vs the frame duration
    accounted: +(scriptTotal + styleLayout + (paint ?? 0)).toFixed(1),
    unaccounted: +(e.duration - (scriptTotal + styleLayout + (paint ?? 0))).toFixed(1),
    invokers: scripts.map((s) => `${s.invokerType}:${s.invoker}@${s.sourceFunctionName}`),
  };
}

console.log('\n## LoAF frames');
const frames: any[] = d.loaf ?? [];
for (const [i, e] of frames.entries()) {
  const x = dec(e);
  console.log(
    `[${i}] t=${x.startTime} dur=${x.duration} block=${x.blocking} | scripts=${x.nScripts} ` +
      `sum=${x.scriptTotal} forced=${x.forced} | preGap=${x.preScriptGap} s2r=${x.scriptEndToRenderStart} ` +
      `renderPhase=${x.renderPhase} style=${x.style} layout=${x.layout} paintSlice=${x.paintSlice} ` +
      `| accounted=${x.accounted} unacc=${x.unaccounted} | pres-end=${
        e.presentationTime ? +(e.presentationTime - (e.startTime + e.duration)).toFixed(1) : null
      }`,
  );
  if (i === 0 || process.env.VERBOSE) console.log('    ', JSON.stringify(x.invokers));
}

// ---------------------------------------------------------------------------
// source maps
// ---------------------------------------------------------------------------
const maps = new Map<string, TraceMap>();
for (const [url, src] of Object.entries<any>(d.resourceSources ?? {})) {
  if (src?.sourceMap) {
    try {
      maps.set(url, new TraceMap(src.sourceMap));
    } catch (error) {
      console.log(`map failed for ${url}: ${String(error)}`);
    }
  }
}

function resolveFrame(trace: Trace, frameId: number) {
  const f = trace.frames[frameId]!;
  const url = f.resourceId === undefined ? null : trace.resources[f.resourceId] ?? null;
  let orig = null as null | { source: string | null; line: number | null; column: number | null };
  if (url && f.line !== undefined && f.column !== undefined) {
    const map = maps.get(url);
    if (map) {
      // profiler line/column are 1-based; trace-mapping wants 1-based line,
      // 0-based column.
      const p = originalPositionFor(map, { line: f.line, column: f.column - 1 });
      orig = { source: p.source, line: p.line, column: p.column };
    }
  }
  return { name: f.name || '(anonymous)', url, gen: `${f.line}:${f.column}`, orig };
}

function stackFrames(trace: Trace, stackId: number | undefined): number[] {
  const out: number[] = [];
  let id = stackId;
  let guard = 0;
  while (id !== undefined && guard < 500) {
    const s = trace.stacks[id];
    if (!s) break;
    out.push(s.frameId);
    id = s.parentId;
    guard += 1;
  }
  return out; // leaf first
}

console.log('\n## in-frame samples, resolved');
const press: any[] = d.presses ?? [];
const perFrameStats: any[] = [];
for (const [i, e] of frames.entries()) {
  const start = e.startTime;
  const end = e.startTime + e.duration;
  const inFrame = (all?.samples ?? []).filter((s) => s.timestamp >= start && s.timestamp <= end);
  const leafNames = new Map<string, number>();
  const userLines = new Map<string, number>();
  let emptyStacks = 0;
  let reachedUserFile = 0;
  for (const s of inFrame) {
    const ids = stackFrames(all!, s.stackId);
    if (ids.length === 0) {
      emptyStacks += 1;
      continue;
    }
    const leaf = resolveFrame(all!, ids[0]!);
    const key = `${leaf.name} ${leaf.orig?.source ?? leaf.url?.split('/').pop() ?? '?'}:${
      leaf.orig?.line ?? leaf.gen
    }`;
    leafNames.set(key, (leafNames.get(key) ?? 0) + 1);
    // deepest frame whose resolved source is a fixture src file
    for (const id of ids) {
      const f = resolveFrame(all!, id);
      if (f.orig?.source && /src\/(OrderTable|App|orders)/.test(f.orig.source)) {
        const k = `${f.orig.source}:${f.orig.line} (${f.name})`;
        userLines.set(k, (userLines.get(k) ?? 0) + 1);
        reachedUserFile += 1;
        break;
      }
    }
  }
  perFrameStats.push({ i, n: inFrame.length, emptyStacks, reachedUserFile });
  console.log(
    `[${i}] t=${start.toFixed(1)}-${end.toFixed(1)} dur=${e.duration.toFixed(1)} samples=${inFrame.length} ` +
      `empty=${emptyStacks} reachedUserSrc=${reachedUserFile}`,
  );
  for (const [k, n] of [...userLines].sort((a, b) => b[1] - a[1])) console.log(`      user  ${n}x ${k}`);
  if (process.env.VERBOSE)
    for (const [k, n] of [...leafNames].sort((a, b) => b[1] - a[1])) console.log(`      leaf  ${n}x ${k}`);
}

// aggregate across frames (item 2: does replay fix the statistics?)
console.log('\n## aggregate across all long frames (replay)');
const aggUser = new Map<string, number>();
const aggLeaf = new Map<string, number>();
let aggN = 0;
let aggEmpty = 0;
for (const e of frames) {
  const start = e.startTime;
  const end = e.startTime + e.duration;
  for (const s of (all?.samples ?? []).filter((x) => x.timestamp >= start && x.timestamp <= end)) {
    aggN += 1;
    const ids = stackFrames(all!, s.stackId);
    if (ids.length === 0) {
      aggEmpty += 1;
      continue;
    }
    const leaf = resolveFrame(all!, ids[0]!);
    const lk = `${leaf.name} @ ${leaf.orig?.source ?? leaf.url?.split('/').pop()}:${leaf.orig?.line ?? leaf.gen}`;
    aggLeaf.set(lk, (aggLeaf.get(lk) ?? 0) + 1);
    for (const id of ids) {
      const f = resolveFrame(all!, id);
      if (f.orig?.source && /src\/(OrderTable|App|orders)/.test(f.orig.source)) {
        const k = `${f.orig.source}:${f.orig.line} (${f.name})`;
        aggUser.set(k, (aggUser.get(k) ?? 0) + 1);
        break;
      }
    }
  }
}
console.log(`total in-frame samples=${aggN} empty=${aggEmpty}`);
console.log('user-source attribution:');
for (const [k, n] of [...aggUser].sort((a, b) => b[1] - a[1]))
  console.log(`   ${((100 * n) / aggN).toFixed(1)}%  ${n}x  ${k}`);
console.log('leaf frames (top 12):');
for (const [k, n] of [...aggLeaf].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`   ${((100 * n) / aggN).toFixed(1)}%  ${n}x  ${k}`);

// ---------------------------------------------------------------------------
// React measures / commits
// ---------------------------------------------------------------------------
console.log('\n## React measures');
for (const m of (d.measures ?? []) as any[]) {
  console.log(
    `  ${m.startTime.toFixed(1)} +${m.duration.toFixed(1)} ${JSON.stringify(m.name)} detail=${JSON.stringify(
      m.detail,
    )?.slice(0, 400)}`,
  );
}
console.log('\n## React commits (fiber durations)');
for (const [i, c] of ((d.commits ?? []) as any[]).entries()) {
  console.log(
    `  [${i}] committedAt=${c.committedAt?.toFixed(1)} prio=${c.priorityLevel} ` +
      (c.components ?? [])
        .map((x: any) => `${x.name}(actual=${x.actualDuration} self=${x.selfBaseDuration})`)
        .join(' '),
  );
}
console.log(`\npresses: ${JSON.stringify(press.map((p) => p.key))}`);
