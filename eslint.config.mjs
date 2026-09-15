import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next*/**',
      '**/build/**',
      'apps/frontend/tmp/**',
      'apps/cli/vendor/**',
      'plugins/**',
      'test-results/**',
      'uploads/**',
      'uploads-rate-test/**',
      'coverage/**',
      '**/*.cjs',
      '.dbg/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': 'warn',
      'no-constant-condition': 'warn',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'no-prototype-builtins': 'warn',
      'no-async-promise-executor': 'warn',
      'no-fallthrough': 'warn',
      'no-control-regex': 'warn',
      'no-unsafe-finally': 'warn',
      'no-func-assign': 'warn',
      'no-cond-assign': 'warn',
      'no-dupe-else-if': 'warn',
      'use-isnan': 'warn',
      'valid-typeof': 'warn',
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      'no-extra-boolean-cast': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
    },
  },
  {
    files: ['examples/**/*.js'],
    languageOptions: {
      globals: { tmuxgo: 'readonly' },
    },
  },
  {
    files: ['apps/frontend/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
