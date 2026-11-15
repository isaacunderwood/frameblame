import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

/*
 * The fixture's entry point: mounts App and nothing else.
 *
 * It deliberately installs no instrumentation. Whatever observes this app —
 * the LoAF observer, the profiler, the DevTools hook shim — is injected from
 * outside the page, because an in-page observer would be script running inside
 * the very frames the fixture exists to produce.
 *
 * Deliberately no `StrictMode`. In development it invokes render bodies twice,
 * so each component would burn ~50ms and the initial mount would cost double
 * the 140ms the ground truth declares — figures that then describe no real
 * app. The span-gate verdicts themselves would survive the change, since a
 * double invocation does not alter `memoizedProps` identity across commits,
 * but the fixture has to be the app its own measurements describe.
 */

const container = document.querySelector('#root');
if (!container) throw new Error('index.html is missing #root');

createRoot(container).render(<App />);
