import { describe, it, expect } from 'vitest';
import { resolveRoutes, createRouter } from 'pledgestack-core';
import type { PledgeConfig } from 'pledgestack-shared';
import type { ScannedFile } from 'pledgestack-core';

const config: PledgeConfig = {
  rootDir: '/test', appDir: 'app', publicDir: 'public', outDir: '.pledge',
  framework: 'react', bundler: 'pledgepack', defaultRuntime: 'node',
  output: 'standalone', rsc: false, tailwind: false, securityHeaders: true,
};

function makeFile(relativePath: string, convention: string): ScannedFile {
  const segments = relativePath.split('/').filter(Boolean);
  return {
    absolutePath: `/test/app/${relativePath}`,
    relativePath,
    convention: convention as never,
    segments,
  };
}

describe('Route Matching Edge Cases (#38)', () => {
  it('matches static routes', () => {
    const files = [makeFile('page.tsx', 'page')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/');
    expect(match).not.toBeNull();
  });

  it('matches dynamic segments', () => {
    const files = [makeFile('blog/[slug]/page.tsx', 'page')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/blog/hello-world');
    expect(match).not.toBeNull();
    expect(match?.params.slug).toBe('hello-world');
  });

  it('matches nested dynamic segments', () => {
    const files = [makeFile('shop/[category]/[id]/page.tsx', 'page')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/shop/electronics/123');
    expect(match).not.toBeNull();
  });

  it('matches catch-all routes', () => {
    const files = [makeFile('docs/[...slug]/page.tsx', 'page')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/docs/getting-started/installation');
    expect(match).not.toBeNull();
  });

  it('returns null for unmatched routes', () => {
    const files = [makeFile('about/page.tsx', 'page')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/nonexistent');
    expect(match).toBeNull();
  });

  it('matches API routes', () => {
    const files = [makeFile('api/users/route.ts', 'route')];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/api/users');
    expect(match).not.toBeNull();
    expect(match?.route.mode).toBe('api');
  });

  it('registers a layout colocated with a page (root layout applies)', () => {
    const files = [makeFile('page.tsx', 'page'), makeFile('layout.tsx', 'layout')];
    const routes = resolveRoutes(files, config);
    const layoutRoute = routes.find((r) => r.isLayout);
    expect(layoutRoute?.filePath).toBe('/test/app/layout.tsx');
    expect(layoutRoute?.pattern).toBe('/');

    const router = createRouter(routes, config);
    const match = router.match('/');
    expect(match?.route.isLayout).not.toBe(true);
    const layouts = router.getLayouts(match!);
    expect(layouts.map((l) => l.filePath)).toContain('/test/app/layout.tsx');
  });

  it('applies a nested layout chain for colocated layouts', () => {
    const files = [
      makeFile('layout.tsx', 'layout'),
      makeFile('page.tsx', 'page'),
      makeFile('blog/layout.tsx', 'layout'),
      makeFile('blog/page.tsx', 'page'),
    ];
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);
    const match = router.match('/blog');
    const layouts = router.getLayouts(match!);
    expect(layouts.map((l) => l.filePath)).toEqual([
      '/test/app/layout.tsx',
      '/test/app/blog/layout.tsx',
    ]);
  });
});
