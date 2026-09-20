import { describe, it, expect } from 'vitest';
import { resetRateLimit } from 'pledgestack-core';
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

  it('keys on the trusted ctx.ip, not raw x-forwarded-for', () => {
    // Spoofed XFF must not give each request a fresh bucket: two requests
    // with different XFF but the same resolved ip share one bucket.
    resetRateLimit('203.0.113.9');
    const plugin = rateLimitMiddleware({ maxTokens: 1, refillRate: 0 });
    const ctx = (xff: string) => ({
      pathname: '/api/x',
      method: 'GET',
      headers: { 'x-forwarded-for': xff },
      ip: '203.0.113.9',
      params: {},
      searchParams: new URLSearchParams(),
    }) as any;
    expect(plugin.routeMatch?.(ctx('1.1.1.1'))).toBeUndefined();
    // Second request spoofs a different XFF — still the same bucket → limited.
    const second = plugin.routeMatch?.(ctx('9.9.9.9'));
    expect(second?.response?.status).toBe(429);
  });
});
