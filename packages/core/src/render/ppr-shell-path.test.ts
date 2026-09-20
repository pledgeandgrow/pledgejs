import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedRoute, PledgeConfig } from 'pledgestack-shared';
import { generateStaticExport } from './static-export';
import { pprShellFileName } from './ppr-shell-path';

describe('pprShellFileName', () => {
  it('produces names safe on Windows (no : / \ * ? " < > |) and is collision-free', () => {
    const names = [
      pprShellFileName('/'),
      pprShellFileName('/blog/:slug'),
      pprShellFileName('/blog/*rest'),
      pprShellFileName('/blog/:slug', { slug: 'a/b:c' }),
      pprShellFileName('/blog/:slug', { slug: 'x' }),
      pprShellFileName('/blog_:slug'),
    ];
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_.~@-]+\.shell\.html$/);
    expect(new Set(names).size).toBe(names.length);
    expect(pprShellFileName('/blog/:slug', { a: '1', b: '2' })).toBe(pprShellFileName('/blog/:slug', { b: '2', a: '1' }));
  });

  it('bounds very long names', () => {
    expect(pprShellFileName('/x', { q: 'y'.repeat(1000) }).length).toBeLessThan(200);
  });
});

describe('PPR shells: writer and reader agree', () => {
  it('static-export writes exactly the file names the handler looks up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-ppr-'));
    try {
      const route = {
        filePath: '/app/blog/[slug]/page.tsx',
        pattern: '/blog/:slug',
        mode: 'ssr',
        runtime: 'node',
        isLayout: false,
        isErrorBoundary: false,
        isLoading: false,
        isNotFound: false,
      } as unknown as ResolvedRoute;
      const modules = new Map([[route.filePath, { generateStaticParams: async () => [{ slug: 'hello' }] }]]);
      const result = await generateStaticExport({
        config: { rootDir: root, outDir: '.pledge', ppr: true } as PledgeConfig,
        routes: [route],
        outputDir: join(root, 'out'),
        renderPage: async () => '<html></html>',
        prerenderPPRShell: async () => '<shell/>',
        modules,
      } as never);
      expect(result.pprShells).toHaveLength(1);
      const shellDir = join(root, '.pledge', 'ppr-shells');
      // Reader side (server/handler.ts) computes this exact name from match.params.
      expect(existsSync(join(shellDir, pprShellFileName('/blog/:slug', { slug: 'hello' })))).toBe(true);
      expect(readdirSync(shellDir).every((f) => !f.includes(':'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
