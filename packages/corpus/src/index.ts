/**
 * `@frameblame/corpus` — the captured evidence, read off disk.
 *
 * Private to the workspace and never published. Its one job is to be the
 * impure counterpart to `packages/core`: the engine takes signal records and
 * returns attributions with no DOM, no clock and no I/O, and this is where the
 * I/O lives so that it can stay that way. Tests import from here; the tool
 * does not.
 *
 * What is deliberately absent is any opinion about what the records mean. The
 * accessors narrow far enough to read a run directory and check a fixture's
 * ground truth against its source, and no further — the engine's record types
 * are to be derived from the dumps in `corpus/`, which is the whole reason the
 * corpus was captured before the engine was written.
 */

export {
  BUILD_MODES,
  CORPUS_ROOT,
  FIXTURES_ROOT,
  envelopeOf,
  hasCorpusRun,
  listFixtures,
  loadCorpus,
  loadCorpusRun,
  loadGroundTruth,
  readRepoFile,
  repoPath,
} from './corpus.ts';
export type { BuildMode, CorpusRun, RunEnvelope, RunFileKey } from './corpus.ts';

export { checkSourceAnchor, collectSourceAnchors } from './ground-truth.ts';
export type { SourceAnchor } from './ground-truth.ts';

export { framesOf } from './loaf-records.ts';
export { profileOf } from './profiler-records.ts';
export { reactOf } from './react-records.ts';
export { interactionsOf, loadSignals, provenanceOf, signalsOf } from './records.ts';

export {
  arrayAt,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  get,
  isJsonArray,
  isJsonRecord,
  nullableBooleanAt,
  nullableNumberAt,
  nullableStringAt,
  numberAt,
  recordAt,
  stringAt,
} from './json.ts';
export type { Json, JsonObject, JsonPath } from './json.ts';
