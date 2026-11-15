/*
 * Vanilla jank fixture for the adversarial review.
 *
 * Three listeners on one button, so one frame carries three script entries:
 * first-party compute, third-party compute, and a forced-layout thrash.
 * A fourth button produces style+layout work in the rendering phase itself.
 */

const button = document.querySelector('#go');
const layoutButton = document.querySelector('#layout');
const list = document.querySelector('#list');

/** First-party hot function. The `while` on line 18 is the cost. */
function computeTotals() {
  const start = performance.now();
  let acc = 0;
  while (performance.now() - start < 18) {
    for (let i = 0; i < 2000; i += 1) {
      acc += Math.sqrt(i) * Math.cos(i);
    }
  }
  return acc;
}

/** Forced synchronous layout: read geometry, write style, repeat. */
function thrashLayout() {
  const rows = list.children;
  let total = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    row.style.padding = `${String(1 + (i % 3))}px`;
    total += row.offsetHeight; // forces layout every iteration
  }
  return total;
}

function buildRows(n) {
  const html = [];
  for (let i = 0; i < n; i += 1) {
    html.push(`<li class="row">row ${String(i)} — some text to lay out</li>`);
  }
  list.innerHTML = html.join('');
}

buildRows(400);

button.addEventListener('click', () => {
  window.__firstParty = computeTotals();
});
button.addEventListener('click', () => {
  window.__vendor = window.vendorTrack();
});
button.addEventListener('click', () => {
  window.__thrash = thrashLayout();
});

// Style+layout inside the rendering phase: mutate a class that invalidates
// every row, then yield so style and layout happen in the frame's render steps
// rather than inside the listener.
window.__timing = [];
layoutButton.addEventListener('click', () => {
  const t0 = performance.now();
  document.body.classList.toggle('wide');
  const t1 = performance.now();
  const html = [];
  for (let i = 0; i < 4000; i += 1) {
    html.push(`<li class="row">row ${String(i)} — some text to lay out</li>`);
  }
  const t2 = performance.now();
  list.innerHTML = html.join('');
  // Forcing style+layout synchronously here moves the same work inside the
  // script, where LoAF can name it as forcedStyleAndLayoutDuration.
  if (window.__force) window.__h = list.offsetHeight;
  const t3 = performance.now();
  // Is the rest of the frame browser *work* or main-thread *idle*? A task
  // posted at the end of the listener runs promptly if the thread is idle and
  // late if the thread is busy with non-JS work.
  const record = {};
  const port = new MessageChannel();
  port.port1.onmessage = () => {
    record.messageChannelDelay = performance.now() - t3;
  };
  port.port2.postMessage(0);
  setTimeout(() => {
    record.timeoutDelay = performance.now() - t3;
  }, 0);
  requestAnimationFrame(() => {
    record.rafDelay = performance.now() - t3;
  });
  window.__timing.push({
    probe: record,
    listenerStart: t0,
    classToggle: t1 - t0,
    buildString: t2 - t1,
    innerHTML: t3 - t2,
    listenerTotal: t3 - t0,
    listenerEnd: t3,
  });
});
