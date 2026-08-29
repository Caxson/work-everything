// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'spikes/**', 'native/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Fixture helpers run as plain Node scripts, not through the TS program.
    files: ['tests/fixtures/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly', console: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/cli.ts'],
    rules: { 'no-console': 'off' },
  },
);
