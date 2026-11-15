import { useContext, useState } from 'react';

import { BumpCountContext } from './bumpCountContext.ts';
import { BURN_MS, burn } from './burn.ts';

/**
 * The five re-render causes, side by side.
 *
 * Every component in this file burns `BURN_MS` in its render body and does
 * nothing else. They are identical in cost and differ only in why React
 * re-rendered them: changed props, a changed context, their own `setState`,
 * a first mount, or a fresh-but-deep-equal props object. Keeping them in one
 * file is the point — the exhibit is the comparison, and a reader has to be
 * able to see all five conditions at once.
 *
 * What this module deliberately does not do: nothing here is memoised, keyed,
 * split, or otherwise optimised. `DeepEqualProps` is handed a brand new object
 * literal on every render on purpose. Every "fix" an editor or a lint rule
 * might suggest in this file destroys one of the five conditions.
 *
 * ---------------------------------------------------------------------------
 * Why these five, and what React does with them
 * ---------------------------------------------------------------------------
 *
 * React 19.3's development build reports render work twice, by two different
 * mechanisms with different coverage, and this fixture exists to pin down the
 * difference permanently:
 *
 * 1. Fiber `actualDuration`, readable from the DevTools global hook's
 *    `onCommitFiberRoot`. Populated for *every* component fiber in the
 *    development build.
 * 2. A `performance.measure` entry per component — a named, observable
 *    `PerformanceEntry` on the shared `performance.now()` timeline, which is
 *    why it is so tempting to key a tool on. It is emitted for only a *subset*
 *    of the components that rendered, and the rule is not cost.
 *
 * The rule is a props-identity gate. From `react-dom-client.development.js`
 * (19.3.1) at lines 4441-4443, a component gets a `performance.measure` only
 * if all of:
 *
 *     fiber.memoizedProps !== null
 *     fiber.alternate !== null                  // i.e. not a first mount
 *     alternate.memoizedProps !== fiber.memoizedProps
 *
 * and then, at :4451, only if the resulting props diff contains at least one
 * entry (`1 < child.length`, the array having been seeded with one header
 * row). Fail any of those and React calls `console.timeStamp` instead (:4479),
 * which produces no `PerformanceEntry` of any kind — so from the outside the
 * component looks like it did not render at all.
 *
 * Applied to the five cases here, that gate explains every row of the measured
 * table in `ground-truth.json`:
 *
 * - `PropsChanged` receives `n`, which changes, so the diff is non-empty and
 *   it gets a span. This is the easy case, and the only one most tools see.
 * - `ContextConsumer` has no props at all. `<ContextConsumer />` does produce
 *   a fresh empty props object each render, so the identity check passes, but
 *   the diff of `{}` against `{}` is empty — no span, however long it ran.
 * - `StateOwner` is in the same position: its own `setState` re-renders it
 *   without changing its props, so it gets no span. This is the case that
 *   matters most, because the component that owns the state an interaction
 *   updates is the single most common real culprit.
 * - `LateMount` has no `alternate` on the render that is expensive — a first
 *   mount is structurally invisible to the gate.
 * - `DeepEqualProps` gets a span, and the reason is worth knowing: the diff
 *   walker pushes an entry for `config` *before* it recurses into it (:4329),
 *   because the two objects are referentially unequal. The recursion then
 *   finds them deeply equal and only relabels that entry (:4337-4339). React
 *   does have a "deeply equal props, consider memoization" warning for this,
 *   but it is gated on `100 < fiber.actualDuration` (:4455), which 25ms never
 *   trips. So the span arrives looking exactly like a legitimate one.
 *
 * The conclusion the project draws from this, recorded in `findings.md` as the
 * most consequential error of the v0.1 spike's first draft: the spans are
 * corroboration, never the primary component signal. A tool keyed on them
 * reports "nothing happened" for a 50ms frame whose cause is a leaf's own
 * `setState`. The hook plus `actualDuration` is primary.
 */

export interface PropsChangedProps {
  /** Incremented by App's bump button, so this prop genuinely changes. */
  readonly n: number;
}

/**
 * Re-renders because its props changed: the one case React's span gate admits,
 * and the case a span-keyed tool would mistake for the whole story.
 */
export function PropsChanged({ n }: PropsChangedProps) {
  burn(BURN_MS);
  return <p>props {n}</p>;
}

/**
 * Re-renders because a context it consumes changed. Its props never change,
 * and it has none to change, so React gives it no span however long it runs.
 */
export function ContextConsumer() {
  const value = useContext(BumpCountContext);
  burn(BURN_MS);
  return <p>context {value}</p>;
}

/**
 * Re-renders because of its own `setState`. Props never change.
 *
 * The regression this fixture guards against is a tool that reports nothing
 * for this component's frame, so its button is the single most important
 * trigger in the fixture.
 */
export function StateOwner() {
  const [own, setOwn] = useState(0);
  burn(BURN_MS);
  return (
    <p>
      own {own}{' '}
      <button
        data-fixture="state-owner-self"
        onClick={() => {
          setOwn((v) => v + 1);
        }}
        type="button"
      >
        self
      </button>
    </p>
  );
}

/**
 * Expensive on first mount only, which is the render that has no `alternate`
 * and therefore cannot pass the gate. Mounting is also when a real component
 * is most often at its most expensive.
 */
export function LateMount() {
  burn(BURN_MS);
  return <p>mounted</p>;
}

export interface DeepEqualPropsProps {
  /**
   * Passed as a fresh object literal on every render of App, deliberately.
   * Hoisting it to module scope, wrapping it in `useMemo`, or flattening it to
   * a string all remove this fixture's fifth condition.
   */
  readonly config: { readonly k: string };
}

/**
 * Props are a fresh object on every render but deep-equal to the last.
 *
 * This is the inverse failure: it gets a span on every render — on some
 * interactions it is the *only* component given one — while having done
 * nothing a user would call a change. A tool that ranked by span presence
 * would rank this component above the one that actually caused the frame.
 */
export function DeepEqualProps({ config }: DeepEqualPropsProps) {
  burn(BURN_MS);
  return <p>deep {config.k}</p>;
}
