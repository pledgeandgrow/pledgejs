import { describe, it, expect } from 'vitest';
import { rateLimitMiddleware } from './rate-limiter';

describe('rateLimitMiddleware', () => {
  it('creates a plugin with correct name', () => {
    const plugin = rateLimitMiddleware();
    expect(plugin.name).toBe('pledgestack-rate-limiter');
  });

  it('excludes /api/health by default', () => {
    const plugin = rateLimitMiddleware();
    expect(plugin).toBeDefined();
    // The excludePaths is internal, but we can test behavior via routeMatch
    const result = plugin.routeMatch?.({
      pathname: '/api/health',
      method: 'GET',
      headers: {},
      params: {},
      searchParams: new URLSearchParams(),
    } as any);
    // Should return undefined (not rate limited)
    expect(result).toBeUndefined();
  });

  it('allows custom exclude paths', () => {
    const plugin = rateLimitMiddleware({ excludePaths: ['/api/health', '/api/status'] });
    expect(plugin).toBeDefined();
  });

  it('accepts custom maxTokens and refillRate', () => {
    const plugin = rateLimitMiddleware({ maxTokens: 200, refillRate: 20 });
    expect(plugin).toBeDefined();
  });
});
