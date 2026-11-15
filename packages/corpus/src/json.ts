/**
 * Navigating parsed JSON without pretending to know its type.
 *
 * The dumps and the ground truths are read as `Json`, deliberately: the
 * engine's record types are meant to be derived from what the dumps actually
 * contain, and a loader that asserted a shape would be making that decision in
 * the wrong place and a release too early. But `Json` is tedious to walk under
 * strict type checking, and the tedium pushes towards `as any`, which would
 * throw away the one thing the loose type buys — a loud failure when a dump is
 * not what a reader assumed.
 *
 * So: navigation returns `undefined` for a missing path, and the `as*` readers
 * throw a message naming the path and what was found there. A test that reads a
 * field that moved fails saying so, rather than comparing `undefined` to a
 * number and reporting that the tool is inaccurate.
 *
 * This module is pure and knows nothing about frames, fixtures or files.
 */

/** An object in parsed JSON. Named so the recursive union below can refer to it. */
export interface JsonObject {
  /*
   * An index signature on an interface rather than
   * `Readonly<Record<string, Json>>`: `Record` is a mapped type, and a type
   * alias that recurses through one is circular, which collapses `Json` to an
   * error type and makes every read of it report as `any`. This is the one
   * spelling the compiler accepts for a recursive JSON value.
   */
  readonly [key: string]: Json;
}

/** Parsed JSON, before anything has decided what it means. */
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;

/** A path through nested objects and arrays. */
export type JsonPath = readonly (string | number)[];

/*
 * `Array.isArray` is typed `arg is any[]`, so narrowing a `Json` with it
 * replaces the recursive type with `any` and quietly disables every
 * type-checked rule downstream of the branch. These two guards keep the type
 * intact, which is the whole reason the dumps are read as `Json` rather than
 * cast to a shape nobody has verified.
 */
export function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

export function isJsonRecord(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !isJsonArray(value);
}

function render(path: JsonPath): string {
  return path.length === 0 ? '(root)' : path.join('.');
}

function describe(value: Json | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (isJsonArray(value)) return `an array of ${String(value.length)}`;
  return typeof value;
}

/** Follows `path`, returning `undefined` at the first step that is missing. */
export function get(value: Json | undefined, path: JsonPath): Json | undefined {
  let current = value;

  for (const key of path) {
    if (current === null || current === undefined) return undefined;

    if (typeof key === 'number') {
      if (!isJsonArray(current)) return undefined;
      current = current[key];
      continue;
    }

    if (!isJsonRecord(current)) return undefined;
    current = current[key];
  }

  return current;
}

export function asRecord(value: Json | undefined, path: JsonPath = []): JsonObject {
  if (!isJsonRecord(value)) {
    throw new Error(`${render(path)} is ${describe(value)}, expected an object`);
  }
  return value;
}

export function asArray(value: Json | undefined, path: JsonPath = []): readonly Json[] {
  if (!isJsonArray(value)) {
    throw new Error(`${render(path)} is ${describe(value)}, expected an array`);
  }
  return value;
}

export function asNumber(value: Json | undefined, path: JsonPath = []): number {
  if (typeof value !== 'number') {
    throw new Error(`${render(path)} is ${describe(value)}, expected a number`);
  }
  return value;
}

export function asString(value: Json | undefined, path: JsonPath = []): string {
  if (typeof value !== 'string') {
    throw new Error(`${render(path)} is ${describe(value)}, expected a string`);
  }
  return value;
}

export function asBoolean(value: Json | undefined, path: JsonPath = []): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${render(path)} is ${describe(value)}, expected a boolean`);
  }
  return value;
}

/**
 * A number, or `null` when the dump holds `null` or has no such key.
 *
 * Both spellings of absence collapse to `null` on purpose. Chrome omits
 * `paintTime` from a frame that never painted and writes `null` into the fields
 * a Blink flag withholds, and the records these feed are explicit that absence
 * is `null` throughout — one spelling, because two spellings is how one of them
 * gets forgotten. A value of the wrong type still throws.
 */
export function nullableNumberAt(value: Json | undefined, path: JsonPath): number | null {
  return nullableAt(value, path, asNumber);
}

/** As `nullableNumberAt`, for a boolean. */
export function nullableBooleanAt(
  value: Json | undefined,
  path: JsonPath,
): boolean | null {
  return nullableAt(value, path, asBoolean);
}

/** As `nullableNumberAt`, for a string. */
export function nullableStringAt(value: Json | undefined, path: JsonPath): string | null {
  return nullableAt(value, path, asString);
}

/** The shared body of the `nullable*At` readers: either absence is `null`, anything else is `read`. */
function nullableAt<T>(
  value: Json | undefined,
  path: JsonPath,
  read: (found: Json, path: JsonPath) => T,
): T | null {
  const found = get(value, path);
  return found === null || found === undefined ? null : read(found, path);
}

/**
 * A string, or `null` when the dump holds the empty string Chrome uses for "none".
 *
 * Here rather than beside its callers because two signals spell absence this
 * way — LoAF's `sourceURL` and `sourceFunctionName`, and a profiler frame's
 * `name` — and their adapters are separate modules.
 */
export function nonEmptyStringAt(value: Json | undefined, path: JsonPath): string | null {
  const found = nullableStringAt(value, path);
  return found === null || found === '' ? null : found;
}

/** `get` and `asRecord` in one step, for the common nested-object read. */
export function recordAt(value: Json | undefined, path: JsonPath): JsonObject {
  return asRecord(get(value, path), path);
}

/** `get` and `asArray` in one step. */
export function arrayAt(value: Json | undefined, path: JsonPath): readonly Json[] {
  return asArray(get(value, path), path);
}

/** `get` and `asNumber` in one step. */
export function numberAt(value: Json | undefined, path: JsonPath): number {
  return asNumber(get(value, path), path);
}

/** `get` and `asString` in one step. */
export function stringAt(value: Json | undefined, path: JsonPath): string {
  return asString(get(value, path), path);
}

/** `get` and `asBoolean` in one step. */
export function booleanAt(value: Json | undefined, path: JsonPath): boolean {
  return asBoolean(get(value, path), path);
}
