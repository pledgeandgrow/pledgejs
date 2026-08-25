import { describe, it, expect } from 'vitest';
import { checkGeoRestriction, checkEdgeRateLimit, verifyEdgeJwt } from './edge-security';

function reqWith(headers: Record<string, string>): Request {
  return new Request('https://example.com/', { headers });
}

describe('checkGeoRestriction (fail-closed in allow mode)', () => {
  it('denies a missing-country request in allowlist mode', () => {
    const result = checkGeoRestriction(reqWith({}), { mode: 'allow', countries: ['US'] });
    expect(result.allowed).toBe(false);
  });

  it('allows a missing-country request in blocklist mode', () => {
    const result = checkGeoRestriction(reqWith({}), { mode: 'block', countries: ['CN'] });
    expect(result.allowed).toBe(true);
  });

  it('allows a permitted country in allowlist mode', () => {
    const result = checkGeoRestriction(reqWith({ 'cf-ipcountry': 'US' }), { mode: 'allow', countries: ['US'] });
    expect(result.allowed).toBe(true);
  });

  it('blocks a listed country in blocklist mode', () => {
    const result = checkGeoRestriction(reqWith({ 'cf-ipcountry': 'CN' }), { mode: 'block', countries: ['CN'] });
    expect(result.allowed).toBe(false);
  });
});

describe('checkEdgeRateLimit', () => {
  it('limits after the configured count within the window', () => {
    const cfg = { limit: 3, windowSeconds: 60, keyBy: 'ip' as const };
    const key = `test-${Math.floor(performance.now())}`;
    expect(checkEdgeRateLimit(key, cfg).limited).toBe(false);
    expect(checkEdgeRateLimit(key, cfg).limited).toBe(false);
    expect(checkEdgeRateLimit(key, cfg).limited).toBe(false);
    expect(checkEdgeRateLimit(key, cfg).limited).toBe(true);
  });
});

describe('verifyEdgeJwt algorithm handling', () => {
  it('rejects a token whose alg is not in the allow-list (alg confusion)', async () => {
    // alg: HS256 (symmetric) should never be accepted by an RS/ES verifier.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const token = `${header}.${payload}.c2ln`;
    const result = await verifyEdgeJwt(token, { jwksUri: 'https://idp.example/jwks', algorithms: ['RS256', 'ES256'] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('rejects a malformed token', async () => {
    const result = await verifyEdgeJwt('not-a-jwt', { jwksUri: 'https://idp.example/jwks' });
    expect(result.valid).toBe(false);
  });

  it('decodes base64url header/payload containing - and _ without throwing', async () => {
    // Header/payload crafted to include URL-alphabet chars; verification will
    // fail later (no JWKS), but decoding must not throw as bare atob() would.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'a-b_c', data: '>>>???' })).toString('base64url');
    const token = `${header}.${payload}.${Buffer.from('sig').toString('base64url')}`;
    const result = await verifyEdgeJwt(token, { jwksUri: 'https://idp.invalid/jwks' });
    // Not valid (JWKS fetch fails), but the failure is graceful, not a decode throw.
    expect(result.valid).toBe(false);
  });
});
