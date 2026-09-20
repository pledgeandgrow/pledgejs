import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedRoute, PledgeConfig } from 'pledgestack-shared';
import { generateStaticExport } from './static-export';

const dynamicRoute = {
  filePath: '/app/blog/[slug]/page.tsx',
  pattern: '/blog/:slug',
  mode: 'ssg',
  runtime: 'node',
  isLayout: false,
  isErrorBoundary: false,
  isLoading: false,
  isNotFound: false,
} as unknown as ResolvedRoute;

describe('generateStaticExport param handling', () => {
  it('never writes outside the output directory for hostile param values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-export-'));
    try {
      const outputDir = join(root, 'out');
      const modules = new Map([
        [dynamicRoute.filePath, { generateStaticParams: async () => [{ slug: '../../escaped' }, { slug: 'ok' }] }],
      ]);
      const result = await generateStaticExport({
        config: { rootDir: root, outDir: '.pledge' } as PledgeConfig,
        routes: [dynamicRoute],
        outputDir,
        renderPage: async () => '<html></html>',
        modules,
      } as never);
      expect(existsSync(join(root, 'escaped.html'))).toBe(false);
      expect(existsSync(join(root, '..', 'escaped.html'))).toBe(false);
      for (const f of result.writtenFiles) expect(f.split(String.fromCharCode(92)).join('/')).toContain('/out/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('substitutes param values literally (no $-pattern expansion)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-export-'));
    try {
      const outputDir = join(root, 'out');
      const modules = new Map([[dynamicRoute.filePath, { generateStaticParams: async () => [{ slug: 'a$&b' }] }]]);
      const result = await generateStaticExport({
        config: { rootDir: root, outDir: '.pledge' } as PledgeConfig,
        routes: [dynamicRoute],
        outputDir,
        renderPage: async () => '<html></html>',
        modules,
      } as never);
      expect(result.writtenFiles.some((f) => f.endsWith('a$&b.html'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
