/**
 * The page-side half of the spike: the three collectors, installed before any
 * of the measured app's own scripts run.
 *
 * Everything in `installCollectors`' callback is serialised and evaluated
 * inside the page, so it can close over nothing from this module and must be
 * written as if it were a `<script>` in the fixture's own document. It collects
 * and does not interpret: no attribution, no correlation, no scoring. Shaping
 * the records happens in Node, against whole runs, where getting it wrong is
 * cheap and does not perturb the frames being measured.
 *
 * What this deliberately does not do is render anything, log to the page, or
 * touch the DOM. The invariant that the UI lives in a separate tab applies with
 * more force to the collector than to the viewer: an observer that paints is an
 * observer that lands inside the frames it reports on.
 */

import type { Page } from '@playwright/test';

/**
 * Chromium hides LoAF's `sourceLine` and `sourceColumn` behind Blink features
 * that are off by default. Off here too, because the point is to see what a
 * user's browser reports; set `SPIKE_SOURCE_LINE_COLUMN=1` to confirm what the
 * flag would add.
 */
export const SOURCE_LINE_COLUMN_FEATURES = [
  'LongAnimationFrameSourceLineColumn',
  'LongAnimationFrameSourceLineColumnInterface',
];

/**
 * 5ms requested. Chrome clamps the sampling period, and the clamped value is
 * recorded alongside the trace: `findings.md` establishes the floor is a
 * compile-time constant of 10ms in Blink that no flag reads, and that Chrome
 * snaps *up* rather than down, so a request of 5 is answered with 10 and
 * measures out at a median cadence of 12.1ms (the v0.1 replay; 12.2ms in the
 * corpus capture before the v0.3 re-capture and 14.5ms in that re-capture, so
 * the cadence is a property of the session — see `OBSERVED_SAMPLE_CADENCE_MS`
 * in `packages/core/src/profiler.ts`). The request is left at 5 so the clamp
 * stays visible in every dump rather than being pre-applied here.
 */
export const REQUESTED_SAMPLE_INTERVAL_MS = 5;

/**
 * Capacity in samples. A 24-press replay at a 12-15ms cadence over a minute is a
 * few thousand samples, so this is roughly an order of magnitude of headroom —
 * and a buffer that fills silently discards the end of the run, which is the
 * half a reader would least suspect.
 */
export const MAX_PROFILE_SAMPLES = 400_000;

export interface CollectorOptions {
  /**
   * Install React's DevTools global hook.
   *
   * A knob rather than a constant because the spike has to be able to answer
   * whether React's own performance-track spans depend on the hook being
   * present. They do not — `findings.md` records 44.3ms of `OrderTable` span
   * with `SPIKE_SKIP_REACT_HOOK=1` — and that is why the spans and the fibers
   * are two independent signals rather than one.
   */
  readonly installReactHook: boolean;
  /**
   * Construct the profiler here, in the init script, rather than waiting to be
   * told to from Node.
   *
   * Needed only by a fixture whose declared claim covers the page's first
   * mount: by the time Node can evaluate anything in the page, the mount has
   * happened. Everything else is better off starting the profiler after load,
   * so that module evaluation and first paint are not in the trace.
   */
  readonly profileFromLoad: boolean;
  readonly sampleInterval: number;
  readonly maxBufferSize: number;
}

/**
 * Installs the three collectors into the page before any of its own scripts
 * run.
 *
 * The ordering is not a nicety. React reads
 * `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` while the renderer module is being
 * evaluated, so a hook installed even one script tag too late is never called
 * and commits silently never arrive. `addInitScript` is the only hook point
 * early enough.
 *
 * The LoAF and measure observers are created with `buffered: true`, so entries
 * that landed before this script ran are not lost. The profiler has no such
 * affordance — a sample not taken is gone — which is what `profileFromLoad` is
 * for.
 */
export async function installCollectors(
  page: Page,
  options: CollectorOptions,
): Promise<void> {
  await page.addInitScript((settings: CollectorOptions) => {
    const withReactHook = settings.installReactHook;

    const loaf: unknown[] = [];
    const commits: unknown[] = [];
    const measures: unknown[] = [];

    let profiler: Profiler | null = null;
    let profileStartedAt = 0;
    let requestedSampleInterval = 0;

    // --- React: component identity, via the DevTools backdoor ---------------

    /**
     * Resolves a fiber's `type` to a displayable name, or null for host
     * elements and text, which are not components and would bury the two that
     * matter under two hundred `div`s.
     */
    function componentName(type: unknown): string | null {
      if (typeof type === 'function') {
        const component = type as { displayName?: unknown; name?: unknown };
        if (typeof component.displayName === 'string') return component.displayName;
        if (typeof component.name === 'string' && component.name !== '') {
          return component.name;
        }
        return '(anonymous)';
      }

      // `memo()` and `forwardRef()` wrap the real component in an object.
      if (typeof type === 'object' && type !== null) {
        const wrapper = type as {
          displayName?: unknown;
          render?: unknown;
          type?: unknown;
        };
        if (typeof wrapper.displayName === 'string') return wrapper.displayName;
        if (wrapper.render !== undefined) return componentName(wrapper.render);
        if (wrapper.type !== undefined) return componentName(wrapper.type);
      }

      return null;
    }

    /**
     * The commit's component fibers, flat, each carrying an `id` and the `id`
     * of its nearest component ancestor as `parentId`.
     *
     * **The id scheme.** A fiber's `id` is its index in the returned array, so
     * it is meaningful within one commit's record and nowhere else. Fiber
     * objects cannot supply a longer-lived identity: React double-buffers the
     * tree, so the object a component is represented by alternates between two
     * from one commit to the next. Ids are assigned in walk order, and the walk
     * only reaches a fiber after it has emitted the fiber's ancestors, so a
     * `parentId` always names an earlier entry — a reader can link the list in
     * one pass, and a walk cut short by the cap below loses descendants but
     * never leaves a dangling parent.
     *
     * **Why "nearest component ancestor" rather than React's own parent.**
     * Host elements and text are not recorded, so a component's real parent
     * fiber is often a `div` that is not in the list. Linking to the nearest
     * ancestor that *is* recorded keeps the subtraction
     * `actualDuration - sum(children.actualDuration)` meaningful over the
     * recorded set, where a component's children are its nearest component
     * descendants. React computes the same subtraction over every direct fiber
     * child, host fibers included; the difference is the host fibers' own
     * time, which this scheme charges to the component that rendered them —
     * the component a developer would have to change. `parentId` is `null` for
     * a component with no component above it.
     *
     * **Whether a fiber rendered in this commit.** The walk visits every
     * component fiber in the committed tree, and many of them did no work in
     * this commit. Two different things can be true of one that did not, and
     * they leave different evidence, so both are recorded raw:
     *
     * 1. React *cloned* the fiber for this render, called nothing, and bailed
     *    out. `createWorkInProgress` resets a clone's `actualDuration` to `-0`
     *    rather than copying it, and masks its `flags` down to the static bits,
     *    which clears `PerformedWork` (bit 0); only a component whose render
     *    function actually ran sets it again. React DevTools reads exactly that
     *    bit to decide whether a function, class, forwardRef, memo or context
     *    consumer fiber rendered. So the raw `flags` are recorded, not a
     *    boolean made from them, because which bits matter is an
     *    implementation detail DevTools itself calls leaked, and a reader can
     *    re-derive a boolean but never recover the bits from one.
     * 2. React *never reached* the fiber: an ancestor bailed out with no work
     *    below it, so React did not clone its children at all and the
     *    committed tree points at the previous commit's fiber objects. Those
     *    keep whatever `actualDuration` and `flags` their last render left,
     *    `PerformedWork` included. React's own `bubbleProperties` recognises the
     *    case as `alternate.child === child` and leaves those children's
     *    durations out of the parent's sum, so a self-time subtraction that
     *    subtracted them would go negative. That test needs every fiber on the
     *    path, host fibers included, and host fibers are not recorded, so it is
     *    applied here, during the walk, and carried down as `carriedOver`.
     *
     * `hasAlternate` is the remaining raw fact: `false` is a fiber mounting in
     * this commit, which DevTools always counts as rendered.
     *
     * Checked against the React the fixtures pin, 19.3.1,
     * `react-dom/cjs/react-dom-client.development.js`: `createWorkInProgress`
     * at :5105-5129, the static mask at :5130, the bailout that skips cloning
     * children at :11883-11894, and `bubbleProperties` at :12823-12842. The
     * DevTools side is `didFiberRender` in
     * `react-devtools-shared/src/backend/fiber/shared/DevToolsFiberChangeDetection.js`
     * and its call in `recordProfilingDurations`, which also requires
     * `prevFiber !== fiber` — the carried-over case.
     */
    function describeCommit(root: ReactFiberRoot): {
      components: unknown[];
      truncated: boolean;
    } {
      const components: unknown[] = [];
      // Each pending fiber travels with the id of the nearest component above
      // it, because by the time it is popped the walk has moved elsewhere and
      // a fiber's `return` would lead back through unrecorded host fibers. It
      // carries whether it is a previous commit's object for the same reason.
      const pending: {
        fiber: ReactFiber;
        parentId: number | null;
        carriedOver: boolean;
      }[] = [];
      // The root's current fiber is this commit's finished work, so it is
      // never carried over itself; its children may be.
      const firstFiber = root.current;
      if (firstFiber)
        pending.push({ fiber: firstFiber, parentId: null, carriedOver: false });

      // Iterative so a deep tree cannot overflow the stack inside a callback
      // React is waiting on, and capped so a pathological tree cannot turn
      // collection itself into the slow thing being measured.
      let visited = 0;
      while (pending.length > 0 && visited < 10_000) {
        const next = pending.pop();
        if (!next) break;
        const { fiber, parentId, carriedOver } = next;
        visited += 1;

        const name = componentName(fiber.type);
        let idForChildren = parentId;
        if (name !== null) {
          const id = components.length;
          idForChildren = id;
          components.push({
            id,
            parentId,
            name,
            tag: fiber.tag,
            lanes: fiber.lanes ?? null,
            flags: fiber.flags,
            hasAlternate: fiber.alternate !== null,
            carriedOver,
            // Expected to be absent outside a profiling build; measured to be
            // present in React 19.3's development build, and to agree with the
            // profiler to within a millisecond. Recorded either way, because
            // "the field was there and we did not look" is the worse failure.
            //
            // Note for the engine: self time is
            // `actualDuration - sum(children.actualDuration)`, which is what
            // React itself computes. It is *not* `selfBaseDuration`, which is
            // the previous full render's base duration and measured 8% off.
            actualDuration: fiber.actualDuration ?? null,
            selfBaseDuration: fiber.selfBaseDuration ?? null,
          });
        }

        // A child's nearest component ancestor is this fiber if it is one,
        // and otherwise whatever this fiber's was. A sibling shares this
        // fiber's parent, so it inherits `parentId` unchanged.
        //
        // A child is a previous commit's object if this fiber is one, or if
        // React bailed out of this fiber without cloning its children — the
        // exact test `bubbleProperties` uses. A sibling was cloned, or not,
        // together with this fiber, so it inherits `carriedOver` unchanged.
        if (fiber.child) {
          pending.push({
            fiber: fiber.child,
            parentId: idForChildren,
            carriedOver: carriedOver || fiber.alternate?.child === fiber.child,
          });
        }
        if (fiber.sibling) pending.push({ fiber: fiber.sibling, parentId, carriedOver });
      }

      // Anything still pending is a fiber the cap kept out of the record. Its
      // ancestors' self times would then be overstated by its whole subtree,
      // so the commit says so rather than looking complete.
      return { components, truncated: pending.length > 0 };
    }

    const renderers = new Map<number, unknown>();
    let nextRendererId = 1;

    if (withReactHook) {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers,
        checkDCE() {
          /* React calls this to detect a dead-code-eliminated build. */
        },
        inject(renderer) {
          const rendererId = nextRendererId;
          nextRendererId += 1;
          renderers.set(rendererId, renderer);
          return rendererId;
        },
        onCommitFiberRoot(rendererId, root, priorityLevel, didError) {
          // `performance.now()` here is the end of the commit, not the start of
          // the render that produced it. The gap is the whole difficulty of the
          // join and is measured, not papered over.
          const committedAt = performance.now();
          const { components, truncated } = describeCommit(root);

          commits.push({
            // Tagged because both callbacks land in one array, and a reader
            // who has to tell them apart by which keys are present will
            // eventually guess wrong.
            kind: 'commit',
            committedAt,
            collectionCost: performance.now() - committedAt,
            rendererId,
            didError,
            priorityLevel: typeof priorityLevel === 'number' ? priorityLevel : null,
            components,
            truncated,
          });
        },
        onPostCommitFiberRoot(rendererId) {
          commits.push({
            kind: 'post-commit',
            postCommitAt: performance.now(),
            rendererId,
          });
        },
        onCommitFiberUnmount() {
          /* Not needed: unmounts carry no timing this spike reads. */
        },
        on() {
          /* DevTools' emitter, stubbed because React's dev build calls it. */
        },
        off() {
          /* As above. */
        },
        sub() {
          return () => {
            /* As above. */
          };
        },
        emit() {
          /* As above. */
        },
      };
    }

    // --- Long Animation Frames: which frames were bad ----------------------

    function serializeScript(script: PerformanceScriptTiming): unknown {
      return {
        name: script.name,
        entryType: script.entryType,
        startTime: script.startTime,
        duration: script.duration,
        executionStart: script.executionStart,
        invoker: script.invoker,
        invokerType: script.invokerType,
        sourceURL: script.sourceURL,
        sourceFunctionName: script.sourceFunctionName,
        sourceCharPosition: script.sourceCharPosition,
        // Expected to be undefined: specified, implemented behind a Blink
        // flag, and off by default. Their absence is the reason this project
        // resolves a character offset at all.
        sourceLine: script.sourceLine ?? null,
        sourceColumn: script.sourceColumn ?? null,
        pauseDuration: script.pauseDuration,
        // Browser work performed *inside* this script's duration, not
        // alongside it. Adding it to the frame's decomposition as a separate
        // slice double-counts; `findings.md` names that as the first thing an
        // engine must get right.
        forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
        // The same figure's two halves, which the spec defines the combined
        // one as the sum of. Missing from this projection until step 0.2 of
        // the v0.3 run, because it was written from ambient declarations that
        // missed them; captures before that carry them only in `toJSON`.
        // `null` rather than `0` where the browser has no such attribute: a
        // zero would claim it measured no forced style work, when it measured
        // nothing at all.
        forcedStyleDuration: script.forcedStyleDuration ?? null,
        forcedLayoutDuration: script.forcedLayoutDuration ?? null,
        windowAttribution: script.windowAttribution,
      };
    }

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const frame = entry as PerformanceLongAnimationFrameTiming;

        loaf.push({
          // Whatever Chrome chooses to serialise, kept so the dump shows which
          // fields the implementation actually has...
          toJSON: entry.toJSON() as Record<string, unknown>,
          // ...and the attribution read field by field, because `toJSON` is
          // not guaranteed to descend into the nested script entries and those
          // are the half that matters.
          scripts: Array.from(frame.scripts, serializeScript),
        });
      }
      // `buffered` so a frame that happened before this observer was created —
      // during page load, say — is not lost.
    }).observe({ type: 'long-animation-frame', buffered: true });

    // --- React's own performance-track measures ----------------------------

    /*
     * React 19.2 began emitting `performance.measure` entries describing render
     * and commit phases for the DevTools performance panel, on the same clock
     * as everything else. The v0.1 spike recorded them to find out whether they
     * were a better component signal than the fiber tree; `findings.md` found
     * they are not, because React emits one only when a component's props
     * changed by identity, leaving the `setState` owner, context consumers and
     * every first mount with no entry at all. They are corroboration, and this
     * collector's job is to keep them collectable so that remains checkable.
     *
     * Two traps, both recorded here because the data looks fine either way:
     *
     * 1. `detail.devtools` is a mutated module singleton, so `properties`,
     *    `color` and `tooltipText` describe the *last* measure React emitted
     *    rather than the entry in hand. Only `name`, `startTime` and `duration`
     *    can be trusted — except on the `"Update"` span, whose detail is
     *    rebuilt per emission and carries the originator of the update.
     * 2. React calls `performance.clearMeasures(name)` immediately after
     *    emitting, so these must be *observed*. Polling
     *    `getEntriesByType('measure')` finds nothing.
     */
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const measure = entry as ReactMeasureEntry;

        let detail: unknown;
        try {
          // Round-tripped rather than handed over live: the structured clone
          // Playwright would do on the way out cannot carry React's internals,
          // and a detail that fails to serialise must not take the whole
          // stream with it.
          detail = JSON.parse(JSON.stringify(measure.detail ?? null));
        } catch {
          detail = '<unserialisable>';
        }

        measures.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          entryType: entry.entryType,
          detail,
        });
      }
    }).observe({ type: 'measure', buffered: true });

    // --- The channel out ---------------------------------------------------

    window.__frameblameSpike__ = {
      profilerAvailable: typeof Profiler === 'function',
      timeOrigin: performance.timeOrigin,
      loaf,
      commits,
      measures,

      startProfile(sampleInterval, maxBufferSize) {
        requestedSampleInterval = sampleInterval;
        profileStartedAt = performance.now();
        profiler = new Profiler({ sampleInterval, maxBufferSize });
      },

      async stopProfile() {
        const active = profiler;
        const effectiveSampleInterval = active ? active.sampleInterval : null;
        const trace = active ? await active.stop() : null;

        return {
          trace,
          requestedSampleInterval,
          effectiveSampleInterval,
          startedAt: profileStartedAt,
          stoppedAt: performance.now(),
        };
      },

      mark(label) {
        const at = performance.now();
        performance.mark(label);
        return at;
      },

      now() {
        return performance.now();
      },

      /*
       * One agreed global through which a fixture may publish evidence only it
       * can collect.
       *
       * The `innerhtml-rebuild` fixture is why this exists. Its claim is not
       * merely that most of the frame is unattributable — the empty-stack
       * sample share already shows that — but that the unattributable part is
       * main-thread *work* rather than idle time. Nothing outside the page can
       * tell those apart: the evidence is how late a `MessageChannel` message
       * posted at the end of the listener is delivered, and how late the next
       * `requestAnimationFrame` fires. Only the fixture can measure that, and
       * without it one of the four findings this corpus exists to reproduce
       * would still rest on an unrepeatable probe.
       *
       * Deliberately a single, generically named global that is read verbatim
       * and never interpreted here: the alternative is fixture-specific
       * branching in the collector, which would make the capture a place where
       * fixtures are known about rather than driven.
       */
      fixtureProbe() {
        return window.__frameblameFixtureProbe ?? null;
      },

      frameCount() {
        return loaf.length;
      },

      /*
       * Clears the buffers without restarting the page. Load-time frames are
       * not what is being studied and leaving them in makes every file harder
       * to read — but note what this does *not* clear: the profiler, which is
       * started after this is called, and the page's own state.
       */
      reset() {
        loaf.splice(0);
        commits.splice(0);
        measures.splice(0);
      },
    };

    /*
     * Started last, so that every observer above is already listening and the
     * first sample cannot precede the records it will be correlated against.
     * Guarded on the constructor existing: without
     * `Document-Policy: js-profiling` there is no `Profiler` at all, and the
     * capture reports that as a hard error from Node rather than throwing here,
     * where the message would be buried in a page console nobody is reading.
     */
    if (settings.profileFromLoad && typeof Profiler === 'function') {
      window.__frameblameSpike__.startProfile(
        settings.sampleInterval,
        settings.maxBufferSize,
      );
    }
  }, options);
}
