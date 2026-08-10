import { describe, it, expect } from 'vitest';
import { detectRouteConflicts, formatRouteConflicts } from './conflicts';
import type { ResolvedRoute } from 'pledgestack-shared';

describe('detectRouteConflicts', () => {
  it('returns empty for no conflicts', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/', filePath: 'page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/blog/:slug', filePath: 'blog/[slug]/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const conflicts = detectRouteConflicts(routes);
    expect(conflicts).toEqual([]);
  });

  it('detects exact duplicate patterns', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/index.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const conflicts = detectRouteConflicts(routes);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts[0].conflictingPattern).toBe('/about');
  });

  it('detects ambiguous dynamic segments at same position', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/blog/:slug', filePath: 'blog/[slug]/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/blog/:id', filePath: 'blog/[id]/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const conflicts = detectRouteConflicts(routes);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores layouts and not-found routes', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/blog', filePath: 'blog/layout.tsx', mode: 'ssr', isLayout: true } as ResolvedRoute,
      { pattern: '/blog', filePath: 'blog/page.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const conflicts = detectRouteConflicts(routes);
    // Layout + page at same pattern is not a conflict
    expect(conflicts).toEqual([]);
  });
});

describe('formatRouteConflicts', () => {
  it('formats conflicts as readable string', () => {
    const routes: ResolvedRoute[] = [
      { pattern: '/about', filePath: 'about/page.tsx', mode: 'ssr' } as ResolvedRoute,
      { pattern: '/about', filePath: 'about/index.tsx', mode: 'ssr' } as ResolvedRoute,
    ];
    const conflicts = detectRouteConflicts(routes);
    const formatted = formatRouteConflicts(conflicts);
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('returns no-conflicts message for empty array', () => {
    const formatted = formatRouteConflicts([]);
    expect(formatted).toContain('No route conflicts');
  });
});
