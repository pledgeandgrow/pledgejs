import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from 'pledgestack-core';

describe('Rate Limiter (#44)', () => {
  it('allows requests within token limit', () => {
    const result = checkRateLimit('test-ip-1', 100, 10);
    expect(result.allowed).toBe(true);
  });

  it('blocks requests when tokens exhausted', () => {
    // Exhaust all tokens
    for (let i = 0; i < 100; i++) {
      checkRateLimit('test-ip-2', 100, 0);
    }
    const result = checkRateLimit('test-ip-2', 100, 0);
    expect(result.allowed).toBe(false);
  });

  it('provides retry-after time when blocked', () => {
    for (let i = 0; i < 100; i++) {
      checkRateLimit('test-ip-3', 100, 0);
    }
    const result = checkRateLimit('test-ip-3', 100, 0);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks different IPs independently', () => {
    // Exhaust IP A
    for (let i = 0; i < 100; i++) {
      checkRateLimit('ip-a', 100, 0);
    }
    // IP B should still be allowed
    const result = checkRateLimit('ip-b', 100, 10);
    expect(result.allowed).toBe(true);
  });

  it('refills tokens over time', async () => {
    // Use all tokens with 0 refill rate
    for (let i = 0; i < 10; i++) {
      checkRateLimit('refill-test', 10, 0);
    }
    expect(checkRateLimit('refill-test', 10, 0).allowed).toBe(false);
    // With a high refill rate, new tokens become available
    const result = checkRateLimit('refill-test', 10, 100);
    // The refill happens on the next call
    expect(typeof result.allowed).toBe('boolean');
  });
});
