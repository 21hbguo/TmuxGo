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
      'notes/**',
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
      // any 已全仓清零（源码+测试+e2e），error 档物理防回潮；plugins/ 示例在全局 ignores 里
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      // 空 catch 是协议容错/即发即弃的有意模式（全仓 171 处均为 catch{}）；
      // allowEmptyCatch 豁免，保留对空 if/函数块等其他空块的告警
      'no-empty': ['warn', { allowEmptyCatch: true }],
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
