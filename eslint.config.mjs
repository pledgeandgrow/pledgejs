// ESLint flat config for the PledgeStack monorepo.
// Uses typescript-eslint for parsing and the local pledgestack plugin for
// framework conventions. Non-type-aware rules only, to keep CI fast.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import pledgePlugin from './packages/eslint-plugin-pledge/dist/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      '**/.pledge/**',
      '**/.pledge-cache/**',
      '**/coverage/**',
      '**/target/**',
      '**/*.d.ts',
      '**/*.min.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      pledge: pledgePlugin,
    },
    rules: {
      // PledgeStack framework conventions
      'pledge/no-default-export-in-page': 'error',
      'pledge/no-default-export-in-layout': 'error',
      'pledge/no-async-in-client-component': 'error',
      'pledge/no-use-client-in-server': 'error',
      'pledge/no-eval': 'error',
      'pledge/no-implied-eval': 'error',
      'pledge/no-new-func': 'error',
      'pledge/no-dangerously-set-inner-html': 'warn',
      'pledge/no-unsafe-fetch': 'warn',
      'pledge/no-secrets-in-client': 'error',

      // no-undef is redundant — the TypeScript compiler already catches
      // undefined identifiers (typescript-eslint recommendation).
      'no-undef': 'off',

      // Relaxed for a large existing codebase — tighten over time
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  {
    // CommonJS files (webpack loaders, configs)
    files: ['**/*.{cjs,js}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
);
