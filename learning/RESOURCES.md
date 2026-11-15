# Browser performance resources

Curated, high-trust only. Every entry has been opened and read during a session, not recalled.

## Knowledge

- [The rendering event loop — Chris Harrelson](https://github.com/chrishtr/rendering/blob/master/rendering-event-loop.md)
  Written by Chromium's rendering lead. The eight ordered steps of "update the rendering", and
  the crucial note that the spec has no concept of style or layout computation. Use for:
  anything about *when* browser work happens relative to your code.

- [HTML Standard — event loop processing model](https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model)
  The normative authority behind the above. Dense. Use for: settling an argument about
  ordering, or checking what is actually specified versus what Chromium adds.

- [W3C — Long Animation Frames API](https://w3c.github.io/long-animation-frames/)
  Normative definition of `PerformanceLongAnimationFrameTiming` and
  `PerformanceScriptTiming`. Use for: what a field means, the 5ms script reporting threshold,
  and the rule that nested entry points are merged.

- [Chrome for Developers — Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
  The practical companion to the spec. Use for: thresholds, what Chrome actually ships, and
  worked examples of reading an entry.

- [WICG — JS Self-Profiling API](https://wicg.github.io/js-self-profiling/)
  Normative definition of `Profiler`, `ProfilerTrace` and the four interned arrays. Use for:
  the `Document-Policy` gate, and the fact that `ProfilerFrame.line` is where a function is
  *defined*, not what line is executing.

- [MDN — PerformanceScriptTiming](https://developer.mozilla.org/docs/Web/API/PerformanceScriptTiming/sourceCharPosition)
  Use for: a quick, accurate field-by-field read when the spec is heavier than the question
  deserves.

## Wisdom (Communities)

Not yet established. Candidates to evaluate when Isaac wants them — he has not been asked
whether he wants to join anything, so nothing here is a recommendation yet:

- The `web-vitals` and `long-animation-frames` GitHub issue trackers, where the people who
  designed these APIs answer semantic questions directly. Highest signal per word available.
- `#performance` on the W3C/WICG Matrix and the WebPerf Slack, for questions that are really
  "is this a Chrome bug or did I misread the spec".

## Gaps

- **No trusted source yet for Core Web Vitals / INP as a consequence of the pipeline.** The
  mission names this explicitly. `web.dev` has the material but needs checking for currency
  before it goes in this list.
- **Nothing yet on the compositor.** The 23–42ms between `paintTime` and `presentationTime` is
  unexplained by anything listed here, and it is a sizeable fraction of what users feel.
- **Nothing on Firefox or Safari.** Everything above is Chromium. The field is wider than that
  and the blind spot should be named rather than absorbed.
