/**
 * Executing a fixture's drive plan and recording what each interaction
 * produced.
 *
 * The output is the bridge between "the browser emitted 37 long frames" and
 * "clicking this button emitted these three". Without it a dump of a multi-step
 * fixture is unusable: `findings.md`'s span-gate table is a claim *per
 * interaction* — initial mount gets no span, `App`'s setState gets two — and a
 * frame that cannot be traced back to the step that caused it cannot check any
 * of it.
 *
 * This module does not decide what to drive (`spike/fixtures.ts`) and does not
 * read any signal other than the long-frame count, which it uses only as a
 * progress signal. It deliberately does not wait for the profiler, React or the
 * network: waiting on anything the capture is trying to measure would make the
 * driver part of the measurement.
 */

import type { Page } from '@playwright/test';

import {
  type DriveStep,
  FRAME_WAIT_MS,
  type FixtureDefinition,
  settleMsFor,
} from './fixtures.ts';

/** One press or click, and whether a long frame followed it. */
export interface ActionRecord {
  /** 0-based index within the step. */
  readonly index: number;
  /** The key pressed, or `'click'`. */
  readonly what: string;
  /** `performance.now()` in the page, read immediately before the action. */
  readonly atPageClock: number;
  /**
   * Whether a long animation frame was reported before the wait ran out.
   *
   * `false` is data, not an error. On `derive-in-render` in production, 18 of
   * 24 interactions that each burned about 45ms of main thread produced no
   * entry at all, because LoAF's reporting threshold is 50ms and the
   * distribution sits across it. An aggregate that counts only frames
   * under-counts exactly the near-threshold offenders users feel, and the only
   * way to say so with a number is to record the interactions that produced
   * nothing.
   */
  readonly sawNewFrame: boolean;
}

export interface StepRecord {
  readonly label: string;
  readonly kind: DriveStep['kind'];
  readonly startedAtPageClock: number;
  readonly endedAtPageClock: number;
  /** Long frames collected before and after this step ran. */
  readonly framesBefore: number;
  readonly framesAfter: number;
  readonly actions: readonly ActionRecord[];
}

/** The page's clock, which is the clock every signal is reported on. */
async function pageNow(page: Page): Promise<number> {
  return await page.evaluate(() => window.__frameblameSpike__?.now() ?? 0);
}

async function frameCount(page: Page): Promise<number> {
  return await page.evaluate(() => window.__frameblameSpike__?.frameCount() ?? 0);
}

/**
 * Waits for the long-frame count to rise above `was`, and reports whether it
 * did.
 *
 * Waiting on the count rather than on a fixed delay is what keeps the capture
 * honest about its own pacing: the LoAF observer callback runs a task or two
 * after the frame ends, so a fixed delay either truncates the frame or pads
 * every interaction with idle time. The timeout is swallowed because an
 * interaction that produced no long frame is a finding, not a failure.
 */
async function waitForFrame(page: Page, was: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (previous) => (window.__frameblameSpike__?.frameCount() ?? 0) > previous,
      was,
      { timeout: FRAME_WAIT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs every step of a fixture's plan in order and returns one record per step.
 *
 * Steps run strictly serially and the page is never reloaded between them, so
 * the state each step leaves is the state the next one starts from — which is
 * the point for the span fixture, where "mounts for the first time" and
 * "re-renders with the new child present" are different claims about the same
 * app.
 *
 * All timestamps are `performance.now()` milliseconds read inside the page, on
 * the same clock as LoAF, the profiler samples and React's spans.
 */
export async function drive(
  page: Page,
  fixture: FixtureDefinition,
): Promise<StepRecord[]> {
  const records: StepRecord[] = [];

  for (const [index, step] of fixture.drive.entries()) {
    /*
     * The first step of a fixture that captures its own first mount covers the
     * page from its very beginning, not from the moment Node got control.
     *
     * Without this the window would open too late to contain the thing the step
     * is named after: React's mount commit lands while `page.goto` is still in
     * progress — measured at 249.6ms on the span fixture, against a first
     * reading here of 335.6ms — so a consumer slicing records by this step's
     * window would find the frame, the samples and the commit all just outside
     * it and conclude the mount produced nothing. It produced five components
     * rendering 26ms each and no spans at all, which is the whole claim.
     */
    const startedAtPageClock =
      index === 0 && fixture.capturesFirstMount ? 0 : await pageNow(page);
    const framesBefore = await frameCount(page);
    const actions: ActionRecord[] = [];
    const settleMs = settleMsFor(step);

    if (step.kind === 'settle') {
      // Nothing to provoke: whatever is still arriving from the page's own
      // load — a first mount, most importantly — is attributed to this label.
      await page.waitForTimeout(step.forMs);
    } else {
      const target = page.locator(step.selector);

      for (let index = 0; index < step.repeat; index += 1) {
        const before = await frameCount(page);
        const atPageClock = await pageNow(page);

        let what: string;
        if (step.kind === 'press') {
          /*
           * Cycling through the keys is what makes the replay re-run the work.
           * `derive-in-render` filters on its input's value, so pressing 'n'
           * twenty-four times changes the query once and then re-renders an
           * unchanged view; alternating 'n' and Backspace oscillates between
           * two queries and re-runs the full derive on every press.
           */
          const key = step.keys[index % step.keys.length] ?? step.keys[0];
          await target.press(key);
          what = key;
        } else {
          await target.click();
          what = 'click';
        }

        const sawNewFrame = await waitForFrame(page, before);
        actions.push({ index, what, atPageClock, sawNewFrame });

        await page.waitForTimeout(settleMs);
      }
    }

    records.push({
      label: step.label,
      kind: step.kind,
      startedAtPageClock,
      endedAtPageClock: await pageNow(page),
      framesBefore,
      framesAfter: await frameCount(page),
      actions,
    });
  }

  return records;
}
