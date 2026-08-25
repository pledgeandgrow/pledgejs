import { describe, it, expect } from 'vitest';
import { createElement, isValidElement, type ReactElement } from 'react';
import { resolveRouteElement } from './router';

function Page(props: Record<string, unknown>) {
  return createElement('main', null, `page ${JSON.stringify(props.params)}`);
}
function RootLayout(props: Record<string, unknown>) {
  return createElement('div', { id: 'root-layout' }, props.children as never);
}
function BlogLayout(props: Record<string, unknown>) {
  return createElement('section', { id: 'blog-layout' }, props.children as never);
}

describe('resolveRouteElement (#3 client hydration tree)', () => {
  const routes = {
    '/': { type: 'layout', component: RootLayout },
    '/blog': { type: 'layout', component: BlogLayout },
    '/blog/:slug': { type: 'page', component: Page },
  };

  it('rebuilds the page wrapped in its layout chain (root outermost)', () => {
    const tree = resolveRouteElement(routes, {
      pattern: '/blog/:slug',
      params: { slug: 'hello' },
      searchParams: {},
    }) as ReactElement;
    expect(isValidElement(tree)).toBe(true);
    // Outermost element is the root layout, then blog layout, then page.
    expect((tree.type as typeof RootLayout)).toBe(RootLayout);
    const blog = (tree.props as { children: ReactElement }).children;
    expect(blog.type).toBe(BlogLayout);
    const page = (blog.props as { children: ReactElement }).children;
    expect(page.type).toBe(Page);
    expect((page.props as { params: unknown }).params).toEqual({ slug: 'hello' });
  });

  it('returns null when the pattern has no page component', () => {
    expect(resolveRouteElement(routes, { pattern: '/missing', params: {}, searchParams: {} })).toBeNull();
  });

  it('renders a page with no layouts', () => {
    const only = { '/about': { type: 'page', component: Page } };
    const tree = resolveRouteElement(only, { pattern: '/about', params: {}, searchParams: {} }) as ReactElement;
    expect(tree.type).toBe(Page);
  });
});
