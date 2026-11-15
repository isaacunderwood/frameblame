import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    // Fixed and distinct from the viewer's port so both can run at once and the
    // spike script can address this app without discovery.
    port: 5181,
    strictPort: true,
  },
  preview: {
    headers: PROFILING_HEADERS,
    port: 5182,
    strictPort: true,
  },
  build: {
    // A production build of the fixture is only useful if its frames can still
    // be traced back to source, which is the case the deferred build-time
    // annotation plugin exists to improve on.
    sourcemap: true,
  },
});
