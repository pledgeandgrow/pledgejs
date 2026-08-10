import { describe, it, expect } from 'vitest';
import {
  pathToPattern,
  compilePattern,
  matchRoute,
  getInterceptLevel,
  isParallelSlot,
} from './match';
import type { ResolvedRoute } from 'pledgestack-shared';

describe('pathToPattern', () => {
  it('converts static path', () => {
    expect(pathToPattern('about')).toBe('/about');
  });

  it('converts root page', () => {
    expect(pathToPattern('')).toBe('/');
  });

  it('converts dynamic segment [slug]', () => {
    expect(pathToPattern('blog/[slug]')).toBe('/blog/:slug');
  });

  it('converts catch-all [...slug]', () => {
    expect(pathToPattern('docs/[...slug]')).toBe('/docs/*slug');
  });

  it('converts optional catch-all [[...slug]]', () => {
    expect(pathToPattern('docs/[[...slug]]')).toBe('/docs/*slug');
  });

  it('skips route groups (group)', () => {
    expect(pathToPattern('shop/(group)/product')).toBe('/shop/product');
  });

  it('skips parallel route slots @slot', () => {
    expect(pathToPattern('dashboard/@analytics')).toBe('/dashboard');
  });

  it('handles intercepting routes (..)folder', () => {
    expect(pathToPattern('photos/(..)foo')).toBe('/photos/foo');
  });

  it('handles nested dynamic segments', () => {
    expect(pathToPattern('shop/[category]/[id]')).toBe('/shop/:category/:id');
  });
});

describe('compilePattern', () => {
  it('compiles static pattern', () => {
    const { regex, paramNames } = compilePattern('/about');
    expect(paramNames).toEqual([]);
    expect(regex.test('/about')).toBe(true);
    expect(regex.test('/about/')).toBe(true);
    expect(regex.test('/about/us')).toBe(false);
  });

  it('compiles dynamic pattern', () => {
    const { regex, paramNames } = compilePattern('/blog/:slug');
    expect(paramNames).toEqual(['slug']);
    expect(regex.test('/blog/hello-world')).toBe(true);
    expect(regex.test('/blog')).toBe(false);
  });

  it('compiles catch-all pattern', () => {
    const { regex, paramNames } = compilePattern('/docs/*slug');
    expect(paramNames).toEqual(['slug']);
    expect(regex.test('/docs')).toBe(true);
    expect(regex.test('/docs/a/b/c')).toBe(true);
  });

  it('compiles root pattern', () => {
    const { regex } = compilePattern('/');
    expect(regex.test('/')).toBe(true);
  });

  it('escapes regex special chars in static segments', () => {
    const { regex } = compilePattern('/v1.0/page');
    expect(regex.test('/v1.0/page')).toBe(true);
    expect(regex.test('/v100/page')).toBe(false);
  });
});

describe('matchRoute', () => {
  const routes: ResolvedRoute[] = [
    { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
    { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
    { pattern: '/blog/:slug', filePath: 'blog/[slug]/page.tsx', mode: 'ssr' } as ResolvedRoute,
    { pattern: '/docs/*slug', filePath: 'docs/[...slug]/page.tsx', mode: 'ssr' } as ResolvedRoute,
  ];

  it('matches root', () => {
    const match = matchRoute('/', routes);
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/');
  });

  it('matches static route', () => {
    const match = matchRoute('/about', routes);
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/about');
  });

  it('matches dynamic route and extracts params', () => {
    const match = matchRoute('/blog/hello-world', routes);
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/blog/:slug');
    expect(match?.params.slug).toBe('hello-world');
  });

  it('matches catch-all route', () => {
    const match = matchRoute('/docs/a/b/c', routes);
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/docs/*slug');
    expect(match?.params.slug).toBe('a/b/c');
  });

  it('returns null for no match', () => {
    const match = matchRoute('/nonexistent', routes);
    expect(match).toBeNull();
  });

  it('prefers more specific route (static over dynamic)', () => {
    const routesWithSpecific: ResolvedRoute[] = [
      ...routes,
      { pattern: '/blog/:slug', filePath: 'blog/[slug]/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/blog/latest', filePath: 'blog/latest/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const match = matchRoute('/blog/latest', routesWithSpecific);
    expect(match).not.toBeNull();
    expect(match?.route.pattern).toBe('/blog/latest');
  });

  it('URL-decodes param values', () => {
    const match = matchRoute('/blog/hello%20world', routes);
    expect(match).not.toBeNull();
    expect(match?.params.slug).toBe('hello world');
  });
});

describe('getInterceptLevel', () => {
  it('returns 1 for (..)', () => {
    expect(getInterceptLevel('(..)')).toBe(1);
  });

  it('returns 2 for (...)', () => {
    expect(getInterceptLevel('(...)')).toBe(2);
  });

  it('returns null for non-intercept segment', () => {
    expect(getInterceptLevel('foo')).toBeNull();
  });
});

describe('isParallelSlot', () => {
  it('returns true for @slot', () => {
    expect(isParallelSlot('@analytics')).toBe(true);
    expect(isParallelSlot('@modal')).toBe(true);
  });

  it('returns false for non-slot', () => {
    expect(isParallelSlot('foo')).toBe(false);
    expect(isParallelSlot('[slug]')).toBe(false);
  });
});
