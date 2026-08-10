import { describe, it, expect } from 'vitest';
import { buildRouteTree, flattenRouteTree, getLayoutChain, createRouter } from './router';
import type { ResolvedRoute } from 'pledgestack-shared';
import type { PledgeConfig } from 'pledgestack-shared';

const mockConfig: PledgeConfig = {
  rootDir: '.',
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  rsc: false,
  tailwind: false,
  output: 'standalone',
};

describe('buildRouteTree', () => {
  it('builds a tree from simple routes', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/blog', filePath: 'blog/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    expect(tree.root.pattern).toBe('/');
    expect(tree.root.children.length).toBe(2);
    expect(tree.root.children.find((c) => c.segment === 'about')).toBeDefined();
    expect(tree.root.children.find((c) => c.segment === 'blog')).toBeDefined();
  });

  it('builds nested tree', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/blog/post', filePath: 'blog/post/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    const blog = tree.root.children.find((c) => c.segment === 'blog');
    expect(blog).toBeDefined();
    const post = blog?.children.find((c) => c.segment === 'post');
    expect(post).toBeDefined();
    expect(post?.pattern).toBe('/blog/post');
  });

  it('attaches layouts to nodes', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/blog', filePath: 'blog/layout.tsx', mode: 'ssr', isLayout: true } as ResolvedRoute,
      { pattern: '/blog', filePath: 'blog/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    const blog = tree.root.children.find((c) => c.segment === 'blog');
    expect(blog?.layouts.length).toBe(1);
  });
});

describe('flattenRouteTree', () => {
  it('flattens tree back to route list', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    const flat = flattenRouteTree(tree);
    expect(flat.length).toBeGreaterThanOrEqual(2);
  });
});

describe('getLayoutChain', () => {
  it('returns empty for root route with no layouts', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    const layouts = getLayoutChain(
      { pathname: '/', params: {}, route: routes[0] },
      tree,
    );
    expect(layouts).toEqual([]);
  });

  it('returns layouts for nested route', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/blog', filePath: 'blog/layout.tsx', mode: 'ssr', isLayout: true } as ResolvedRoute,
      { pattern: '/blog/post', filePath: 'blog/post/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const tree = buildRouteTree(routes);
    const layouts = getLayoutChain(
      { pathname: '/blog/post', params: {}, route: routes[1] },
      tree,
    );
    expect(layouts.length).toBe(1);
    expect(layouts[0].filePath).toBe('blog/layout.tsx');
  });
});

describe('createRouter', () => {
  it('creates a router with match function', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const router = createRouter(routes, mockConfig);
    expect(router.match).toBeDefined();
    expect(router.tree).toBeDefined();
  });

  it('matches routes correctly', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const router = createRouter(routes, mockConfig);
    const match = router.match('/about');
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/about');
  });

  it('returns null for non-matching route', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const router = createRouter(routes, mockConfig);
    const match = router.match('/nonexistent');
    expect(match).toBeNull();
  });
});
