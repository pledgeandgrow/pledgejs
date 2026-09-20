import { describe, it, expect } from 'vitest';
import { resolveRouteChain, routeMapKey } from './route-chain';

describe('routeMapKey', () => {
  it('keeps plain patterns for pages/api and prefixes other conventions', () => {
    expect(routeMapKey('page', '/')).toBe('/');
    expect(routeMapKey('route', '/api/x')).toBe('/api/x');
    expect(routeMapKey('layout', '/')).toBe('layout:/');
    expect(routeMapKey('error', '/a')).toBe('error:/a');
  });
});

describe('resolveRouteChain (framework-agnostic hydration chain)', () => {
  const P = () => 'page', L0 = () => 'l0', L1 = () => 'l1';
  const routes = {
    '/': { type: 'page', component: () => 'home' },
    'layout:/': { type: 'layout', component: L0 },
    'layout:/blog': { type: 'layout', component: L1 },
    '/blog/:slug': { type: 'page', component: P },
  };
  it('returns page and layouts outermost-first without key collisions', () => {
    const c = resolveRouteChain(routes, { pattern: '/blog/:slug', params: {}, searchParams: {} });
    expect(c?.page).toBe(P);
    expect(c?.layouts).toEqual([L0, L1]);
  });
  it('root page still finds the root layout', () => {
    const c = resolveRouteChain(routes, { pattern: '/', params: {}, searchParams: {} });
    expect(c?.layouts).toEqual([L0]);
  });
  it('returns null for unknown pattern', () => {
    expect(resolveRouteChain(routes, { pattern: '/nope', params: {}, searchParams: {} })).toBeNull();
  });
});
