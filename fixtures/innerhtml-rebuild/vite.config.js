/*
 * Vite configuration for the `innerhtml-rebuild` fixture.
 *
 * Its only real job is the Document Policy header, exactly as in
 * `fixtures/derive-in-render/vite.config.ts`. Everything else here is kept
 * minimal on purpose, and the omissions are the interesting part:
 *
 * - No `plugins`. There is no framework and no JSX in this fixture; the whole
 *   app is one classic script in `public/`.
 * - Plain `.js`, not `.ts`. The package contains no TypeScript, so it needs no
 *   `tsconfig.json`; the root ESLint config already turns type-checked rules
 *   off for every `.js` file and treats a `.config.js` as Node code. (Spelled
 *   out rather than written as the glob, because the glob contains the
 *   sequence that ends a block comment.)
 * - No `typecheck` script in `package.json`, for the same reason.
 *
 * `window.Profiler` does not exist unless the document was served with a
 * Document Policy authorising it. No feature detection can work around this
 * and no runtime flag enables it - the header is checked at document creation,
 * so getting it wrong means the deep signal is simply absent. That matters more
 * here than in any other fixture: the empty-stack share of the sampled profile
 * is this fixture's cross-check on the unattributable residual, so without the
 * header there is nothing to cross-check against and the fixture tests nothing.
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
import { defineConfig } from 'vite';

const PROFILING_HEADERS = {
  'Document-Policy': 'js-profiling',
};

export default defineConfig({
  server: {
    headers: PROFILING_HEADERS,
    // Every fixture owns a fixed port pair so two can be running at once and a
    // driver script can address this one without discovery. `strictPort` makes
    // a collision fail loudly rather than silently moving the fixture to a port
    // nobody is measuring.
    port: 5188,
    strictPort: true,
  },
  preview: {
    headers: PROFILING_HEADERS,
    port: 5189,
    strictPort: true,
  },
  build: {
    // Set for parity with the other fixtures and for anything added to the
    // module graph later. It does nothing for this fixture's own code: the app
    // lives in `public/`, which Vite copies verbatim, so there is no transform
    // to map back through. That is the point - see the comment in
    // `public/app.js` about why the app is not a module.
    sourcemap: true,
  },
});
