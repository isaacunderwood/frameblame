import { useState } from 'react';

import { BumpCountContext } from './bumpCountContext.ts';
import { BURN_MS, burn } from './burn.ts';
import {
  ContextConsumer,
  DeepEqualProps,
  LateMount,
  PropsChanged,
  StateOwner,
} from './causes.tsx';

/**
 * The fixture's shell: two of the three triggers, and the five re-render causes
 * beneath them. The third trigger lives on `StateOwner`, with the component it
 * re-renders, because the point of that case is that nothing outside the
 * component is involved.
 *
 * App is itself one of the subjects, not just the harness. It owns the state
 * both the `bump` and `mount / unmount` buttons update, which puts it in the
 * same blind spot as `StateOwner`: a component re-rendering because of its own
 * `setState` has unchanged props and so is never given a `performance.measure`
 * span, no matter how long it ran. `derive-in-render` showed the same thing
 * from the other direction — there, App's `actualDuration` was *larger* than
 * the child's and React named only the child. So App burns `BURN_MS` here too,
 * deliberately, to make a fixture in which the unnameable component is also an
 * expensive one.
 *
 * What this component deliberately does not do: no `useMemo`, no `useCallback`,
 * no stable identity for the object handed to `DeepEqualProps`, and no
 * `React.memo` anywhere. Those are the fixes a reviewer would reach for, and
 * each of them deletes one of the five conditions the fixture declares.
 *
 * The heading and the paragraph are plain host elements. They add no component
 * fibers to the commit, so they cannot change which components render or which
 * are given a span — the two things `ground-truth.json` asserts.
 */

/** The styling exists only so a human driving the fixture by hand can read it. */
const SHELL_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  margin: '0 auto',
  maxWidth: '45rem',
  padding: '2rem 1.5rem',
};

export function App() {
  const [n, setN] = useState(0);
  const [showLateMount, setShowLateMount] = useState(false);

  // The state owner's own cost, and the one most likely to be reported as
  // nothing at all.
  burn(BURN_MS);

  return (
    <BumpCountContext.Provider value={n}>
      <main style={SHELL_STYLE}>
        <h1 style={{ fontSize: '1.125rem' }}>Re-render causes</h1>
        <p style={{ opacity: 0.7 }}>
          Fixture: spans. Each component below burns ~25ms; see ground-truth.json.
        </p>
        <p>
          <button
            data-fixture="bump"
            onClick={() => {
              setN((v) => v + 1);
            }}
            type="button"
          >
            bump
          </button>{' '}
          <button
            data-fixture="mount-toggle"
            onClick={() => {
              setShowLateMount((v) => !v);
            }}
            type="button"
          >
            mount / unmount
          </button>
        </p>
        <PropsChanged n={n} />
        <ContextConsumer />
        <StateOwner />
        <DeepEqualProps config={{ k: 'constant' }} />
        {showLateMount ? <LateMount /> : null}
      </main>
    </BumpCountContext.Provider>
  );
}
