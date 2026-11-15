/*
 * The first-party half of the fixture: one button, three sibling click
 * listeners, one long animation frame carrying three script entries.
 *
 * Role in the pipeline: this is the input side of the signal join for the
 * non-framework case. `derive-in-render` exercises the path where LoAF can only
 * name react-dom's dispatcher and the component has to come from elsewhere;
 * this fixture exercises the path where LoAF's `sourceCharPosition` lands in the
 * user's own file and is genuinely useful — and, in the same frame, the path
 * where that usefulness runs out, because one of the three slices is really
 * owned by `vendor.js` and LoAF attributes it here. See `ground-truth.json` for
 * the contract and `findings.md` ("What made it hard", point 5) for the
 * predecessor measurement this fixture was promoted from.
 *
 * It lives in `public/` and is loaded as a classic script, which is load-bearing
 * rather than incidental — see the comment on the script tags in `index.html`.
 *
 * It deliberately does not:
 *   - name the three listener callbacks. `sourceFunctionName` was empty for all
 *     three entries in the predecessor probe, which is precisely why the
 *     character offset had to do the work. Giving the callbacks names would hand
 *     LoAF an easier answer and the fixture would stop testing what it claims
 *     to test.
 *   - do anything a second button could be blamed for. The predecessor bundled a
 *     4,000-row `innerHTML` rebuild into the same app to study a different
 *     question (frames dominated by browser work outside any script). That half
 *     was dropped on promotion: a fixture that janks for two unrelated reasons
 *     cannot be used to check an attribution against one of them.
 *   - observe or record anything. No `PerformanceObserver`, no `Profiler`, no
 *     timing log. Those live in the probe, outside the page, so that the frames
 *     being attributed are not frames this file helped to make.
 */

/** How many rows exist for the forced-layout listener to walk. */
const ROW_COUNT = 400;

/** Target cost of the first-party compute slice, in milliseconds of wall clock. */
const FIRST_PARTY_BUDGET_MS = 18;

/** The single button. All three listeners below are registered on it. */
const button = document.querySelector('[data-fixture="run-work"]');

/** The rows the forced-layout listener reads geometry from. */
const list = document.querySelector('[data-fixture="rows"]');

/*
 * Where the three listeners leave their results.
 *
 * Nothing in the page reads these. They exist so that no engine or future
 * reader can treat any of the three listeners as dead code, and so a probe can
 * confirm from outside that all three really ran in the frame it is looking at.
 */
window.__fixtureResults = { firstParty: null, vendor: null, thrash: null };

/**
 * First-party compute. Returns the accumulated float so the work has an
 * observable result; the return value is otherwise meaningless.
 *
 * Costs roughly `FIRST_PARTY_BUDGET_MS` of wall clock, measured on
 * `performance.now()` — the same clock LoAF and the profiler report on.
 *
 * The budget is wall clock rather than a fixed iteration count on purpose: it
 * makes this slice about the same size whatever CPU throttle rate the probe
 * applies, whereas the forced layout below is real browser work and scales with
 * the throttle. That asymmetry is why the forced layout dominated the frame in
 * the predecessor probe at 4x, and why no figure from this fixture means
 * anything without its throttle rate attached: lowering the rate shrinks the
 * thrash and leaves the two compute slices exactly where they are, so the
 * frame's composition changes without a line of code changing.
 */
function computeTotals() {
  const start = performance.now();
  let acc = 0;
  while (performance.now() - start < FIRST_PARTY_BUDGET_MS) {
    for (let i = 0; i < 2000; i += 1) {
      acc += Math.sqrt(i) * Math.cos(i);
    }
  }
  return acc;
}

/*
 * How many times `thrashLayout` has run.
 *
 * This counter is the fix for a reproducibility bug in the throwaway
 * predecessor, and it is worth stating plainly because the failure was silent.
 * The predecessor wrote `padding = (1 + i % 3)px` — a value that depends only on
 * the row index. On the first click every row's padding changed, style was
 * invalidated, and each `offsetHeight` read forced a synchronous layout: a
 * 109ms script slice with 107ms of `forcedStyleAndLayoutDuration`. On every
 * click after that the same value was written to the same rows, so the CSSOM
 * write was a no-op, style stayed clean, and `offsetHeight` was free. Its dumps
 * show the consequence: six clicks produced exactly one frame carrying the three
 * script entries, the rest falling under LoAF's 50ms threshold.
 *
 * Mixing the run count into the value guarantees every row's padding differs
 * from what it was on the previous click, so the thrash costs the same on click
 * ten as on click one. A fixture that janks once per page load cannot support a
 * replay, and `findings.md` is unambiguous that replay is what turns
 * single-frame attribution into a stable distribution.
 */
let thrashCount = 0;

/**
 * Forced synchronous layout: write a style, then read geometry, once per row.
 * Returns the summed heights, again only so the reads cannot be elided.
 *
 * Each iteration invalidates layout and then demands a clean layout tree in the
 * same breath, so the browser has no choice but to lay out `ROW_COUNT` times
 * inside one script. The cost therefore appears as the frame's third script
 * entry with most of its `duration` also reported as
 * `forcedStyleAndLayoutDuration` — browser work nested *inside* the script, not
 * alongside it. That nesting is the arithmetic trap recorded in
 * `ground-truth.json`: adding the forced figure to the script duration
 * double-counts roughly 100ms of a 150ms frame.
 *
 * Assumes `ROW_COUNT` rows already exist; it does not create them.
 */
function thrashLayout() {
  thrashCount += 1;
  const rows = list.children;
  let total = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    row.style.padding = `${String(1 + ((i + thrashCount) % 3))}px`;
    total += row.offsetHeight; // forces style and layout, every iteration
  }
  return total;
}

/**
 * Builds `n` rows into the list in one `innerHTML` write. Returns nothing.
 *
 * Called once at load, never from a listener — see below.
 */
function buildRows(n) {
  const html = [];
  for (let i = 0; i < n; i += 1) {
    html.push(`<li class="row">row ${String(i)} — some text to lay out</li>`);
  }
  list.innerHTML = html.join('');
}

/*
 * Rows are built at load time, deliberately.
 *
 * Constructing 400 rows is itself a few milliseconds of parsing plus a full
 * layout. If it happened inside a listener it would land in a measured frame as
 * a fourth cost with no declared owner, and any attribution of that frame would
 * have something real to be wrong about that the ground truth does not mention.
 * Doing it during load puts it in a frame nobody measures.
 */
buildRows(ROW_COUNT);

/*
 * The three listeners, and the finding they encode.
 *
 * Three separate `addEventListener` calls on one element, so one click runs
 * three callbacks in sequence inside a single event dispatch. LoAF reports a
 * script entry per callback over 5ms, which gives one frame three attributed
 * slices — and because nested entry points are merged by spec (a new script
 * entry is not started while one is pending), three sibling listeners is the
 * cheapest way to get a frame with more than one slice at all. A single
 * listener calling three functions would arrive as one entry.
 *
 * What LoAF says about each slice is the *registration site*: the character
 * offset in each entry resolves to the line below where that listener was
 * registered, not to the line where the time went. For the first and third
 * listeners that is a near-miss with a short walk to the truth — the callback
 * body is on the next line. For the second it is a different file's cost
 * reported against this one, and no amount of resolving the offset more
 * carefully can recover that; `vendor.js` does not appear in the LoAF entry at
 * any field. A third-party share has to come from the profiler's sampled
 * stacks, which do name `vendorTrack` in `vendor.js`.
 *
 * The callbacks are anonymous arrows because that is what the predecessor
 * measured: `sourceFunctionName` was the empty string on all three entries, so
 * the character offset was the only attribution available. Naming them is not a
 * tidy-up, it is a change of subject.
 *
 * The "slice N of 3" comment opening each callback body is there for the ground
 * truth as much as for the reader. The three registration lines are
 * byte-identical, so `ground-truth.json`'s `expectedSourceText` check — which
 * exists to catch a line number that has drifted — cannot tell them apart on
 * its own; the line below each is what makes the assertion specific, and the
 * ground truth records both.
 */
button.addEventListener('click', () => {
  // slice 1 of 3: first-party compute, truly owned by computeTotals below
  window.__fixtureResults.firstParty = computeTotals();
});
button.addEventListener('click', () => {
  // slice 2 of 3: truly owned by vendor.js, which LoAF will not mention
  window.__fixtureResults.vendor = window.vendorTrack();
});
button.addEventListener('click', () => {
  // slice 3 of 3: forced layout, the dominant cost of the frame
  window.__fixtureResults.thrash = thrashLayout();
});
