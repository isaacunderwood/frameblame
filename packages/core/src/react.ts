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
 * commit with a frame, or compute self time — see the warning on
 * `RenderedFiber.actualDurationMs`, which is the one piece of arithmetic here
 * that the captured records cannot support.
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
   * in the corpus's `spans` development run, `App` reads 151.7ms over five
   * children of ~25.2ms each, so summing the list naively gives 277.8ms for a
   * commit that took 151.7ms, and reports `App` — which did not re-render at
   * all, its child did — as 5.9x its real contribution.
   *
   * Self time is `actualDuration - sum(children.actualDuration)`, which is what
   * React itself computes. **But see the note on `ReactCommit.components`: the
   * captured records carry no parent links, so that subtraction is not
   * generally computable from a dump.** It is deliberately not offered as a
   * function here.
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
   * v0.1 spike compared, and the corpus shows worse: in a commit where four
   * fibers bailed out with `actualDuration` 0, every one of them still reported
   * 25.1-25.3ms here, carried over from a previous render. Reading it would
   * attribute ~101ms of work to a commit that did 25.2ms.
   */
  readonly selfBaseDurationMs: number | null;
}

/**
 * One commit, as `onCommitFiberRoot` reported it.
 *
 * **`components` is flat and carries no parent links.** That is a property of
 * the capture, not of React: the collector walked the fiber tree and recorded
 * each component's name and timings without its position in the tree. The
 * consequence is specific and worth stating before anyone builds on it — self
 * time, which needs a component's children, is recoverable from these records
 * only when the tree's shape is known from somewhere else. It happens to be
 * known for both React fixtures in the corpus, which are one root over flat
 * siblings. It would not be for a real app.
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
   * `committedAtMs` ran to 50.6ms, so a post-commit is not safely inside the
   * same frame as its commit.
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
   * Measured at 0-0.7ms.
   */
  readonly collectionCostMs: number;
  /** Flat, unordered with respect to the tree. See the note on this interface. */
  readonly components: readonly RenderedFiber[];
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
