import { describe, it, expect } from 'vitest';
import { getLayoutChain } from './renderer';
import type { RouteMatch, ResolvedRoute, RouteTree } from './renderer';

describe('shared getLayoutChain', () => {
  function makeRoute(pattern: string, filePath: string, isLayout = false): ResolvedRoute {
    return { pattern, filePath, mode: 'ssr', isLayout } as ResolvedRoute;
  }

  function makeTree(routes: ResolvedRoute[]): RouteTree {
    const root: any = { pattern: '/', segment: '', children: [], layouts: [] };
    for (const route of routes) {
      const segments = route.pattern.split('/').filter(Boolean);
      let current = root;
      for (const seg of segments) {
        let child = current.children.find((c: any) => c.segment === seg);
        if (!child) {
          child = { pattern: `${current.pattern === '/' ? '' : current.pattern}/${seg}`, segment: seg, children: [], layouts: [] };
          current.children.push(child);
        }
        current = child;
      }
      if (route.isLayout) {
        current.layouts.push(route);
      }
    }
    return { root };
  }

  it('returns empty for root with no layouts', () => {
    const routes = [makeRoute('/', 'page.tsx')];
    const tree = makeTree(routes);
    const match: RouteMatch = { pathname: '/', params: {}, route: routes[0] };
    expect(getLayoutChain(match, tree)).toEqual([]);
  });

  it('returns layouts for nested route', () => {
    const layoutRoute = makeRoute('/blog', 'blog/layout.tsx', true);
    const pageRoute = makeRoute('/blog/post', 'blog/post/page.tsx');
    const tree = makeTree([layoutRoute, pageRoute]);
    const match: RouteMatch = { pathname: '/blog/post', params: {}, route: pageRoute };
    const chain = getLayoutChain(match, tree);
    expect(chain.length).toBe(1);
    expect(chain[0].filePath).toBe('blog/layout.tsx');
  });

  it('returns multiple layouts in order (outermost first)', () => {
    const rootLayout = makeRoute('/', 'layout.tsx', true);
    const blogLayout = makeRoute('/blog', 'blog/layout.tsx', true);
    const page = makeRoute('/blog/post', 'blog/post/page.tsx');
    const tree = makeTree([rootLayout, blogLayout, page]);
    const match: RouteMatch = { pathname: '/blog/post', params: {}, route: page };
    const chain = getLayoutChain(match, tree);
    expect(chain.length).toBe(2);
    expect(chain[0].filePath).toBe('layout.tsx');
    expect(chain[1].filePath).toBe('blog/layout.tsx');
  });

  it('handles dynamic segments', () => {
    const layout = makeRoute('/blog', 'blog/layout.tsx', true);
    const page = makeRoute('/blog/:slug', 'blog/[slug]/page.tsx');
    const tree = makeTree([layout, page]);
    const match: RouteMatch = { pathname: '/blog/hello', params: { slug: 'hello' }, route: page };
    const chain = getLayoutChain(match, tree);
    expect(chain.length).toBe(1);
  });

  it('returns empty for null/undefined tree', () => {
    const match: RouteMatch = { pathname: '/', params: {}, route: makeRoute('/', 'page.tsx') };
    expect(getLayoutChain(match, null)).toEqual([]);
    expect(getLayoutChain(match, undefined)).toEqual([]);
  });
});
