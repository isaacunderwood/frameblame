import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/*
 * Serving configuration for the fixture, and nothing else. No instrumentation
 * is injected here: what observes this app is loaded from outside the page, so
 * that the observer is never script inside a measured frame.
 *
 * The one piece of configuration the whole tool depends on.
 *
 * `window.Profiler` does not exist unless the document was served with a
 * Document Policy authorising it. No feature detection can work around this and
 * no runtime flag enables it — the header is checked at document creation, so
 * getting it wrong means the deep signal is simply absent and the tool silently
 * falls back to its weakest tier.
 *
 * The token is the deprecated boolean `js-profiling` rather than its successor
 * `js-profiling-mode=eager`, because as of November 2026 the successor is only
 * an Intent to Prototype in Chromium while the boolean is what stable ships.
 * The spec says `js-profiling-mode` takes precedence where both are understood,
 * so this becomes a one-line change once it lands.
 *
 * https://wicg.github.io/js-self-profiling/#document-policy
 * https://groups.google.com/a/chromium.org/g/blink-dev/c/y3OkEzcrp24
 */
const PROFILING_HEADERS = {
  'Document-Policy': 'js-profiling',
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: PROFILING_HEADERS,
    // Every fixture gets its own fixed port pair, distinct from the viewer's
    // and from every other fixture's, so that two fixtures can never collide
    // and a driver script can address this one without discovery.
    port: 5186,
    strictPort: true,
  },
  preview: {
    headers: PROFILING_HEADERS,
    port: 5187,
    strictPort: true,
  },
  build: {
    // A production build of this fixture is the degenerate case on purpose: in
    // production React emits no render spans at all and fiber `actualDuration`
    // is null, so both signals this fixture compares disappear and only the
    // profiler plus the shipped source map is left. Keeping source maps on is
    // what makes that remaining tier exercisable here.
    sourcemap: true,
  },
});
