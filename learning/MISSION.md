# Mission: Browser performance, measured

## Why

Isaac is building `frameblame` — a dev-time tool that attributes janky frames to the React
component and line that caused them. He has discovered that the field's hardest problems are
measurement problems, and that he was making design decisions on API semantics he had
half-absorbed. He wants browser rendering and measurement as a *field*, not as whatever
`frameblame` happens to need this week, so that the engine's design decisions come from
understanding rather than from a subagent catching the error afterwards.

## Success looks like

- Reading any performance trace — LoAF entry, profiler trace, DevTools panel — and saying where
  each number came from in the event loop, and what it excludes.
- Predicting which API will see a given performance problem *before* instrumenting anything.
- Holding the Core Web Vitals (INP especially) as consequences of the rendering pipeline rather
  than as separate metrics to memorise.
- Reading a spec section and knowing whether Chrome actually implements it that way.

## Constraints

- Learning alongside building, so lessons must be short and each must land a single win.
- Grounded in `frameblame`'s own measured data wherever possible — he has four fixtures and
  several hundred real samples, and abstract examples will not stick next to that.
- The project's honesty bar applies to the lessons too: every millisecond figure carries the
  build mode and CPU throttle that produced it, and no claim goes in unsourced.

## Out of scope

- Framework-specific optimisation advice (React re-render hygiene, memoisation patterns).
- Server-side and network performance — TTFB, caching, protocol. The mission is the frame.
- Building `frameblame` itself. That work happens in the parent repo; this workspace only
  teaches the ground it stands on.
