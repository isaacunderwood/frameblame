/**
 * What the spike knows about each fixture: where to serve it, and how to make
 * it jank.
 *
 * This is the registry the corpus capture loops over. It holds the operational
 * half of a fixture — package name, ports, selectors, the sequence of presses
 * and clicks that provokes the declared frames — and deliberately none of the
 * analytical half. What a correct attribution must *say* about those frames
 * lives in each fixture's own `ground-truth.json`, which is read by the
 * accuracy suite and not by this module.
 *
 * The split is on purpose. A drive plan is typed code with selectors in it and
 * changes when the fixture's markup changes; a ground truth is a claim about
 * the world that a test asserts against. Keeping the plan here means the
 * capture needs no JSON schema and no hand-rolled validation, and keeping the
 * claim there means `packages/core` never has to know a browser exists.
 */

/** Which build of a fixture is under test. Both are captured for every one. */
export type BuildMode = 'development' | 'production';

/**
 * One operation against a running fixture.
 *
 * Every step carries a `label`, which is what the run directory reports frame
 * counts against. Labels matter more than they look: `findings.md`'s span-gate
 * table is a claim per interaction ("initial mount: none", "App setState:
 * PropsChanged, DeepEqualProps"), so a dump that cannot say which step a frame
 * belonged to cannot be used to check it.
 */
export type DriveStep =
  /**
   * Wait, and attribute whatever arrives to this label. The only way to
   * capture a first mount, which has already happened by the time anything can
   * be clicked.
   */
  | { readonly kind: 'settle'; readonly label: string; readonly forMs: number }
  /**
   * Press keys into a selector, `repeat` times, cycling through `keys`.
   *
   * Cycling rather than repeating one key is what makes a replay a replay: the
   * `derive-in-render` fixture filters on its input's value, so pressing 'n'
   * twenty-four times changes the query once and then re-renders an unchanged
   * view. Alternating 'n' and Backspace re-runs the full derive every press.
   */
  | {
      readonly kind: 'press';
      readonly label: string;
      readonly selector: string;
      readonly keys: readonly [string, ...string[]];
      readonly repeat: number;
      readonly settleMs?: number;
    }
  /** Click a selector, `repeat` times. */
  | {
      readonly kind: 'click';
      readonly label: string;
      readonly selector: string;
      readonly repeat: number;
      readonly settleMs?: number;
    };

export interface FixtureDefinition {
  /** Directory name under `fixtures/`, and the id used in run directories. */
  readonly id: string;
  /** Workspace package name, for `pnpm --filter`. */
  readonly packageName: string;
  /**
   * Fixed per fixture and distinct from every other fixture's, so that a
   * forgotten dev server from an earlier run fails loudly on a port clash
   * instead of quietly serving the wrong app to the next capture.
   */
  readonly devPort: number;
  readonly previewPort: number;
  /** A selector that is present once the app has mounted and is interactive. */
  readonly readySelector: string;
  /**
   * Whether this fixture's declared claim includes the page's first mount.
   *
   * It changes the capture in two ways, and neither is optional for a fixture
   * that needs it. The profiler must be constructed in the init script, before
   * the document's own scripts run, because by the time Node can call into the
   * page the mount is already over. And the collected records must not be
   * cleared before driving, which is what every other fixture wants — load
   * frames are noise there — but would here discard the evidence.
   *
   * This exists because of `findings.md`'s span gate: React emits a
   * `performance.measure` only for a component whose props changed by identity,
   * so a first mount produces renders and *no spans at all*. A capture that
   * could not see a mount could not check the claim that caught the previous
   * session's worst error.
   */
  readonly capturesFirstMount: boolean;
  readonly drive: readonly DriveStep[];
  /** One line on what this fixture is for; printed by the capture. */
  readonly summary: string;
}

/**
 * Default wait after each press or click before the next one.
 *
 * 150ms is not tuned, it is inherited: it is what `spike/archive/probe.ts`
 * used for the 24-press replay that produced the declared frame counts (14-15
 * in development, 6 in production) and the line histogram in `findings.md`.
 * Changing it would change the inter-press spacing and so, potentially, how
 * many frames cross LoAF's 50ms threshold — which would silently invalidate
 * the numbers this corpus exists to reproduce.
 *
 * It is a default rather than a constant because it is only right for the
 * keypress replay. A step whose own frames are longer than this has to say so:
 * the vanilla fixtures produce 130-160ms frames followed by 23-42ms of
 * presentation time, so 150ms would start the next click inside the frame the
 * last one caused and attribute two interactions' work to one frame. Their
 * predecessors waited 500-600ms, and their steps carry that.
 */
export const SETTLE_AFTER_STEP_MS = 150;

/**
 * What a step waits before the next action, with the step's own override.
 *
 * `settle` steps have no per-action pause — the wait *is* the step — so they
 * are not passed here.
 */
export function settleMsFor(step: DriveStep): number {
  return step.kind === 'settle' ? 0 : (step.settleMs ?? SETTLE_AFTER_STEP_MS);
}

/**
 * How long to wait for a long animation frame to be reported after a press.
 *
 * Also inherited from the archive probe. The LoAF observer callback runs a task
 * or two after the frame ends, so a frame that will be reported is reported in
 * well under a second; this budget is only ever spent in full by an interaction
 * that produced *no* long frame. That case is the point — `findings.md` records
 * that 18 of 24 janky interactions on `derive-in-render` are invisible to the
 * trigger in production — so the wait is left long and the timeout is treated
 * as data rather than as an error.
 */
export const FRAME_WAIT_MS = 5_000;

/**
 * Replayed 24 times because one frame is not enough samples.
 *
 * A 64ms frame yields five to seven samples at Chrome's 10ms floor, and three
 * single-keystroke runs put the top line on the declared culprit only twice —
 * which `findings.md` reversed as small-sample noise rather than a coin flip.
 * Over 24 presses the same signal gives 73% of samples on the culprit line and
 * the top-ranked line correct in 13 of 14 frames. 24 is therefore the number
 * the declared counts were measured at, not a round figure.
 */
const REPLAY_PRESSES = 24;

/**
 * The vanilla fixtures' frames run 130-160ms, with another 23-42ms of
 * presentation time beyond the end of `duration`. Their predecessors in
 * `spike/archive/probe-vanilla.ts` waited 500-600ms between clicks for that
 * reason, and so do these: a shorter pause starts the next click inside the
 * frame the last one caused, and one frame then carries two interactions'
 * work — which is indistinguishable, in a dump, from a fixture that janks
 * twice as hard as it does.
 */
const VANILLA_SETTLE_MS = 600;

export const FIXTURES: readonly FixtureDefinition[] = [
  {
    id: 'derive-in-render',
    packageName: '@frameblame/fixture-derive-in-render',
    devPort: 5181,
    previewPort: 5182,
    readySelector: '[data-fixture="filter-input"]',
    capturesFirstMount: false,
    summary: 'React: an expensive filter and sort in a render body.',
    drive: [
      {
        kind: 'press',
        label: 'replay',
        selector: '[data-fixture="filter-input"]',
        keys: ['n', 'Backspace'],
        repeat: REPLAY_PRESSES,
      },
    ],
  },

  {
    id: 'spans',
    packageName: '@frameblame/fixture-spans',
    devPort: 5186,
    previewPort: 5187,
    readySelector: '[data-fixture="bump"]',
    // The mount is the first and most important of its five claims.
    capturesFirstMount: true,
    summary:
      "React: five components, one span gate — why React's spans are not the signal.",
    /*
     * Five steps, in this order, because each one differs from the last only in
     * *why* a component re-rendered — which is the single variable the span gate
     * turns on. The order is inherited from `spike/archive/spans/drive.ts`,
     * whose output is the table in `findings.md`, and the state each step
     * leaves is the state the next one starts from: "LateMount mounts for the
     * first time" and "the tree re-renders with LateMount already present" are
     * different claims about the same app and cannot be reordered.
     */
    drive: [
      { kind: 'settle', label: 'initial-mount', forMs: VANILLA_SETTLE_MS },
      {
        kind: 'click',
        label: 'bump',
        selector: '[data-fixture="bump"]',
        repeat: 1,
        settleMs: VANILLA_SETTLE_MS,
      },
      {
        kind: 'click',
        label: 'state-owner-self',
        selector: '[data-fixture="state-owner-self"]',
        repeat: 1,
        settleMs: VANILLA_SETTLE_MS,
      },
      {
        kind: 'click',
        label: 'mount-toggle',
        selector: '[data-fixture="mount-toggle"]',
        repeat: 1,
        settleMs: VANILLA_SETTLE_MS,
      },
      {
        kind: 'click',
        label: 'bump-again',
        selector: '[data-fixture="bump"]',
        repeat: 1,
        settleMs: VANILLA_SETTLE_MS,
      },
    ],
  },

  {
    id: 'innerhtml-rebuild',
    packageName: '@frameblame/fixture-innerhtml-rebuild',
    devPort: 5188,
    previewPort: 5189,
    readySelector: '[data-fixture="rebuild-unforced"]',
    // Its 4,000 rows are built at load, which is work to be excluded, not
    // measured.
    capturesFirstMount: false,
    summary:
      'Vanilla: browser work the frame cannot name, and the same work forced inline.',
    /*
     * Both scenarios in one capture, four clicks each, matching the
     * predecessor's count. Unforced first: it is the one whose frame is 93%
     * unnameable, and running it before the forced variant means the forced
     * variant cannot be blamed for warming anything it needed.
     */
    drive: [
      {
        kind: 'click',
        label: 'unforced',
        selector: '[data-fixture="rebuild-unforced"]',
        repeat: 4,
        settleMs: VANILLA_SETTLE_MS,
      },
      {
        kind: 'click',
        label: 'forced',
        selector: '[data-fixture="rebuild-forced"]',
        repeat: 4,
        settleMs: VANILLA_SETTLE_MS,
      },
    ],
  },

  {
    id: 'vendor-listener',
    packageName: '@frameblame/fixture-vendor-listener',
    devPort: 5190,
    previewPort: 5191,
    readySelector: '[data-fixture="run-work"]',
    capturesFirstMount: false,
    summary:
      'Vanilla: three sibling listeners, one of them a vendor, all attributed to app.js.',
    drive: [
      {
        kind: 'click',
        label: 'three-listeners',
        selector: '[data-fixture="run-work"]',
        repeat: 6,
        settleMs: 500,
      },
    ],
  },
];

/** Looks a fixture up by directory name, or throws listing what there is. */
export function fixtureById(id: string): FixtureDefinition {
  const fixture = FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    const known = FIXTURES.map((candidate) => candidate.id).join(', ');
    throw new Error(`unknown fixture ${JSON.stringify(id)}; known fixtures: ${known}`);
  }
  return fixture;
}

/** The port a fixture is served on in the given mode. */
export function portFor(fixture: FixtureDefinition, mode: BuildMode): number {
  return mode === 'development' ? fixture.devPort : fixture.previewPort;
}

/** The URL a fixture is served at in the given mode. */
export function urlFor(fixture: FixtureDefinition, mode: BuildMode): string {
  return `http://localhost:${String(portFor(fixture, mode))}/`;
}
