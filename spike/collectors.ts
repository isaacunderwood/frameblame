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
 * measures out at a median cadence of 12.1ms. The request is left at 5 so the
 * clamp stays visible in every dump rather than being pre-applied here.
 */
export const REQUESTED_SAMPLE_INTERVAL_MS = 5;

/**
 * Capacity in samples. A 24-press replay at a ~12ms cadence over a minute is a
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

    function describeCommit(root: ReactFiberRoot): unknown[] {
      const components: unknown[] = [];
      const pending: ReactFiber[] = [];
      const firstFiber = root.current;
      if (firstFiber) pending.push(firstFiber);

      // Iterative so a deep tree cannot overflow the stack inside a callback
      // React is waiting on, and capped so a pathological tree cannot turn
      // collection itself into the slow thing being measured.
      let visited = 0;
      while (pending.length > 0 && visited < 10_000) {
        const fiber = pending.pop();
        if (!fiber) break;
        visited += 1;

        const name = componentName(fiber.type);
        if (name !== null) {
          components.push({
            name,
            tag: fiber.tag,
            lanes: fiber.lanes ?? null,
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

        if (fiber.child) pending.push(fiber.child);
        if (fiber.sibling) pending.push(fiber.sibling);
      }

      return components;
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
          const components = describeCommit(root);

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
