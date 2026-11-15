import { defineConfig } from 'vite';

/*
 * Server configuration for the vendor-listener fixture. It exists to serve one
 * static page with one header, and it deliberately does nothing else: no
 * plugins, because the fixture has no framework and no transform, and nothing
 * that would rewrite the two scripts in `public/` (see `index.html` on why their
 * bytes must not move).
 *
 * This file is plain JavaScript rather than TypeScript because the package
 * contains no TypeScript at all. The root ESLint config already gives config
 * files named `*.config.js` the Node globals and switches off type-aware rules
 * for every `.js` file, so no tsconfig and no new lint entry are needed here.
 */

/*
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
 * It matters more here than in `derive-in-render`, not less: this fixture's
 * second claim is that LoAF alone cannot produce a third-party share, so the
 * only signal that can is the profiler, and the profiler is only reachable
 * through this header.
 *
 * https://wicg.github.io/js-self-profiling/#document-policy
 * https://groups.google.com/a/chromium.org/g/blink-dev/c/y3OkEzcrp24
 */
const PROFILING_HEADERS = {
  'Document-Policy': 'js-profiling',
};

export default defineConfig({
  server: {
    headers: PROFILING_HEADERS,
    // Every fixture gets its own fixed port pair, so two fixtures and the
    // viewer can all be up at once and a probe can address this app without
    // discovery. `strictPort` makes a collision a failure rather than a silent
    // move to another port, where the probe would measure the wrong page.
    port: 5190,
    strictPort: true,
  },
  preview: {
    headers: PROFILING_HEADERS,
    port: 5191,
    strictPort: true,
  },
  build: {
    // There is no transformed JavaScript in this fixture — both scripts are
    // served verbatim from `public/` — so today this setting has nothing to emit
    // a map for, and the production and development offsets agree for free.
    // It is set anyway so that if anything here ever does get bundled, the
    // fixture keeps the source fidelity the attribution depends on instead of
    // losing it quietly.
    sourcemap: true,
  },
});
