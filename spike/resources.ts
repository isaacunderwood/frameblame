/**
 * Fetching the scripts the signals pointed at, with their source maps.
 *
 * A profiler frame's line and column are positions in the script the browser
 * executed — Vite's transform of a component, or a minified bundle — not in the
 * component. A LoAF script attribution's `sourceCharPosition` is an offset into
 * the same kind of text. Neither survives the server being stopped, so without
 * this step a dump is a set of coordinates in a file that no longer exists.
 *
 * Fetched from inside the page rather than from Node, so that it is the same
 * origin, the same server and the same cache state that produced the trace. A
 * module Vite retransforms between the profile and this call would yield
 * positions that resolve to the wrong lines, which is why the caller runs this
 * immediately after the profiler stops and before anything else touches the
 * page.
 *
 * The module fetches and parses. It does not resolve positions, window text or
 * read mappings — `spike/source-windows.ts` does the first two and the accuracy
 * suite does the third.
 */

import type { Page } from '@playwright/test';

/** A script as served, with whatever source map it pointed at. */
export interface ResourceSource {
  /** Length of the served script in UTF-16 code units, or -1 if it failed. */
  readonly length: number;
  /** The parsed source map, inline or external, when the script had one. */
  readonly sourceMap: unknown;
  /**
   * Where the map came from: `inline` for a `data:` annotation, the resolved
   * URL for an external one, or `null` when there was no annotation at all.
   * Recorded because the two builds differ here and the difference matters:
   * development serves inline maps per module, production ships `.map` files
   * beside the bundle.
   */
  readonly sourceMapFrom: string | null;
  /** Set when the fetch or the parse failed, so the gap is explicit. */
  readonly error: string | null;
}

/** A resource plus its text, which stays in memory and is never written out. */
interface FetchedResource extends ResourceSource {
  readonly text: string | null;
}

/**
 * Upper bound on the text this will carry back out of the page.
 *
 * react-dom's development build is over a megabyte on its own and a dev-mode
 * trace names a dozen modules, which is fine; a pathological case is not worth
 * stalling a capture over. A resource over the cap is recorded with its length
 * and its map but no text, which costs the text windows for that one script
 * and nothing else.
 */
const MAX_TEXT_CHARS = 8_000_000;

export interface CapturedResources {
  /** What gets written into the dump: no text, so it stays readable. */
  readonly sources: Readonly<Record<string, ResourceSource>>;
  /** What stays in memory, for slicing windows out of. */
  readonly texts: ReadonlyMap<string, string>;
}

/**
 * Fetches every named script from inside the page and returns the parsed source
 * maps separately from the texts.
 *
 * `urls` should be the union of the profiler trace's `resources` and every
 * distinct `sourceURL` on a LoAF script attribution: the two overlap but
 * neither contains the other, since LoAF names the script that registered a
 * listener while the profiler names whatever was on the stack.
 *
 * A URL that cannot be fetched is reported with `length: -1` and an `error`
 * rather than omitted, because "this script was never captured" and "this
 * script had nothing in it" must not look the same to a later reader.
 */
export async function captureResources(
  page: Page,
  urls: readonly string[],
): Promise<CapturedResources> {
  const fetched = await page.evaluate(
    async ([resourceUrls, maxTextChars]: [string[], number]) => {
      const results: Record<string, FetchedResource> = {};

      for (const url of resourceUrls) {
        try {
          const text = await (await fetch(url)).text();
          const annotation = /\/\/# sourceMappingURL=(\S+)/.exec(text);
          const inline =
            /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/.exec(
              text,
            );

          let sourceMap: unknown = null;
          let sourceMapFrom: string | null = null;

          if (inline?.[1] !== undefined) {
            // `atob` yields one byte per character, so the UTF-8 in
            // `sourcesContent` has to be decoded explicitly. Parsing the byte
            // string directly turns every accented character in the fixture's
            // own data into mojibake.
            const bytes = Uint8Array.from(atob(inline[1]), (char) => char.charCodeAt(0));
            sourceMap = JSON.parse(new TextDecoder().decode(bytes));
            sourceMapFrom = 'inline';
          } else if (annotation?.[1] !== undefined) {
            // The production path: Vite emits `.map` files beside the bundle
            // and annotates them by relative URL. The v0.1 spike followed only
            // inline maps, which is why nothing in `spike/out/` could resolve a
            // production position.
            const mapUrl = new URL(annotation[1], url).href;
            sourceMap = await (await fetch(mapUrl)).json();
            sourceMapFrom = mapUrl;
          }

          results[url] = {
            length: text.length,
            sourceMap,
            sourceMapFrom,
            error: null,
            text: text.length <= maxTextChars ? text : null,
          };
        } catch (error) {
          results[url] = {
            length: -1,
            sourceMap: null,
            sourceMapFrom: null,
            error: String(error),
            text: null,
          };
        }
      }

      return results;
    },
    [[...urls], MAX_TEXT_CHARS] as [string[], number],
  );

  const sources: Record<string, ResourceSource> = {};
  const texts = new Map<string, string>();

  for (const [url, resource] of Object.entries(fetched)) {
    const { text, ...withoutText } = resource;
    sources[url] = withoutText;
    if (text !== null) texts.set(url, text);
  }

  return { sources, texts };
}
