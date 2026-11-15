/**
 * Prettier owns formatting and nothing else. It runs as its own command rather
 * than through ESLint, so the two never contest the same concern.
 *
 * @type {import("prettier").Config}
 */
export default {
  printWidth: 90,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
};
