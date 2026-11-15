import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // The package is `"type": "module"`, so `.js` already means ESM here and the
  // default `.mjs`/`.d.mts` naming would only have to be mirrored in the
  // `exports` map. Keeping the plain extension keeps the two in step.
  fixedExtension: false,
});
