/*
 * The whole fixture app: a cheap click listener that produces an expensive
 * frame.
 *
 * Role in the corpus: every other fixture janks because of script, and script
 * is the one thing the engine can sample. This one janks because of browser
 * work, so it is the fixture that tests whether the tool says "most of this
 * frame is not attributable" instead of spreading the cost over whatever
 * script happens to be visible. Both buttons run the same two operations -
 * toggle a class that invalidates every existing row, then replace all of them
 * through `innerHTML` - and differ only in whether the listener forces style
 * and layout before it returns:
 *
 *   unforced  The listener returns without reading geometry. Style
 *             recalculation and layout then run in the frame's rendering
 *             update, with no script on the stack, where LoAF does not count
 *             them: `styleDuration` and `layoutDuration` stay 0 and the time
 *             lands in a residual that none of LoAF's fields can name. This is
 *             specified behaviour rather than a Chrome bug - style and layout
 *             performed while no script is running, before the rendering
 *             update, are outside both fields.
 *
 *   forced    The same work plus one `offsetHeight` read at the end of the
 *             listener, which pulls that style and layout *inside* the script.
 *             LoAF then names it exactly, as `forcedStyleAndLayoutDuration`
 *             nested inside the script entry's own `duration` - while
 *             `styleDuration` and `layoutDuration` still stay 0.
 *
 * The two scenarios are two buttons with stable `data-fixture` selectors
 * rather than one button plus a mutable `window` flag, so a driver picks a
 * scenario by clicking what a user would click and the page has no state a
 * driver has to set up correctly.
 *
 * Deliberately not here: no framework, no module graph, no second cause. The
 * throwaway fixture this was promoted from also carried three sibling click
 * listeners, to make a separate point about LoAF attributing a vendor's cost
 * to the first-party line that registered the listener. That claim gets its
 * own fixture, because a fixture that janks for two reasons cannot show which
 * one the tool actually found. There is also no attempt to measure the frame
 * from inside the page beyond the delay probe below: the frame belongs to the
 * collectors, and an in-page measurement harness would be part of what it
 * measures.
 *
 * Why this file is a classic script in `public/` rather than a module in
 * `src/`: files under `public/` are served byte-for-byte identically by the
 * dev server and by a production build, with no transform, no bundling and no
 * module wrapper. So a `sourceCharPosition` offset into this file means the
 * same thing in both modes, and the line numbers declared in
 * `ground-truth.json` do not move between them. The file is also ASCII-only,
 * which makes a character offset into it and a byte offset into it the same
 * number - one less way to be off by N while resolving a position.
 */

/*
 * How many rows are rebuilt per click, and the reason the frame is long.
 *
 * 4,000 is the predecessor fixture's count, kept so its measurements stay
 * comparable. The cost is not the string: building the markup is a few
 * milliseconds. It is that every one of these rows is invalidated by the class
 * toggle and then thrown away and re-parsed, re-styled and re-laid-out, which
 * is work the main thread does with no JavaScript on the stack.
 */
const ROW_COUNT = 4000;

const list = document.querySelector('[data-fixture="row-list"]');
const unforcedButton = document.querySelector('[data-fixture="rebuild-unforced"]');
const forcedButton = document.querySelector('[data-fixture="rebuild-forced"]');

if (!list || !unforcedButton || !forcedButton) {
  throw new Error('fixture markup missing: index.html and app.js are out of sync');
}

/*
 * The evidence that the unnameable part of the frame is work rather than idle.
 *
 * Subtraction alone cannot tell the two apart: `duration - sum of the named
 * fields` is just as large whether the main thread was busy with style and
 * layout or sitting still waiting for the next vsync. So at the end of the
 * listener the fixture posts a `MessageChannel` message, queues a `setTimeout`
 * and asks for an animation frame, and records how late each one arrives. A
 * task posted at the end of a listener runs promptly if the thread is idle and
 * late if the thread is busy with non-JS work; on the predecessor the message
 * took 122-146ms to be delivered and `requestAnimationFrame` fired 118-141ms
 * later, landing exactly at `renderStart`. That is what makes the residual a
 * measurement rather than a shrug.
 *
 * All three are cheap enough not to be part of what they measure: one
 * `MessageChannel`, three closures and one `performance.now()` each, all of it
 * well under the 100us grid LoAF's own fields are coarsened to.
 *
 * A driver reads `window.__frameblameFixtureProbe` after the frame has ended.
 * Each record is pushed synchronously from the listener with its `delays`
 * object still empty; the three delay fields are filled in later, as they
 * arrive. Reading the array during the frame gives a record with no delays in
 * it, which is correct and is not the same thing as a delay of zero.
 */
window.__frameblameFixtureProbe = [];

/**
 * Builds the markup for `count` rows as one string.
 *
 * Returns HTML text, not nodes: `innerHTML` on a single joined string is the
 * shape of the bug being reproduced - one parse that replaces the whole
 * subtree - and it is what real code does when it templates a list by hand.
 * The row label is the predecessor's, with its em dash replaced by a hyphen to
 * keep this file ASCII; the rows are therefore one character narrower than the
 * ones the recorded figures were measured on.
 */
function buildRowMarkup(count) {
  const html = [];
  for (let i = 0; i < count; i += 1) {
    html.push(`<li class="row">row ${String(i)} - some text to lay out</li>`);
  }
  return html.join('');
}

/**
 * Runs one rebuild and records how the listener's own time was spent.
 *
 * `scenario` is the label the ground truth uses ('unforced' or 'forced').
 * `forceStyleAndLayout` decides whether the listener reads geometry before it
 * returns, which is the only difference between the two buttons.
 *
 * All timings are milliseconds on the `performance.now()` monotonic clock -
 * the same clock LoAF entries, profiler samples and React's spans are on, so
 * the figures recorded here can be compared against a LoAF entry's `startTime`
 * and `duration` without any reconciliation.
 *
 * Assumes it is called from a click listener. Outside an event listener the
 * work would land in a frame with no script attribution at all, which is a
 * different and much less interesting case.
 */
function rebuildRows(scenario, forceStyleAndLayout) {
  const listenerStart = performance.now();

  /*
   * The invalidation. Toggling one class on `body` changes `letter-spacing`,
   * `font-size` and `padding-left` for every `.row` at once (see the stylesheet
   * in `index.html`), so the browser cannot do anything clever: every row needs
   * its style recomputed and its text re-measured. One class write, several
   * thousand rows of consequence - which is exactly why the script cost and the
   * frame cost have nothing to do with each other here.
   */
  document.body.classList.toggle('wide');
  const afterClassToggle = performance.now();

  const markup = buildRowMarkup(ROW_COUNT);
  const afterStringBuild = performance.now();

  list.innerHTML = markup;

  /*
   * The forced-layout scenario in one line. Reading `offsetHeight` cannot be
   * answered from stale geometry, so the browser must flush style and layout
   * before the read returns - synchronously, inside this script. LoAF reports
   * that as `forcedStyleAndLayoutDuration` *nested inside* this script entry's
   * `duration`, never added to it, and leaves `styleDuration` and
   * `layoutDuration` at 0 regardless.
   *
   * The height is kept in the probe record rather than dropped on the floor so
   * that a minifier cannot decide the read was dead code, and so the two
   * scenarios are distinguishable from the recorded data alone.
   */
  let forcedHeight = null;
  if (forceStyleAndLayout) {
    forcedHeight = list.offsetHeight;
  }
  const listenerEnd = performance.now();

  const delays = {};
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    delays.messageChannelMs = performance.now() - listenerEnd;
  };
  channel.port2.postMessage(0);
  setTimeout(() => {
    delays.timeoutMs = performance.now() - listenerEnd;
  }, 0);
  requestAnimationFrame(() => {
    delays.animationFrameMs = performance.now() - listenerEnd;
  });

  window.__frameblameFixtureProbe.push({
    scenario,
    listenerStartMs: listenerStart,
    listenerEndMs: listenerEnd,
    classToggleMs: afterClassToggle - listenerStart,
    stringBuildMs: afterStringBuild - afterClassToggle,
    innerHtmlMs: listenerEnd - afterStringBuild,
    listenerTotalMs: listenerEnd - listenerStart,
    forcedHeight,
    delays,
  });
}

/*
 * The two registration sites. LoAF attributes a script entry to where the
 * listener was *registered*, not to where the time went, so these two lines
 * are what `sourceCharPosition` resolves to and `ground-truth.json` declares
 * them as such. Note how little they say: identical shape, a few milliseconds
 * of script each, and no hint that one of the two frames spends ~100ms in
 * forced layout and the other spends ~130ms somewhere LoAF cannot name.
 */
unforcedButton.addEventListener('click', () => {
  rebuildRows('unforced', false);
});
forcedButton.addEventListener('click', () => {
  rebuildRows('forced', true);
});

/*
 * Start with a full list so the first click is representative of the rest. On
 * an empty `<ul>` the class toggle invalidates nothing and the frame measures
 * only the parse and first layout of 4,000 new rows; every click after that
 * also invalidates 4,000 existing ones. Discarding the first run of a session
 * is still the right habit - see findings.md - but it should be discarded for
 * warm-up reasons, not because the page was in a different state.
 */
list.innerHTML = buildRowMarkup(ROW_COUNT);
