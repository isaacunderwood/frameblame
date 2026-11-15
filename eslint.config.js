import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat config for the whole workspace.
 *
 * Type-checked strict + stylistic rules are on everywhere, which is why
 * `projectService` is enabled: it hands each linted file the nearest tsconfig
 * rather than making us enumerate projects here. `eslint-config-prettier` is
 * last so it can switch off any rule that would contest formatting; Prettier
 * itself is not run through ESLint.
 */
export default tseslint.config(
  {
    // `spike/archive` holds one-off probes kept as evidence for `findings.md`.
    // Holding them to this config would mean rewriting them, and a rewritten
    // probe is no longer a record of what was run. See its README.
    // `learning/` is a teaching workspace that happens to live here, not part
    // of the tool. It has its own conventions and is not built or shipped.
    ignores: ['**/dist/**', 'spike/out/**', 'spike/archive/**', 'learning/**'],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Code that runs inside the measured page or the viewer tab. `core` is
  // deliberately excluded: it is pure, and leaving the browser globals
  // undeclared there turns an accidental `performance.now()` into a lint error
  // rather than a runtime dependency on the DOM.
  {
    files: ['packages/agent/**/*.ts', 'packages/react/**/*.ts', 'apps/**', 'fixtures/**'],
    languageOptions: { globals: globals.browser },
  },

  // Build and spike scripts run under Node.
  {
    files: ['**/*.config.{js,ts}', 'spike/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Config files live outside every tsconfig's `include`, so type-aware rules
  // have no program to consult for them.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
