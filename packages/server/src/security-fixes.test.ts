import { describe, it, expect } from 'vitest';
import { detectBot } from './safety-net';
import { generateCorsHeaders, corsMiddleware } from './cors';

describe('bot detection (fixed inversion)', () => {
  it('challenges a high-confidence bot (>= 0.7)', () => {
    // curl UA + missing Accept/Accept-Language/Accept-Encoding + short UA → high confidence.
    const result = detectBot({
      headers: { 'user-agent': 'curl/8.0' },
      method: 'GET',
      path: '/',
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.isBot).toBe(true);
    // The handler blocks on isBot && shouldChallenge — both must be true here.
    expect(result.shouldChallenge).toBe(true);
  });

  it('does not flag a normal browser request', () => {
    const result = detectBot({
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
      method: 'GET',
      path: '/',
    });
    expect(result.isBot).toBe(false);
  });
});

describe('CORS fixes', () => {
  it('rejects a disallowed-origin preflight (not a 204 success)', () => {
    const result = corsMiddleware(
      'OPTIONS',
      { origin: 'https://evil.com', 'access-control-request-method': 'POST' },
      { origins: ['https://good.com'] },
    );
    expect(result?.rejected).toBe(true);
    expect(Object.keys(result!.headers)).toHaveLength(0);
  });

  it('allows a permitted-origin preflight', () => {
    const result = corsMiddleware(
      'OPTIONS',
      { origin: 'https://good.com', 'access-control-request-method': 'POST' },
      { origins: ['https://good.com'] },
    );
    expect(result?.rejected).toBeFalsy();
    expect(result!.headers['Access-Control-Allow-Origin']).toBe('https://good.com');
  });

  it('reflects the origin (not *) when credentials + wildcard are combined', () => {
    const headers = generateCorsHeaders('https://app.example.com', {
      origins: ['*'],
      credentials: true,
    });
    // `*` + credentials is rejected by browsers, so the specific origin is reflected.
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Vary']).toBe('Origin');
  });

  it('still uses * for wildcard without credentials', () => {
    const headers = generateCorsHeaders('https://app.example.com', { origins: ['*'] });
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
