import { describe, it, expect } from 'vitest';
import { matchRoute } from '../router/match';
import { encodeFlight, decodeFlight, createFlightEncoder } from './flight';
import type { ResolvedRoute } from 'pledgestack-shared';

function route(pattern: string, extra: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    filePath: `/app${pattern}/page.tsx`,
    pattern,
    mode: 'ssr',
    runtime: 'node',
    isLayout: false,
    isErrorBoundary: false,
    isLoading: false,
    isNotFound: false,
    ...extra,
  } as ResolvedRoute;
}

describe('matchRoute — layout filtering (#41)', () => {
  it('does not match a layout route as a page', () => {
    const layout = route('/dashboard', { isLayout: true, filePath: '/app/dashboard/layout.tsx' });
    const match = matchRoute('/dashboard', [layout]);
    expect(match).toBeNull();
  });

  it('matches a real page but skips a colliding layout', () => {
    const layout = route('/dashboard', { isLayout: true, filePath: '/app/dashboard/layout.tsx' });
    const page = route('/dashboard', { filePath: '/app/dashboard/page.tsx' });
    const match = matchRoute('/dashboard', [layout, page]);
    expect(match?.route.filePath).toBe('/app/dashboard/page.tsx');
  });
});

describe('matchRoute — specificity (#42)', () => {
  it('prefers a dynamic :slug over a catch-all *rest at the same position', () => {
    const dynamic = route('/blog/:slug', { filePath: '/app/blog/[slug]/page.tsx' });
    const catchAll = route('/blog/*rest', { filePath: '/app/blog/[...rest]/page.tsx' });
    // Catch-all listed first — the more specific dynamic route must still win.
    const match = matchRoute('/blog/hello', [catchAll, dynamic]);
    expect(match?.route.filePath).toBe('/app/blog/[slug]/page.tsx');
  });

  it('prefers a static segment over a dynamic one', () => {
    const dynamic = route('/blog/:slug', { filePath: '/app/blog/[slug]/page.tsx' });
    const staticRoute = route('/blog/featured', { filePath: '/app/blog/featured/page.tsx' });
    const match = matchRoute('/blog/featured', [dynamic, staticRoute]);
    expect(match?.route.filePath).toBe('/app/blog/featured/page.tsx');
  });
});

describe('flight protocol — moduleMap round-trip (#37)', () => {
  it('preserves the module map through encode → decode', () => {
    const enc = createFlightEncoder();
    enc.addModule(1, 'Button', 'chunks/button.js');
    enc.addModule(2, 'Card', 'chunks/card.js');
    enc.addData(3, { hello: 'world' });

    const wire = enc.encode();
    const decoded = decodeFlight(wire);

    expect(decoded.moduleMap).toEqual({ Button: 'chunks/button.js', Card: 'chunks/card.js' });
    const dataChunk = decoded.chunks.find((c) => c.type === 'J');
    expect(dataChunk?.data).toEqual({ hello: 'world' });
  });

  it('encodeFlight emits the chunk path for M chunks', () => {
    const wire = encodeFlight({
      chunks: [{ type: 'M', id: 1, data: 'Widget' }],
      moduleMap: { Widget: 'chunks/widget.js' },
    });
    expect(wire).toContain('chunks/widget.js');
    expect(decodeFlight(wire).moduleMap.Widget).toBe('chunks/widget.js');
  });
});
