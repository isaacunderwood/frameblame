import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Resolves `@frameblame/core` to its source rather than to its built output.
 *
 * This mirrors the `paths` entry in `tsconfig.base.json`, which does the same
 * for the compiler: the published `exports` field still points at `dist`, so
 * consumers get the built package, but inside the workspace a test must not
 * depend on a build having been run first. Without this, `pnpm test` would
 * silently assert against whatever `packages/core/dist` happened to contain —
 * which is the version of the bug that is hardest to notice, because the tests
 * pass.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@frameblame/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
