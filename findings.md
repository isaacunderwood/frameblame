# Findings — v0.1 spike

What the raw-stream spike discovered about whether the join holds.

Revised after an adversarial review round that re-ran everything and added four fixtures the
original spike did not have. Three of the original conclusions were reversed; they are listed
under "What the review round changed" at the end, because a document that silently rewrites its
own history is no more honest than one that gets the numbers wrong.

## Verdict: go

The join identifies the ground-truth culprit. On a single frame it names the **component**
reliably and the **function** as a ranked guess; replayed over two dozen interactions it names
the function stably too — 73% of samples on the declared culprit line, and the top-ranked line
correct in 13 of 14 frames. It works in a production build as well as in development, by a
different route than expected.

What it cannot do is point at a *statement* inside a long function from inside the page, and it
cannot account for a frame whose time went to browser work rather than script. Both are stated
plainly below.

## How it was measured

Everything here is Chromium **159.0.8154.6**, Apple silicon, **4× CPU throttling** via CDP
`Emulation.setCPUThrottlingRate`, with the build mode given per figure. Quoted bare these
numbers mean nothing: a 64ms frame here is roughly a 16ms frame unthrottled on this machine, and
neither is what a user on a mid-range Android sees.

Fixtures used:

- **`derive-in-render`** (in the repo) — a filter and `localeCompare` sort over 10,000 rows in
  `OrderTable`'s render body, original lines 34–36, line 36 declared in advance as the dominant
  cost. Driven by one keystroke, and by a 24-press replay.
- Three throwaway fixtures built during the review round. Figures below marked "throwaway
  fixture" were measured on those. **All three have since been promoted into `fixtures/`** —
  `spans`, `innerhtml-rebuild` and `vendor-listener` — each with its own `ground-truth.json`, and
  every claim they produced has been re-measured from this repo. See "What the corpus capture
  found" at the end, which records where the re-measurement agreed and where it did not.

Single-keystroke runs of `derive-in-render`, Vite **development** build, in run order, read
back from the retained dumps rather than rounded by hand:

| | frame | LoAF script | `OrderTable` span | `OrderTable` fiber | `App` fiber | `App` span | samples |
|---|---|---|---|---|---|---|---|
| run 1 | 79.3ms | 57.3ms | 46.1ms | 44.7ms | 46.5ms | **none** | 7 |
| run 2 | 63.8ms | 54.8ms | 45.0ms | 45.0ms | 46.7ms | **none** | 5 |
| run 3 | 64.2ms | 55.5ms | 45.6ms | 45.5ms | 47.0ms | **none** | 6 |

The two right-hand columns are the span gate described below, already visible in the very first
data collected and missed on the first reading: `App` rendered for longer than `OrderTable` in
all three runs and was never given a `performance.measure` in any of them.

**Discard the first run of a session.** In a warm dev replay, frames 0–1 were 84.2ms and 73.1ms
with pre-script gaps of 10.3–25.7ms; everything after was 58.7–62.9ms with gaps of 1.0–2.6ms.
The very first run of the day was wilder still — see the unattributed-time section.

## What each signal actually said

### Long Animation Frames: the trigger, and a confirmation of the premise

The keypress frame carried exactly one script attribution, identically in all three runs:

```
invoker:            "DIV#root.oninput"
invokerType:        "event-listener"
sourceURL:          ".../node_modules/.vite/deps/react-dom_client.js?v=..."
sourceFunctionName: "dispatchDiscreteEvent"
sourceCharPosition: 747742
sourceLine:         null
sourceColumn:       null
```

This is the project's whole thesis in one record. LoAF's answer to "what made this frame slow"
is *react-dom's event dispatcher* — not wrong, just useless. Resolving that character offset
through a source map, which no RUM vendor currently bothers to do, lands in React's own source
rather than anywhere near the user's bug. **The expensive signal is not optional. It is the only
one that can see the component.**

`sourceLine` and `sourceColumn` were `null` in every record. They are specified, and implemented
in Chromium behind the `LongAnimationFrameSourceLineColumn` Blink features, which are off by
default — so the character-offset-to-line conversion is still necessary work, on the paths where
it is needed at all.

### JS Self-Profiling: the explanation, and it works

Requires `Document-Policy: js-profiling` on the document response; `window.Profiler` is absent
without it, and the deprecated boolean token is what Chrome stable still accepts — its
successor, `js-profiling-mode=eager|lazy`, was only an Intent to Prototype as of November 2026.

In a Vite dev server the trace's `resources` are **the component files themselves**, because
dev-mode ESM serves each module separately. The list is short and varies with what actually ran:
two entries in run 2, three in runs 1 and 3, and four in the unretained first run of the session
— `src/App.tsx` appears only when a sample happened to land in it. The full chain, end to end,
for the most-sampled frame of run 2:

```
profiler frame   OrderTable.tsx (generated) 27:108
served text      ".sort((a, b) => a.customer.localeCompare(b.cust…"
Vite inline map  → OrderTable.tsx, original line 36
ground truth     line 36: .sort((a, b) => a.customer.localeCompare(b.customer))   ← dominant culprit
```

That is the claim the tool exists to make, made from real signals, against a bug declared in
advance.

### React: a strong signal and a trap

**React 19.3's development build emits named render spans as `performance.measure` entries.**
The keypress produced `"​OrderTable"`, 45–46ms, on the same clock as everything else, and it
appears with **no DevTools hook installed at all** (verified with `SPIKE_SKIP_REACT_HOOK=1`:
still 44.3ms).

**But the spans are not emitted for every component that rendered, and the rule is not cost.**
From `react-dom-client.development.js:4441–4477`, a component gets a `performance.measure` only
if `alternate !== null` **and** `alternate.memoizedProps !== props` **and** the props diff is
non-empty. Otherwise React emits `console.timeStamp`, which produces no `PerformanceEntry` at
all. Measured on the four-cause React fixture (dev, 4×, throwaway fixture):

| trigger | components that rendered (~25ms each) | components given a span |
|---|---|---|
| initial mount | App, PropsChanged, ContextConsumer, StateOwner, DeepEqualProps (140ms total) | **none** |
| App `setState` | all five | PropsChanged, DeepEqualProps |
| StateOwner's own `setState` | App 25.2ms, StateOwner 25.2ms | **none at all** |
| LateMount mounts | all six | DeepEqualProps only |

So the spans are structurally blind to the components most often at fault: the `setState` owner,
context consumers, and anything on first mount. In our own fixture, `App` was never named — not
in any of the three single-keystroke runs above, where its `actualDuration` was 46.5–47.0ms and
so *larger* than the component that did get a span, and not across 24 keypresses in the replay.
It holds the `useState` that the keystroke updates, which is exactly the shape the gate excludes.

Two further traps. The `detail.devtools` object is a mutated module singleton
(`react-dom-client.development.js:28178–28188`), so `properties`, `color` and `tooltipText`
reflect the *last* measure emitted rather than the entry in hand — only `name`, `startTime` and
`duration` can be trusted. And React calls `performance.clearMeasures(name)` immediately after
emitting (`:4476`), so the entries must be **observed**, never polled for.

**`actualDuration` is populated in the development build.** The plan assumed it was
profiling-build-only. It was present on every component fiber, including the ones React declined
to give a span. Where both signals existed for the same component they agreed closely — 45.0 vs
45.0 and 45.5 vs 45.6 on the two warm runs, and 44.7 vs 46.1 on the first — so corroboration is
real but is available for a subset of components only. Self time is
`actualDuration − Σ children.actualDuration`, which is what React itself computes at `:4421–4424`
— **not** `selfBaseDuration`, which is the previous full render's base duration and was 8% off
for `OrderTable` (42.1 vs 45.5ms).

One span is worth keeping regardless: `"Update"`, whose `detail` is rebuilt per emission and
carries the originator of the update, e.g. `[["Component name","App"],["Method name","setState()"]]`.
It appeared on only 5 of 24 keypresses, so it is a bonus, not a tier.

### The clock question: answered

The profiler spec says sample timestamps are relative to "the profiling session's time origin",
which is not obviously the document's. Measured, the first sample lands 0.1–1.3ms after the
`performance.now()` reading taken immediately before `new Profiler(...)`:

| | profiler started | first sample | delta |
|---|---|---|---|
| run 1 | 331.4 | 332.7 | 1.3ms |
| run 2 | 269.1 | 269.2 | 0.1ms |
| run 3 | 269.0 | 269.4 | 0.4ms |

**All three signals are on one `performance.now()` timeline.** No clock reconciliation is
needed, which removes the correlation risk the spike was most worried about.

## Production works, by a different route

Nobody had looked at a production build when the first draft of this document was written. It
turns out to be the stronger case for the profiler, not the weaker one.

Vite **production** build with `sourcemap: true`, served statically with the profiling header,
4×, 24 presses:

- React's `performance.measure` entries: **0**. Fiber `actualDuration` and `selfBaseDuration`:
  **null**. `priorityLevel`: null. The DevTools hook *does* still fire `onCommitFiberRoot` on
  24/24 commits, but the component names are minified — `re`, `h`.
- The profiler plus the shipped source map, however, resolves **better** than in development:
  15 of 16 in-frame samples land on `src/OrderTable.tsx:36`, and the top-ranked line was correct
  in 4 of 4 frames (dev: 13 of 14).
- Decisively: the parent frame of the comparator is the minified `h` at generated `9:50998`, and
  `originalPositionFor` returns `OrderTable.tsx:32:16` **with `name: "OrderTable"`** recovered
  from the source map's `names` array. React's own internals resolve too — `renderWithHooks`,
  `updateFunctionComponent`, `beginWork`, `workLoopSync`.

**So production attribution needs no hook, no development build, and no build-time plugin — just
the profiler and the source map the project already ships.** That makes the deferred Vite
annotation plugin in `later.md` less urgent rather than more.

## Decomposing the frame: what the arithmetic can and cannot do

LoAF's own fields give an exact, unsampled partition of the frame — where the frame is dominated
by script. `duration` ends at `paintTime`, verified exactly in every dump
(`startTime + duration === paintTime`).

**It closes for script-dominated frames.** Warm dev keypress frames (dev, 4×, frames 2–13):
`Σ scripts + styleDuration + layoutDuration + (paintTime − styleAndLayoutStart)` accounted for
56.8–60.2ms of 58.7–62.9ms frames — a **residual of 1.4–3.8ms, or 2–6%**, all of it the
pre-first-script gap plus the gap between the last script and `renderStart`. Where this holds,
sampling is only needed to split the *script* slice among causes, which is a far weaker
requirement than measuring the whole frame.

> **Use the recipe below, not the formula in that paragraph.** The formula double-counts: style
> and layout happen inside `[styleAndLayoutStart, paintTime]`, so adding them to
> `paintTime − styleAndLayoutStart` charges them twice. It did not show on these frames because
> both fields were 0 on all of them — only 3 of the corpus's 54 painted frames report either as
> non-zero — but it is wrong on the three that do. The recipe's `paint-ish` term subtracts them,
> which is the difference, and the engine builds the partition from boundary timestamps so that
> the question cannot arise. The qualitative claim stands: on a script-dominated frame the
> remainder is a couple of milliseconds of gap.

**It fails catastrophically for browser-work-dominated frames.** The vanilla `innerHTML` fixture
(4×, throwaway fixture):

| frame | duration | Σ scripts | styleDuration | layoutDuration | residual |
|---|---|---|---|---|---|
| 2 | 145.9 | 9.1 | 0 | 0 | **136.1 (93%)** |
| 3–5 | 129–156 | 14.5–17.9 | 0 | 0 | 112–139 |

The script figure was *correct* — in-page `performance.now()` around the listener agreed to
0.5ms. The missing ~130ms is real main-thread **work**, not idle: a `MessageChannel` message
posted at the end of the listener took 122–146ms to be delivered, and `requestAnimationFrame`
fired 118–141ms later, exactly at `renderStart`. And it is style and layout: moving the same work
inside the script with an `offsetHeight` read made LoAF name it exactly —
`forcedStyleAndLayoutDuration` 96.4–116.0ms, split 24.3–25.3 style / 71.8–90.6 layout *(the split
is real and comes from the entry's own `forcedStyleDuration` and `forcedLayoutDuration`; the layout
upper bound is superseded — see the closed open item below)* — while
`styleDuration` and `layoutDuration` stayed **0**. That is specified behaviour, not a Chrome bug:
style recalculation and layout performed while no script is running, before the rendering update,
are not counted.

The honest recipe, then:

```
pre-script   = scripts[0].startTime − startTime        input delay, plus any sub-5ms scripts
script_i     = scripts[i].duration                     each ≥5ms; forcedStyle/LayoutDuration is
                                                        browser work nested INSIDE this, never added
gap          = renderStart − lastScriptEnd
pre-style    = styleAndLayoutStart − renderStart        rAF, ResizeObserver, IntersectionObserver
style/layout = styleDuration, layoutDuration            rendering-update only
paint-ish    = paintTime − styleAndLayoutStart − style − layout
UNNAMED      = duration − Σ(above)                      can be 93% of the frame
presentation = presentationTime − paintTime             OUTSIDE duration: 23–42ms measured
```

Four things that must be built in:

1. **`forcedStyleAndLayoutDuration` is nested inside a script's `duration`.** Adding it as a
   separate slice double-counts.
2. **Every field is coarsened on a randomised 100µs grid** (5µs if cross-origin isolated), so any
   residual below ~0.2ms is noise and `paintTime − styleAndLayoutStart − style − layout` can come
   out slightly negative.
3. **`presentationTime` sits 23–42ms beyond the end of `duration`** in every frame measured, so
   the denominator has to be named: ~70% of `duration` is ~45% of keypress-to-pixels.
4. `blockingDuration` carries little independent information for single-task frames — it is
   roughly the longest task plus render minus 50 — but it does let the longest task's length be
   recovered (59.0ms in the warm dev replay).

**The empty-stack samples are the cross-check, not a shrug.** Residual 93% coincided with 100% of
in-frame samples having no JS on the stack; residual 7.7% coincided with 1.9%. Two independent
signals agreeing that nothing was attributable is a far better unattributed tier than subtraction
alone.

## What made it hard

**1. The sampling floor is 10ms and cannot be moved.** `ProfilerGroup::kBaseSampleIntervalMs` is
a compile-time constant of 10 in Blink (16 on Windows), with no flag, feature or Document-Policy
parameter reading it, and V8's `--cpu-profiler-sampling-interval` is overridden by Blink's
explicit call. Chrome also snaps **up**, contrary to the spec's "next lowest supported" language:
`sampleInterval: 1` silently becomes 10. Measured cadence over 4,817 samples across 55.7s (dev,
4×): min 1.0, p10 10.1, **median 12.1**, p90 12.7, max 13.2ms — so budget ~12ms, and expect
identical timestamps, because coarsening makes gaps of zero real.

Two dead ends, both tested so nobody retries them: **four concurrent `Profiler` instances gain
nothing** — the union of distinct timestamps across all four was 984 against 982 for a single
trace, since there is one `v8::CpuProfiler` per isolate snapped to the same base interval. And
**`ProfilerSample.marker` does not exist in Chrome 159** — zero of 667 samples carried one,
including across a 102ms forced layout. It would have given style and layout attribution *inside*
the script slice. Untested under COOP+COEP, where the spec's filter is wider.

**2. One frame is not enough samples; replaying the interaction is the fix.** A 64ms frame yields
five to seven samples, and the original three single-keystroke runs put the top line on the
declared culprit only twice — which was three samples of a roughly 93% process, not a coin flip.
Replayed over 24 presses (dev, 4×, 14 long frames, 63 `OrderTable` samples), the aggregate line
histogram was:

```
line 36 ×46    line 32 ×8    line 49 ×8    line 35 ×1      → 73% on line 36 (76% excluding cold frames)
```

and the top-ranked line was inside the declared range 34–36 in **13 of 14 frames**. In
production, 15 of 16 and 4 of 4. **Build the replay loop**: it costs one keystroke each and turns
a ranked guess into a stable distribution. Per-frame percentages, however, remain unusable —
±20 points at five samples.

**3. From inside the page, "which line" is permanently "which function".** The spec mandates it:
`ProfilerFrame.line` is "the 1-based index of the line at which instance is **defined**". V8 does
record the executing line, but Blink requests `kLeafNodeLineNumbers` and its trace builder never
reads `GetLineTicks()`. So line 32 (`export function OrderTable(...)`) means "inside the sort but
not inside the comparator", and line 49 is the row-rendering `.map` callback — real render work,
not the bug. The product claim has to be phrased accordingly:
`OrderTable.tsx:36, in the callback passed to .sort` is defensible; "line 36 is slow" is not.

**True statement-level attribution does exist, over CDP.** `Profiler.setSamplingInterval(100µs)`
plus `Profiler.start` against the dev fixture (4×) gave 8,948 samples in 2,898ms — a median
inter-sample delta of **185µs, 65× denser than the web API**. The `OrderTable` node, defined at
generated line 25, carried `positionTicks` summing to **164 at generated line 27 → original line
36**, with 2 at generated 61 → original 49; the comparator node had 703 and the filter arrow 35.
That is attribution inside a function, which the in-page API cannot do at any sample count.
Caveat: in the minified production bundle every tick lands on generated line 9, so in production
CDP buys sample density, not line precision. This is an argument for pulling the deferred
CDP-driven CLI earlier.

**4. Resolve to a line; use the column only to name the call.** The original explanation — that
source maps are segment-based and resolve to the nearest segment — was wrong. The maps are dense:
27 segments on the dev file's generated line 27, and 39 segments across the 170 generated columns
of the minified bundle covering the same expression. The failure is systematic: esbuild/rolldown
emit no segment for an arrow function's opening paren, so the arrow's definition column falls one
segment early. `GREATEST_LOWER_BOUND` and `LEAST_UPPER_BOUND` returned identical results on every
frame in both builds, and a `generatedPositionFor` round trip validates the line but cannot
sharpen the column — neither is a lever. The consolation: the profiler's column minus one,
resolved, lands on the **enclosing call's token** — `OrderTable.tsx:36:6` is `.sort` — identically
in dev and production. That is the token worth printing.

**5. `sourceCharPosition` is valuable for non-framework jank, and cannot produce a third-party
share.** On the vanilla three-listener fixture (4×, throwaway fixture), one frame carried three
script entries, each resolving to the exact listener registration line in the user's own file:

```
dur 19.0ms   charPos 1336 → app.js:47    (computeTotals)
dur 12.0ms   charPos 1422 → app.js:50    (vendorTrack)
dur 109.4ms  charPos 1509 → app.js:53    (thrashLayout, forcedStyleAndLayout 106.9ms)
```

`sourceFunctionName` was empty for all three — anonymous arrows — so the character offset did all
the work. That confirms the primitive's value outside React. But note what the middle entry says:
the vendor listener's 12ms is attributed to `app.js:50`, because that is where the listener was
*registered*; `vendor.js` appears nowhere in the LoAF entry. **So LoAF's script attribution cannot
produce a third-party share whenever first-party code calls into a vendor library** — the common
case for analytics wrappers, error handlers and the like. Third-party attribution requires the
profiler, and `later.md`'s "categorising every slice of the frame" should say so.

Relatedly: nested entry points are merged by spec — if a frame already has a pending script, a
new one is not started — which is why React's entire render arrives as a single 55ms entry rather
than a tree.

**6. The 50ms threshold hides most of this fixture's jank.** Not covered at all in the original
draft, and it dents the headline.

> **The counts in this paragraph are not reproducible. Do not quote them and do not assert on
> them.** They are left in place rather than corrected because the conclusion below them
> survived — it got stronger — and because the way they are unstable is the evidence for it.
> Re-measured on the same machine, browser and throttle rate, within one hour: **14, 14, 14, 23
> and 14** long frames in development, and **14 then 6** in production. Note that production's
> 6 *did* come back. The count is not wrong, it is unrepeatable, which is worse for a test and
> better as a finding. See "What the corpus capture found" at the end of this document.

Dev, 4×, 24 presses produced 24 commits of 42.3–57.9ms of React
render each — and only **14 to 15 long frames**, run to run. Production, 24 presses produced 24
commits and only **6 long frames**, with reported durations of 50.0, 50.0, 50.2 and 51.0: the
distribution is being sliced by the threshold. **18 of 24 interactions that burned ~45ms of main
thread were invisible.** So "all long frames are ingested" is true but incomplete — on the very
fixture this project built, a quarter to two thirds of janky interactions produce no trigger. An
aggregate leaderboard that counts frames will under-count exactly the near-threshold offenders
users feel. Either say so plainly in the README, or supplement the trigger — the CDP CLI can see
every task, not only frames over 50ms.

That conclusion is now firmer than the numbers that produced it. The count is not a property of
this fixture at all: it measures where the fixture's duration distribution sits relative to a
constant, and that moves between runs on one machine. Which means the under-counting is not a
quirk of one app — any aggregate that counts frames will under-report near-threshold jank on
*every* app, by an amount that varies with how warm the user's device is.

**7. Not all of a long frame is attributable, and the cold run proves it.** The very first run of
the day behaved completely differently: a 226ms keypress frame in which **14 of 21 samples had no
JavaScript on the stack at all**, plus a second 566ms frame with zero script attributions and
`styleDuration`/`layoutDuration` both 0. An empty stack does not mean nothing happened; it means
no JS was running. A tool that silently distributed that gap across the components it could see
would be lying.

*Provenance:* that run's dump was overwritten by the runs that followed before anything was
copied aside, so these figures — and the finer-grained ones quoted from it elsewhere, such as the
`renderStart` of 867.2 and the commit at 713.4 — are reported from the session that observed them
and **cannot be re-derived from any file in this repo**. They are internally consistent
(`642.1 + 226.2 = 868.3`, matching `paintTime` exactly as the spec requires), and the qualitative
finding was reproduced by the vanilla `innerHTML` fixture, which hit a 93% residual with 100%
empty stacks. But the specific numbers are a dangling citation, and the spike should copy each
dump to a timestamped directory rather than overwriting `spike/out/`.

**8. The evidence base is still narrow.** Four fixtures, one framework version, one browser, one
machine. The untested cases most likely to break the join: two simultaneous causes of comparable
size in one frame, cost spread thinly across hundreds of components rather than concentrated in
one, and `Profiler` behaviour under COOP+COEP.

## What this implies for the design

- **LoAF** stays the trigger and becomes the *denominator* — and the trigger needs supplementing,
  because the 50ms threshold hides near-threshold jank.
- **The React DevTools hook plus fiber `actualDuration`** is the **primary** component signal in
  development. It saw every component in every scenario tested. React's `performance.measure`
  spans are **corroboration only**, because their props-identity gate makes them blind to the
  `setState` owner, context consumers and first mount.
- **The profiler plus the shipped source map** is the whole production story, with the component
  name recovered from the map's `names` field. No hook, no dev build, no build-time plugin.
- **The profiler** also remains the only source of third-party attribution and of anything
  outside React's render phase, since LoAF attributes to the registration site.
- **Replay** moves from a nicety to a core mechanism: it is what makes function-level attribution
  stable.
- **The confidence model** has its concrete job: the component is known, the function is a
  distribution, the statement is only available over CDP, and the unattributed remainder is
  cross-checked against the empty-stack sample share.

The invariant that said "a single obvious cause is the degenerate case where one candidate holds
all the weight" survives contact with real data. Even on the easiest possible fixture the honest
answer was a component at high confidence and a ranked set of lines.

## What the review round changed

Three reversals, recorded so the earlier reasoning is not repeated:

1. **"Promote React's `performance.measure` spans to the primary component signal."** Wrong, and
   the most consequential error. The props-identity gate means a tool keyed on spans reports
   "nothing happened" for a 50ms frame caused by a leaf component's own `setState`. The hook is
   primary; spans corroborate.
2. **"The production story is weaker, falling back to the hook plus source maps."** Backwards.
   Production resolves better than development, needs no hook at all, and recovers the component
   name from the source map's `names` array.
3. **"Single-line attribution is a coin flip (2 of 3 runs)."** Small-sample noise. With replay it
   is 73% of samples and 13 of 14 frames. The real limitation is not statistical but structural —
   function-level, not statement-level, from inside the page.

One correction of reasoning rather than conclusion: the column imprecision is caused by missing
source-map segments for arrow-function parens, not by segment resolution.

## Reproducing this

```
pnpm spike:corpus                            # every fixture, both build modes, into corpus/
pnpm spike:dump                              # one capture into a timestamped spike/out/ directory
pnpm spike:dump spans production             # any fixture, either mode
SPIKE_SKIP_REACT_HOOK=1 pnpm spike:dump      # is React's measure hook-independent?
SPIKE_SOURCE_LINE_COLUMN=1 pnpm spike:dump   # what the Blink flag would add
pnpm test                                    # asserts the claims below against corpus/
```

Each capture writes five files to its own run directory: `run.json` (the drive plan, one record
per interaction, and the counts), `loaf.json`, `profile.json`, `react-commits.json` and
`source-windows.json`. `profile.json` carries the source map of every script named in the trace —
inline in development, followed to the `.map` file in production — so positions can be resolved
after the server is gone. `source-windows.json` carries a few hundred characters of the text each
script actually served around every attributed position, which is what makes the resolution chain
above verifiable rather than merely asserted. See `corpus/README.md`.

**Open items.** The three recorded here — all three bookkeeping rather than discovery, and all
three blocking anyone who was not present from relying on this document — are now closed:

1. ~~The replay probe and the three throwaway fixtures are not in this repo.~~ The fixtures are
   `fixtures/spans`, `fixtures/innerhtml-rebuild` and `fixtures/vendor-listener`; the replay is
   `spike/fixtures.ts`'s drive plan for `derive-in-render`. The CDP profiler probe remains
   archived only, which is correct: the CDP path is deferred, and `spike/archive/cdp-profile.ts`
   is the evidence for why it is worth picking up.
2. ~~`spike:dump` overwrites `spike/out/`.~~ Every capture writes
   `spike/out/<timestamp>__<fixture>__<mode>/`, and `pnpm spike:corpus` promotes a copy into
   `corpus/`. Two consecutive runs now leave two complete, independently readable directories.
3. ~~The served text cannot be re-derived from a dump.~~ `source-windows.json`, as above.

~~One item is open in their place: the forced scenario's style-versus-layout split, quoted under
"Decomposing the frame" as 24.3–25.3 style and 71.8–90.6 layout, **cannot have come from the LoAF
entry** — the entry exposes only the combined `forcedStyleAndLayoutDuration` — and its instrument
is not recorded.~~ **Closed, and the reasoning was wrong rather than incomplete.** The instrument
is the LoAF script entry: the spec defines `forcedStyleDuration` and `forcedLayoutDuration`
alongside the combined figure, which it defines as *their sum*, and Chrome 159 serialises all
three. They are in all eight captures, in `entries[].toJSON.scripts[]` — and absent from the
collector's own field-by-field projection beside it, because both the projection and this repo's
ambient declarations were transcribed from the spec by hand and these two were missed. They
survive only because the collector also stores whatever `toJSON()` serialises, verbatim, which is
the whole argument for having done that.

Re-measured from the corpus, the style range reproduces and the layout range does not: 23.4–25.8ms
style and 72.4–80.3ms layout on the four forced frames of `innerhtml-rebuild` in development, and
23.6–24.8 / 71.1–80.6 in production (4× in both). So the quoted 71.8–90.6 overstates its upper
bound by about 10ms against anything in this repo. Note also that the two halves do not sum to the
combined figure exactly — they are each coarsened independently, deliberately, so that summing
them cannot recover resolution the browser is withholding, and they differ by exactly one 100µs
grid step on 6 of the corpus's 20 forced entries.

Two things follow. A Chrome trace is not needed for the split, which removes the instrument
question entirely. And the collector's hand-picked script projection is now both redundant and
incomplete; fixing it is a collector change, so it waits for a reason to re-capture all eight runs
rather than being made on its own.

## What the corpus capture found

Eight captures on 2026-11-15, same machine and same Chromium 159.0.8154.6 as everything above, 4×
throttling, with all four fixtures now in the repo. What changed:

**One number here is not wrong so much as unrepeatable, and that is the more useful result.**
The long-frame counts — 14–15 in development and 6 in production over 24 presses — came back as
14, 14, 14, 23 and 14 in development and 14 then 6 in production, across five sessions on one
machine within one hour, same browser and same throttle rate. Production's 6 did return. The
fixture has not changed and nothing is broken: the frames measured 50–80ms in development
against the original production run's 50.0–51.0ms cluster, so the distribution sits a few
milliseconds either side of a fixed threshold and whether a given press clears it depends on how
warm the machine is.

So finding 6 is not merely true, it is sharper than stated: the long-frame **count** is not a
property of the fixture at all. It measures where that fixture's duration distribution happens to
sit relative to a constant, which moves between runs in one session. No suite may assert on it,
and no README may quote it as a fixture property.

The aggregate line histogram is the stable quantity. Measured four times now — 73% when this
document was written, then 76%, 83%, 69% and 93% — always with line 36 ranked first. That is
what `pnpm test` asserts, at a floor of 60%. The spread is wide enough that the floor is doing
real work rather than rubber-stamping; 69% is the lowest seen and the margin is thin.

**Everything else reproduced, three of them more cleanly than before.**

- *The span gate.* Confirmed per interaction. The leaf's own `setState` renders for 25ms and
  React emits **no span anywhere in the tree**; the mount renders five components and names none
  of them; production emits zero spans with `actualDuration` null and names minified to `b`, `m`,
  `h`, `g`, `v`. Two details worth adding. React emits **phase** spans as well as component spans
  — `Update`, `Mount`, `Update Blocked` — and distinguishes the component ones by prefixing the
  name with **U+200B**, which is the only way to tell them apart. And `mount-toggle` produced a
  `Mount` phase span that the original table did not record.
- *A second blind spot, stacked on the first.* The `state-owner-self` interaction produced **no
  long animation frame either**: ~25ms of render is under the threshold. The one interaction React
  declines to name is the one the trigger never fires for, and the only evidence for it is the
  fiber tree. That is an independent argument for the hook being primary, and it was not visible
  until both signals were captured for the same interaction.
- *Frame decomposition.* The 93% residual reproduced at 89–92%, with 90–93% of in-frame samples
  carrying no JavaScript. Both scenarios now sit in one dump, which is stronger than the original:
  adding one `offsetHeight` read moves **all three** signals together — LoAF goes from naming 11%
  of the frame to naming 85%, `forcedStyleAndLayoutDuration` appears at 95–104ms, and the
  empty-stack share falls from ~90% to 9–20%. `styleDuration` and `layoutDuration` stay 0 in both.
- *The residual is work, not idle.* Reproduced, and now in the repo: the fixture publishes its own
  probe on `window.__frameblameFixtureProbe`, which the capture stores verbatim. A 14–16ms
  listener is followed by a 123–153ms wait for a `MessageChannel` message it posted itself.
- *Third-party attribution.* Reproduced exactly. One frame, three script entries, character
  offsets 9092, 9268 and 9443 resolving to `app.js:188`, `:192` and `:196` — the three
  registration lines — with `sourceFunctionName` empty on all three and `vendor.js` named by none
  of them. Identical in both build modes, because the fixture serves its scripts from `public/`
  byte-for-byte. `forcedStyleAndLayoutDuration` 108–124ms nested inside a 111–127ms script entry.
- *Presentation beyond `duration`.* 26–43ms across the vanilla fixtures, against 23–42ms.
- *Production resolving better than development.* Reproduced: 83% of samples in the declared line
  range against 76% in development.
