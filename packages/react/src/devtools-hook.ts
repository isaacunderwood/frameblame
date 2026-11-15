/**
 * Access to React's DevTools global hook, which is where component identity
 * comes from.
 *
 * React has no public API that says "a commit just happened, and these
 * components rendered in it". What it does have is a backdoor it checks for at
 * module-evaluation time: if `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` exists and
 * advertises fiber support, React calls into it after every commit. That is the
 * same door the DevTools extension, React Scan and why-did-you-render all walk
 * through.
 *
 * This is the *primary* path in development, and the choice was nearly made the
 * other way. React 19.3's development build also emits named render spans as
 * `performance.measure` entries, with no hook required, which looked like a
 * straight replacement for walking fibers. It is not: those spans are emitted
 * only for a component whose props changed by identity, so they are
 * structurally blind to the component that called `setState` on itself, to
 * context consumers, and to everything on first mount — measured, the spans
 * named none of five components that each rendered for 25ms on mount. A tool
 * keyed on them reports "nothing happened" for a frame it should have blamed.
 * The hook saw every component in every case tested. See `findings.md`.
 *
 * The ordering constraint is absolute and is the thing that breaks first: React
 * reads the hook when the renderer module is evaluated, so a hook installed
 * after `react-dom` has loaded is never called. Nothing reports an error in
 * that case; commits simply never arrive. The adapter's job is to be early.
 *
 * This module deliberately does not walk fiber trees, read component names, or
 * subscribe to commits. The spike established that `actualDuration` is in fact
 * populated on fibers in a development build — contrary to the assumption that
 * it was profiling-build-only, and agreeing with React's own measure to within
 * a millisecond — so a commit record is worth building. It is not built here
 * yet, because its shape should follow the engine's needs rather than precede
 * them.
 *
 * When it is built, a component's own cost is
 * `actualDuration − Σ children.actualDuration`, which is what React computes
 * internally. It is emphatically not `selfBaseDuration`, which describes the
 * previous full render and was 8% out on the measured fixture.
 *
 * In a production build the hook still fires on every commit, but the names it
 * yields are minified, so it stops being the component signal there. Production
 * identity comes from the profiler's stack resolved through the shipped source
 * map, whose `names` field recovers the original component name — no hook
 * involved.
 */

/**
 * The global React looks for. Spelled out as a constant because it is also the
 * key the deferred build-time pieces and the spike must agree on exactly, and a
 * typo in it fails silently rather than loudly.
 */
export const REACT_DEVTOOLS_GLOBAL_HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

/**
 * The subset of the hook this tool relies on.
 *
 * Narrow on purpose. The real object the DevTools extension installs has
 * dozens of members, and depending on more of them than we need is how an
 * adapter breaks on a React minor. `supportsFiber` is included because React
 * checks it before calling the commit callbacks: a hook without it is ignored.
 */
export interface ReactDevToolsHook {
  readonly supportsFiber: boolean;
  /** Renderer id to renderer object, populated as renderers inject themselves. */
  readonly renderers: Map<number, unknown>;
  onCommitFiberRoot?: (
    rendererId: number,
    root: unknown,
    priorityLevel: unknown,
    didError: boolean,
  ) => void;
}

/**
 * Reports whether a React DevTools hook is present on the given global.
 *
 * Takes the global object rather than reading `globalThis` so the check is
 * callable from a context that is inspecting another realm — and so it is
 * testable without a browser. A `true` result means a hook object exists and
 * claims fiber support; it does not mean a React renderer has registered with
 * it yet, which is a separate and later event.
 *
 * A `false` result is the trigger for the source-level attribution tier: frames
 * still get a file and a line, just not a component name.
 */
export function hasReactDevToolsHook(target: object): boolean {
  const hook: unknown = (target as Record<string, unknown>)[
    REACT_DEVTOOLS_GLOBAL_HOOK_KEY
  ];

  return (
    typeof hook === 'object' &&
    hook !== null &&
    (hook as { supportsFiber?: unknown }).supportsFiber === true
  );
}
