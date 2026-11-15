/*
 * The pretend third party.
 *
 * Role in the fixture: to be the real owner of one of the three script slices
 * in the measured frame, while being completely invisible to LoAF's attribution
 * of it. It stands in for the shape every real app has — an analytics tag, an
 * error reporter, a session recorder — that a first-party listener calls into.
 *
 * It lives in `public/` and is loaded as a classic script so that Vite never
 * touches it. An untransformed, unbundled, separately-fetched file is what makes
 * it a credible third party: it has its own `sourceURL`, its own character
 * offsets, and no shared module graph with `app.js`. The moment a bundler
 * inlined it into first-party code, the distinction this fixture is about would
 * stop existing.
 *
 * It deliberately does not:
 *   - register its own listener. That would make the vendor's cost directly
 *     attributable, which is the easy case. The whole point is that the vendor
 *     is reached through a *first-party* listener, so LoAF's registration-site
 *     attribution names `app.js` and never this file.
 *   - import or export anything. A classic script assigning one global is how
 *     third-party tags are actually delivered, and an ES module would be
 *     transformed in a build.
 *   - know that it is a fixture. No fixture selectors, no instrumentation, no
 *     cooperation with the probe.
 */

/** Target cost of the vendor slice, in milliseconds of wall clock. */
const VENDOR_BUDGET_MS = 12;

/*
 * Assigned as a global because that is how a script tag ships a vendor API, and
 * because `app.js` must reach it without an import — see this file's header.
 *
 * The function is *named* even though the first-party listeners are anonymous.
 * That is not an inconsistency: `sourceFunctionName` on the LoAF entry reports
 * the registered callback, which lives in `app.js`, so nothing about this name
 * can reach the LoAF record. It is, however, the name the JS Self-Profiling API
 * reports for the samples that land here, and that name is the only reason the
 * vendor's share is recoverable at all.
 */
window.vendorTrack = function vendorTrack() {
  const start = performance.now();
  let acc = 0;
  // Wall-clock bounded rather than iteration bounded, for the reason given on
  // `computeTotals` in app.js: it keeps this slice the same size at any CPU
  // throttle rate, so the frame's composition stays comparable across runs.
  while (performance.now() - start < VENDOR_BUDGET_MS) {
    for (let i = 0; i < 2000; i += 1) {
      acc += Math.sqrt(i) * Math.sin(i);
    }
  }
  return acc;
};
