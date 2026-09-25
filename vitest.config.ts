import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx', 'packages/*/src/**/*.d.ts', 'packages/pledgepack/**'],
      // Ratchet: set just below the level currently measured by `pnpm test:coverage`
      // (statements 29.20 / branches 27.68 / functions 30.87 / lines 29.91 at 0.2.0).
      // Raise these as coverage improves; never lower them to make a change pass.
      thresholds: {
        statements: 28,
        branches: 26,
        functions: 29,
        lines: 29,
      },
    },
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      'pledgestack-shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      'pledgestack-core': resolve(__dirname, 'packages/core/src/index.ts'),
      'pledgestack-server': resolve(__dirname, 'packages/server/src/index.ts'),
      'pledgestack-client': resolve(__dirname, 'packages/client/src/index.ts'),
      'pledgestack-auth': resolve(__dirname, 'packages/auth/src/index.ts'),
      'pledgestack-state': resolve(__dirname, 'packages/state/src/index.ts'),
      'pledgestack-api': resolve(__dirname, 'packages/api/src/index.ts'),
      'pledgestack-a11y': resolve(__dirname, 'packages/a11y/src/index.ts'),
      'pledgestack-overlay': resolve(__dirname, 'packages/overlay/src/index.ts'),
      'pledgestack-seo': resolve(__dirname, 'packages/seo/src/index.ts'),
      'pledgestack-sitemap': resolve(__dirname, 'packages/sitemap/src/index.ts'),
      'pledgestack-rss': resolve(__dirname, 'packages/rss/src/index.ts'),
      'pledgestack-font': resolve(__dirname, 'packages/font/src/index.ts'),
      'pledgestack-mdx': resolve(__dirname, 'packages/mdx/src/index.ts'),
      'pledgestack-image': resolve(__dirname, 'packages/image/src/index.ts'),
      'pledgestack-privacy': resolve(__dirname, 'packages/privacy/src/index.ts'),
      'pledgestack-og': resolve(__dirname, 'packages/og/src/index.ts'),
      'pledgestack-ws': resolve(__dirname, 'packages/ws/src/index.ts'),
      'pledgestack-adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
      'pledgestack-renderer-react': resolve(__dirname, 'packages/renderer-react/src/index.ts'),
      'pledgestack-renderer-vue': resolve(__dirname, 'packages/renderer-vue/src/index.ts'),
      'pledgestack-renderer-solid': resolve(__dirname, 'packages/renderer-solid/src/index.ts'),
      'pledgestack-renderer-svelte': resolve(__dirname, 'packages/renderer-svelte/src/index.ts'),
      'pledgestack-bundler-pledgepack': resolve(__dirname, 'packages/bundler-pledgepack/src/index.ts'),
      'pledgestack-bundler-vite': resolve(__dirname, 'packages/bundler-vite/src/index.ts'),
      'pledgestack-eslint-plugin': resolve(__dirname, 'packages/eslint-plugin-pledge/src/index.ts'),
    },
  },
});
