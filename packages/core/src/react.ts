/**
 * React's two signals: the commits the DevTools global hook reports, and the
 * `performance.measure` spans React emits for its own performance track.
 *
 * They are not equally good, and which is which was the most consequential
 * error the v0.1 spike made. The **fiber tree from the hook is primary**: it
 * saw every component that rendered in every scenario tested. The **spans are
 * corroboration only**, because React emits one for a component only when its
 * props changed by identity — which makes them structurally blind to the
 * `setState` owner, to context consumers, and to every first mount. A tool
 * keyed on spans reports "nothing happened" for a 50ms frame caused by a leaf
 * component's own `setState`.
 *
 * And there is a second blind spot stacked on the first: that same interaction
 * renders for ~25ms and so produces **no long animation frame either**, being
 * under LoAF's 50ms threshold. The one interaction React declines to name is
 * also the one the trigger never fires for, and the only evidence for it is the
 * fiber tree. So an engine must not assume a commit it is handed has a frame
 * around it.
 *
 * What this module does not do: decide which component caused a frame, pair a
 * commit with a frame, or compute self time. Self time is the React tier's
 * arithmetic, over the parent links described at `CommitComponents` — which a
 * capture made before the collector recorded them does not have.
 *
 * **Clock.** Page-clock `performance.now()` milliseconds, shared with LoAF and
 * the profiler.
 */

/**
 * The zero-width space React prefixes a component span's name with.
 *
 * This is the only thing that distinguishes a component span from a phase
 * marker — `Update`, `Mount`, `Update Blocked` — and the alternative
 * discriminators do not work: `Mount` sits on the same `Components` track as
 * the component spans, so keying on the track string misclassifies it.
 *
 * Written as an escape rather than as a literal zero-width space, because an
 * invisible character inside a string comparison is the kind of thing that
 * survives review and then costs an afternoon.
 */
export const COMPONENT_SPAN_PREFIX = '​';

/**
 * One component fiber that rendered in a commit.
 *
 * Host elements and text nodes are not here: they are not components, and they
 * would bury the two that matter under two hundred `div`s.
 */
export interface RenderedFiber {
  /**
   * The component's display name — or its minified name in a production build,
   * where the corpus shows `b`, `m`, `h`, `g`, `v`, `_`.
   *
   * Minified names are not globally unique and not stable across builds: `h` is
   * `OrderTable` in one of the corpus's fixtures and `ContextConsumer` in
   * another. Anything caching by name must scope the cache to one bundle.
   */
  readonly name: string;
  /**
   * React's internal fiber tag, which discriminates component kinds. The
   * numbering is internal and unstable between React versions, and it is `0` on
   * all 150 fibers in the corpus — consistent with every one of them being a
   * function component, but carrying no information here either way.
   */
  readonly tag: number;
  /** React's lane bitmask, `0` on every corpus fiber by the time a commit is reported. */
  readonly lanes: number | null;
  /**
   * The **subtree's** render time, or `null` outside a development build.
   *
   * Not self time. Reading it as self time is the error that doubles a frame:
   * in the corpus's `spans` development run (4x), the `mount-toggle` commit's
   * `App` reads 151.2ms over five children of 25.1-25.4ms each, so summing the
   * list naively gives 277.2ms for a commit that took 151.2ms, and reports
   * `App` — whose own share is 25.2ms — as 6.0x its real contribution. (The
   * capture before the v0.3 re-capture gave 151.7ms, 277.8ms and 5.9x.)
   *
   * Self time is `actualDuration - sum(children.actualDuration)`, which is what
   * React itself computes, and the children it needs are the fibers whose
   * `parentId` names this one — see `LinkedFiber`. Captures made before the
   * collector recorded those links (every run in `corpus/` until the v0.3
   * re-capture) carry no tree, so for them the subtraction is computable only
   * where the tree's shape is known from somewhere else.
   *
   * Where this and a component span both existed for one component they agreed
   * to about a millisecond (45.0 against 45.0, 45.5 against 45.6), so the
   * corroboration is real — for the subset of components React chose to name.
   */
  readonly actualDurationMs: number | null;
  /**
   * The *previous* full render's base duration. Emphatically not self time, and
   * not a measurement of this commit at all.
   *
   * It measured 8% off the fiber's own render time on the one component the
   * v0.1 spike compared, and the corpus shows worse: in `spans`'
   * `state-owner-self` commit (development, 4x), four fibers bailed out —
   * three with `actualDuration` 0, and `App`, whose 25.2ms is its child's —
   * and every one of them still reported 25.0-25.7ms here, carried over from a
   * previous render. Reading it would attribute 101.1ms of work to a commit
   * that did 25.2ms.
   */
  readonly selfBaseDurationMs: number | null;
}

/**
 * An index into one commit's fiber list, and meaningful only within that
 * commit.
 *
 * Not a longer-lived identity because the capture has none to offer: React
 * double-buffers the fiber tree, so the object representing a component
 * alternates between two from one commit to the next. Matching a component
 * across commits is by name, scoped to one bundle — see `RenderedFiber.name`.
 */
export type FiberId = number;

/**
 * A fiber together with its position in the commit's component tree.
 *
 * `parentId` names the **nearest component ancestor**, not React's own parent
 * fiber. The two differ wherever a host element sits between components, and
 * host elements are not recorded. Over the recorded set the subtraction still
 * means what it should: a fiber's children are the fibers whose `parentId` is
 * its `id`, and `actualDurationMs - sum(children.actualDurationMs)` is its own
 * render time *plus* that of the host elements it rendered directly. React's
 * own subtraction runs over every direct child, host fibers included, so it
 * would give those host fibers their own share; charging it to the component
 * instead is the right blame, since the component is what a developer would
 * change.
 *
 * The subtraction is only sound over fibers that took part in this commit,
 * which is what `render` is for: the collector records every component fiber
 * in the committed tree, and some of them are a previous commit's objects
 * carrying a previous render's `actualDuration`. See `FiberRenderEvidence`.
 */
export interface LinkedFiber extends RenderedFiber {
  /** Its index in the commit's `fibers`. */
  readonly id: FiberId;
  /**
   * The nearest component ancestor's `id`, always lower than this fiber's own,
   * or `null` for a component with no component above it.
   */
  readonly parentId: FiberId | null;
  readonly render: FiberRenderEvidence;
}

/**
 * The raw evidence for whether a fiber rendered in its commit, recorded by the
 * same collector change as the parent links.
 *
 * Raw rather than a `rendered: boolean`, because "rendered" is the engine's
 * judgement to make and its inputs are React internals: a boolean the collector
 * computed could not be re-derived if the judgement turned out wrong, and the
 * capture cannot be repeated.
 *
 * Checked against the React the fixtures pin, 19.3.1, in
 * `react-dom/cjs/react-dom-client.development.js`. A component fiber in the
 * committed tree is one of three things:
 *
 * 1. **Rendered.** Its render function ran, which sets `PerformedWork`, bit 0
 *    of `flags` (`updateFunctionComponent` at :10584, `updateForwardRef` at
 *    :10138, `updateMemoComponent` at :10197, `updateClassComponent` at
 *    :11132). Its `actualDuration` is this commit's.
 * 2. **Cloned and bailed out.** React made a work-in-progress copy and called
 *    nothing. `createWorkInProgress` (:5105) resets the copy's `actualDuration`
 *    to `-0` rather than copying it (:5128, and the constructor at :5087), and
 *    masks `flags` to the static bits (:5130), which clears `PerformedWork`.
 *    `selfBaseDuration` *is* copied (:5150), which is why the corpus shows
 *    bailed-out fibers at 0ms actual and 25ms base.
 * 3. **Carried over.** An ancestor bailed out with no work beneath it, so
 *    React returned without cloning its children (:11883-11894) and the
 *    committed tree points at the previous commit's fiber objects. Their
 *    `actualDuration` and `flags` are whatever their last render left —
 *    `PerformedWork` included, so the flag alone misreads them as rendered.
 *    React's own `bubbleProperties` detects this case as
 *    `alternate.child === child` and leaves those children out of the
 *    parent's `actualDuration` (:12823-12842), so subtracting them from it is
 *    what would make a self time negative.
 *
 * React DevTools makes the same call in `recordProfilingDurations`: a fiber
 * counts if it has no previous fiber (a mount) or if it is not the previous
 * fiber itself (not carried over) and `didFiberRender` says so — which, for
 * function, class, forwardRef, memo and context consumer fibers, is the
 * `PerformedWork` bit, and for other kinds compares props, state and ref with
 * the previous fiber. (`react-devtools-shared/src/backend/fiber/renderer.js`
 * and `shared/DevToolsFiberChangeDetection.js`, read on GitHub's `main` on
 * 2026-11-15; DevTools is not in this repo's dependencies.)
 *
 * The corpus's two React fixtures are one root over flat siblings, so case 3
 * may simply never occur in them — and it does not: `carriedOver` is `false`
 * on all 150 fibers of the v0.3 re-capture. That is a property of the
 * fixtures, not evidence that it is rare.
 */
export interface FiberRenderEvidence {
  /** React's raw effect bitmask at commit time. Bit 0 is `PerformedWork`. */
  readonly flags: number;
  /** `false` when the fiber has no alternate, which is a fiber mounting in this commit. */
  readonly hasAlternate: boolean;
  /**
   * Whether this is a previous commit's fiber object that React never reached
   * in this render — case 3 above. Computed during the walk rather than
   * recorded raw, because the test runs on every fiber on the path, host fibers
   * included, and host fibers are not in the record.
   */
  readonly carriedOver: boolean;
}

/**
 * A commit's component fibers, and whether the capture recorded how they nest.
 *
 * A union on the capture rather than a nullable `parentId` on each fiber,
 * because linkage is a property of the collector that wrote the record, not of
 * any one fiber: a commit is linked throughout or not at all, and a nullable
 * field would make "this fiber is a root" and "nobody recorded this fiber's
 * parent" the same value.
 *
 * - `recorded`: the collector stored each fiber's `id`, `parentId` and render
 *   evidence, so self time is computable from the record alone. The two
 *   arrived in one collector change and self time needs both, so they are one
 *   variant rather than two independent optional halves.
 * - `unrecorded`: the fibers are flat, as every capture made before the v0.3
 *   collector change is. Self time is recoverable from these only when the
 *   tree's shape is known from somewhere else. It happens to be known for both
 *   React fixtures in the corpus, which are one root over flat siblings. It
 *   would not be for a real app.
 */
export type CommitComponents =
  | { readonly linkage: 'recorded'; readonly fibers: readonly LinkedFiber[] }
  | { readonly linkage: 'unrecorded'; readonly fibers: readonly RenderedFiber[] };

/**
 * One commit, as `onCommitFiberRoot` reported it.
 */
export interface ReactCommit {
  /**
   * When the commit *finished*. The hook is called after the commit, so this is
   * not the start of the render that produced it, and the gap is the whole
   * difficulty of pairing a commit with a frame. It is measured rather than
   * papered over.
   */
  readonly committedAtMs: number;
  /**
   * When React's post-commit pass finished, or `null`.
   *
   * `null` in a production build, where React never calls the hook's
   * `onPostCommitFiberRoot` at all — both production runs in the corpus have 24
   * and 5 commits and not one post-commit. In development the gap from
   * `committedAtMs` ran to 52.5ms (4x; 50.6ms in the capture before the v0.3
   * re-capture), so a post-commit is not safely inside the same frame as its
   * commit.
   */
  readonly postCommitAtMs: number | null;
  readonly rendererId: number;
  readonly didError: boolean;
  /**
   * React's scheduling priority for the update, or `null` — which is what
   * production reports, on every commit in the corpus.
   */
  readonly priorityLevel: number | null;
  /**
   * What the collector spent walking the tree inside React's own callback.
   *
   * Recorded because the observer is inside the frame it is reporting on: a
   * collector that cost 10ms would be contaminating its own measurement.
   * Measured at 0-0.9ms in the v0.3 re-capture (4x, both build modes), whose
   * walk also records each fiber's parent link and render evidence; 0-0.7ms in
   * the capture before, which recorded neither.
   */
  readonly collectionCostMs: number;
  /**
   * Whether the collector's walk hit its 10,000-fiber cap and left fibers out,
   * or `null` for a capture made before the collector recorded it.
   *
   * When `true`, every ancestor of a missing fiber has its self time overstated
   * by the missing subtree, and nothing in `components` shows which ones.
   */
  readonly truncated: boolean | null;
  /**
   * In the order the collector walked the tree, which visits a fiber's
   * ancestors before it. See `CommitComponents` for what is linked and when.
   */
  readonly components: CommitComponents;
}

/** One `[label, value]` row out of a span's detail, parsed but not trusted. */
export interface SpanProperty {
  readonly label: string;
  readonly value: string;
}

/** Who asked for the update a phase span describes. */
export interface UpdateOriginator {
  /**
   * The component that scheduled it, or `null`.
   *
   * `null` is real: the corpus's one `Update Blocked` span carries only
   * `[["Method name","root.render()"]]`, with no component row at all. Which is
   * why the rows are parsed by label and never by index.
   */
  readonly componentName: string | null;
  /** e.g. `setState()`, `root.render()`. */
  readonly methodName: string | null;
}

/**
 * One `performance.measure` entry React emitted.
 *
 * A union on what the entry is *for*, because the two kinds carry different
 * things and are told apart only by the zero-width prefix: component spans name
 * a component and list the props that changed, phase markers name a phase and
 * sometimes the originator of the update.
 *
 * Two traps, both recorded because the data looks fine either way:
 *
 * 1. React calls `performance.clearMeasures(name)` immediately after emitting,
 *    so these must be **observed**. Polling `getEntriesByType('measure')` finds
 *    nothing.
 * 2. `detail.devtools` is a mutated module singleton, so a *live* reader of
 *    `properties`, `color` or `tooltipText` may be looking at the last measure
 *    React emitted rather than the entry in hand. Only `name`, `startTime` and
 *    `duration` are trustworthy in general. The corpus's stored details happen
 *    to be per-entry correct — its collector serialises them inside the
 *    observer callback, and the 24 `OrderTable` spans in one run alternate
 *    their changed-props values exactly as the interaction did — but nothing
 *    attributes on them. They are a label on evidence, not the evidence.
 */
export type ReactSpan =
  | {
      readonly kind: 'component';
      /** The name with the zero-width prefix already stripped. */
      readonly componentName: string;
      readonly startTimeMs: number;
      readonly durationMs: number;
      /** Why React decided this component's props had changed. May be empty. */
      readonly changedProps: readonly SpanProperty[];
    }
  | {
      readonly kind: 'phase';
      /** `Update`, `Mount`, `Update Blocked` in the corpus. An open set. */
      readonly phase: string;
      readonly startTimeMs: number;
      readonly durationMs: number;
      /**
       * Present on `Update` spans, whose detail React rebuilds per emission.
       *
       * It appeared on only 5 of 24 keypresses in the v0.1 replay, so it is a
       * bonus rather than a tier — but when it is there it names the component
       * that called `setState`, which is exactly the component the span gate
       * declines to give a span to.
       */
      readonly originator: UpdateOriginator | null;
    };

/**
 * Everything React said during a capture.
 *
 * `hookInstalled` is separate from `commits` being empty, and the distinction
 * is load-bearing in both directions. Four of the corpus's eight runs have the
 * hook installed and no commits, because the page has no React in it. And
 * React's spans arrive with **no hook installed at all** — verified by
 * capturing with the hook suppressed — which is why these are two independent
 * signals rather than one.
 */
export interface ReactSignals {
  readonly hookInstalled: boolean;
  /** In `committedAtMs` order. */
  readonly commits: readonly ReactCommit[];
  /**
   * In `startTimeMs` order.
   *
   * Empty in every production run in the corpus: React emits these spans in a
   * development build only.
   */
  readonly spans: readonly ReactSpan[];
}
