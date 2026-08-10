import { describe, it, expect } from 'vitest';
import { generateCorsHeaders, isPreflightRequest, corsMiddleware, DEFAULT_CORS_CONFIG } from './cors';

describe('CORS Middleware', () => {
  describe('generateCorsHeaders', () => {
    it('allows all origins with "*"', () => {
      const headers = generateCorsHeaders('https://evil.com', { origins: ['*'] });
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('allows specific origin', () => {
      const headers = generateCorsHeaders('https://example.com', { origins: ['https://example.com'] });
      expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(headers['Vary']).toBe('Origin');
    });

    it('blocks unlisted origin', () => {
      const headers = generateCorsHeaders('https://evil.com', { origins: ['https://example.com'] });
      expect(Object.keys(headers)).toHaveLength(0);
    });

    it('returns empty for missing origin when not wildcard', () => {
      const headers = generateCorsHeaders(undefined, { origins: ['https://example.com'] });
      expect(Object.keys(headers)).toHaveLength(0);
    });

    it('includes default methods', () => {
      const headers = generateCorsHeaders(undefined, { origins: ['*'] });
      expect(headers['Access-Control-Allow-Methods']).toContain('GET');
      expect(headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(headers['Access-Control-Allow-Methods']).toContain('DELETE');
    });

    it('includes custom methods', () => {
      const headers = generateCorsHeaders(undefined, { origins: ['*'], methods: ['GET', 'POST'] });
      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST');
    });

    it('includes default allowed headers', () => {
      const headers = generateCorsHeaders(undefined, { origins: ['*'] });
      expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
      expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    });

    it('includes exposed headers when provided', () => {
      const headers = generateCorsHeaders(undefined, {
        origins: ['*'],
        exposedHeaders: ['X-Custom-Header', 'X-Rate-Limit'],
      });
      expect(headers['Access-Control-Expose-Headers']).toBe('X-Custom-Header, X-Rate-Limit');
    });

    it('includes credentials flag when enabled', () => {
      const headers = generateCorsHeaders('https://example.com', {
        origins: ['https://example.com'],
        credentials: true,
      });
      expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('includes max age', () => {
      const headers = generateCorsHeaders(undefined, { origins: ['*'], maxAge: 3600 });
      expect(headers['Access-Control-Max-Age']).toBe('3600');
    });
  });

  describe('isPreflightRequest', () => {
    it('returns true for OPTIONS with access-control-request-method', () => {
      expect(isPreflightRequest('OPTIONS', { 'access-control-request-method': 'POST' })).toBe(true);
    });

    it('returns false for OPTIONS without access-control-request-method', () => {
      expect(isPreflightRequest('OPTIONS', {})).toBe(false);
    });

    it('returns false for non-OPTIONS methods', () => {
      expect(isPreflightRequest('GET', { 'access-control-request-method': 'POST' })).toBe(false);
    });
  });

  describe('corsMiddleware', () => {
    it('returns preflight response for OPTIONS', () => {
      const result = corsMiddleware('OPTIONS', {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      }, { origins: ['https://example.com'] });

      expect(result).not.toBeNull();
      expect(result!.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
    });

    it('returns CORS headers for actual requests', () => {
      const result = corsMiddleware('GET', {
        origin: 'https://example.com',
      }, { origins: ['https://example.com'] });

      expect(result).not.toBeNull();
      expect(result!.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
    });

    it('returns empty headers for blocked origin', () => {
      const result = corsMiddleware('GET', {
        origin: 'https://evil.com',
      }, { origins: ['https://example.com'] });

      expect(result).not.toBeNull();
      expect(Object.keys(result!.headers)).toHaveLength(0);
    });
  });

  describe('DEFAULT_CORS_CONFIG', () => {
    it('has empty origins (restrictive by default)', () => {
      expect(DEFAULT_CORS_CONFIG.origins).toEqual([]);
    });

    it('has standard methods', () => {
      expect(DEFAULT_CORS_CONFIG.methods).toContain('GET');
      expect(DEFAULT_CORS_CONFIG.methods).toContain('POST');
    });

    it('has credentials disabled', () => {
      expect(DEFAULT_CORS_CONFIG.credentials).toBe(false);
    });
  });
});
