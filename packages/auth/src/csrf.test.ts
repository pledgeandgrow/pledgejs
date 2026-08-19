import { describe, it, expect } from 'vitest';
import { generateCsrfToken, csrfCookie, validateCsrfToken, validateOrigin, isSameSiteRequest, csrfProtection } from './csrf';
import type { PledgeRequest } from 'pledgestack-shared';

describe('CSRF Protection', () => {
  describe('generateCsrfToken', () => {
    it('generates a hex string', () => {
      const token = generateCsrfToken();
      expect(token).toMatch(/^[a-f0-9]+$/);
    });

    it('generates token of expected length', () => {
      const token = generateCsrfToken(16);
      // 16 bytes = 32 hex chars
      expect(token.length).toBe(32);
    });

    it('generates unique tokens', () => {
      const t1 = generateCsrfToken();
      const t2 = generateCsrfToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('csrfCookie', () => {
    it('generates Set-Cookie header', () => {
      const cookie = csrfCookie('abc123');
      expect(cookie).toContain('__pledge_csrf=abc123');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('uses custom cookie name', () => {
      const cookie = csrfCookie('abc123', { cookieName: 'custom_csrf' });
      expect(cookie).toContain('custom_csrf=abc123');
    });
  });

  describe('validateCsrfToken', () => {
    it('returns true when tokens match', () => {
      const token = 'abc123def456';
      expect(validateCsrfToken(token, token)).toBe(true);
    });

    it('returns false when cookie token is missing', () => {
      expect(validateCsrfToken(undefined, 'abc123')).toBe(false);
    });

    it('returns false when header token is missing', () => {
      expect(validateCsrfToken('abc123', undefined)).toBe(false);
    });

    it('returns false when tokens differ', () => {
      expect(validateCsrfToken('abc123', 'def456')).toBe(false);
    });

    it('returns false when lengths differ', () => {
      expect(validateCsrfToken('abc', 'abcd')).toBe(false);
    });
  });

  describe('validateOrigin', () => {
    it('returns true for matching origin', () => {
      expect(validateOrigin('https://example.com', ['https://example.com'])).toBe(true);
    });

    it('returns false for non-matching origin', () => {
      expect(validateOrigin('https://evil.com', ['https://example.com'])).toBe(false);
    });

    it('returns false for missing origin', () => {
      expect(validateOrigin(undefined, ['https://example.com'])).toBe(false);
    });
  });

  describe('isSameSiteRequest', () => {
    it('returns true when Sec-Fetch-Site is same-origin', () => {
      expect(isSameSiteRequest({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    });

    it('returns true when Sec-Fetch-Site is same-site', () => {
      expect(isSameSiteRequest({ 'sec-fetch-site': 'same-site' })).toBe(true);
    });

    it('returns true when Sec-Fetch-Site is none (top-level navigation)', () => {
      expect(isSameSiteRequest({ 'sec-fetch-site': 'none' })).toBe(true);
    });

    it('returns false when Sec-Fetch-Site is cross-site', () => {
      expect(isSameSiteRequest({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    });

    it('returns false when Sec-Fetch-Site is missing (not assumed same-site)', () => {
      expect(isSameSiteRequest({})).toBe(false);
    });
  });

  describe('csrfProtection', () => {
    function makeRequest(overrides: Partial<PledgeRequest> = {}): PledgeRequest {
      return {
        url: new URL('https://example.com/api/action'),
        method: 'POST',
        headers: {},
        params: {},
        query: {},
        cookies: {},
        ...overrides,
      };
    }

    it('rejects a forged cross-origin request that omits Sec-Fetch-Site, when allowedOrigins is configured', () => {
      // Double-submit token matches (simulating a case where the attacker
      // somehow obtained a valid token pair, e.g. via a cookie-scoping bug),
      // but the request comes from an unlisted Origin and doesn't claim to
      // be same-site — this must still be rejected by the Origin check.
      const req = makeRequest({
        cookies: { __pledge_csrf: 'token123' },
        headers: { 'x-pledge-csrf': 'token123', origin: 'https://evil.com' },
      });
      expect(csrfProtection(req, { allowedOrigins: ['https://example.com'] })).toBe(false);
    });

    it('accepts a same-origin request that omits Sec-Fetch-Site but has a matching Origin', () => {
      const req = makeRequest({
        cookies: { __pledge_csrf: 'token123' },
        headers: { 'x-pledge-csrf': 'token123', origin: 'https://example.com' },
      });
      expect(csrfProtection(req, { allowedOrigins: ['https://example.com'] })).toBe(true);
    });

    it('accepts a request the browser marks same-origin via Sec-Fetch-Site, even with no Origin header', () => {
      const req = makeRequest({
        cookies: { __pledge_csrf: 'token123' },
        headers: { 'x-pledge-csrf': 'token123', 'sec-fetch-site': 'same-origin' },
      });
      expect(csrfProtection(req, { allowedOrigins: ['https://example.com'] })).toBe(true);
    });

    it('rejects when the double-submit token is missing entirely, regardless of origin checks', () => {
      const req = makeRequest({ cookies: {}, headers: { origin: 'https://example.com' } });
      expect(csrfProtection(req, { allowedOrigins: ['https://example.com'] })).toBe(false);
    });
  });
});
