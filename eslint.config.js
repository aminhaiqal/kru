import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['src/web/public/**', 'dist/**', 'node_modules/**'] },
  {
    files: ['src/web/client/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      globals: { ...globals.browser, escape: 'off', name: 'off', status: 'off', event: 'off' },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['desktop/**/*.cjs', 'scripts/**/*.cjs', 'eslint.config.js'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
