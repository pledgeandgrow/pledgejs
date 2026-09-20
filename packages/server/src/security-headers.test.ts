import { describe, it, expect } from 'vitest';
import { applySecurityHeaders, DEFAULT_SECURITY_HEADERS } from './security-headers';
import type { PledgeConfig } from 'pledgestack-shared';

const config: PledgeConfig = {
  rootDir: '/test', appDir: 'app', publicDir: 'public', outDir: '.pledge',
  framework: 'react', bundler: 'pledgepack', defaultRuntime: 'node',
  output: 'standalone', rsc: false, tailwind: false, securityHeaders: true,
};

describe('Security Headers (#46)', () => {
  it('applies default security headers', () => {
    const result = applySecurityHeaders({}, config);
    expect(result['X-Content-Type-Options']).toBe('nosniff');
    expect(result['X-Frame-Options']).toBe('DENY');
    expect(result['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('applies HSTS on HTTPS', () => {
    const result = applySecurityHeaders({}, config, true);
    expect(result['Strict-Transport-Security']).toContain('max-age=31536000');
  });

  it('does not apply HSTS on HTTP', () => {
    const result = applySecurityHeaders({}, config, false);
    expect(result['Strict-Transport-Security']).toBeUndefined();
  });

  it('does not override existing headers', () => {
    const result = applySecurityHeaders({ 'X-Frame-Options': 'SAMEORIGIN' }, config);
    expect(result['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('skips all headers when securityHeaders is false', () => {
    const disabledConfig = { ...config, securityHeaders: false };
    const result = applySecurityHeaders({}, disabledConfig);
    expect(result['X-Content-Type-Options']).toBeUndefined();
  });

  it('applies default CSP', () => {
    const result = applySecurityHeaders({}, config);
    expect(result['Content-Security-Policy']).toBeDefined();
    expect(result['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('applies custom CSP from config', () => {
    const customCspConfig = { ...config, csp: { 'default-src': "'self'", 'script-src': "'self' 'unsafe-inline'" } } as PledgeConfig;
    const result = applySecurityHeaders({}, customCspConfig);
    expect(result['Content-Security-Policy']).toContain("default-src 'self'");
    expect(result['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('does not override existing CSP', () => {
    const result = applySecurityHeaders({ 'Content-Security-Policy': "default-src 'none'" }, config);
    expect(result['Content-Security-Policy']).toBe("default-src 'none'");
  });
});

describe('secure-by-default hardening', () => {
  it('applies cross-origin isolation headers', () => {
    const result = applySecurityHeaders({}, config);
    expect(result['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(result['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(result['Origin-Agent-Cluster']).toBe('?1');
    expect(result['X-Permitted-Cross-Domain-Policies']).toBe('none');
  });

  it('emits a strict nonce-based CSP when a nonce is provided', () => {
    const result = applySecurityHeaders({}, config, false, { cspNonce: 'testnonce123' });
    const csp = result['Content-Security-Policy'];
    expect(csp).toContain("script-src 'self' 'nonce-testnonce123' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-inline' script-src");
    // unsafe-inline must not be in script-src (it remains for style-src only)
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });

  it('keeps the unsafe-inline fallback when no nonce is provided (ISR/static)', () => {
    const result = applySecurityHeaders({}, config);
    expect(result['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('appends dev bundler origins to script-src and connect-src', () => {
    const result = applySecurityHeaders({}, config, false, {
      cspNonce: 'abc',
      scriptSrc: ['http://localhost:5000'],
      connectSrc: ['http://localhost:5000', 'ws://localhost:5000'],
      allowEval: true,
    });
    const csp = result['Content-Security-Policy'];
    expect(csp).toContain('http://localhost:5000');
    expect(csp).toContain('ws://localhost:5000');
    expect(csp).toContain("'unsafe-eval'");
  });

  it('custom config CSP wins over the nonce policy', () => {
    const customCspConfig = { ...config, csp: { 'default-src': "'none'" } } as PledgeConfig;
    const result = applySecurityHeaders({}, customCspConfig, false, { cspNonce: 'abc' });
    expect(result['Content-Security-Policy']).toBe("default-src 'none'");
  });

  it('appends a report-uri to generated CSPs', () => {
    const result = applySecurityHeaders({}, config, false, { cspNonce: 'abc', reportUri: '/__pledge__/csp-report' });
    expect(result['Content-Security-Policy']).toContain('report-uri /__pledge__/csp-report');
  });

  it('emits Report-Only when reportOnly is set', () => {
    const result = applySecurityHeaders({}, config, false, { cspNonce: 'abc', reportOnly: true });
    expect(result['Content-Security-Policy-Report-Only']).toBeDefined();
    expect(result['Content-Security-Policy']).toBeUndefined();
  });

  it('disables the legacy XSS auditor instead of enabling it', () => {
    // '1; mode=block' introduced XSS vectors in old browsers — modern
    // guidance is to explicitly send 0.
    const result = applySecurityHeaders({}, config);
    expect(result['X-XSS-Protection']).toBe('0');
  });

  it('includes lockdown directives in the nonce policy', () => {
    const result = applySecurityHeaders({}, config, false, { cspNonce: 'abc' });
    const csp = result['Content-Security-Policy'];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('includes lockdown directives in the fallback policy', () => {
    const result = applySecurityHeaders({}, config);
    const csp = result['Content-Security-Policy'];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it('adds upgrade-insecure-requests only on HTTPS', () => {
    const https = applySecurityHeaders({}, config, true, { cspNonce: 'abc' });
    expect(https['Content-Security-Policy']).toContain('upgrade-insecure-requests');
    const http = applySecurityHeaders({}, config, false, { cspNonce: 'abc' });
    expect(http['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
  });

  it('declares Reporting-Endpoints and report-to alongside report-uri', () => {
    const result = applySecurityHeaders({}, config, false, { cspNonce: 'abc' });
    expect(result['Reporting-Endpoints']).toBe('csp-endpoint="/__pledge__/csp-report"');
    expect(result['Content-Security-Policy']).toContain('report-to csp-endpoint');
    expect(result['Content-Security-Policy']).toContain('report-uri /__pledge__/csp-report');
  });
});


describe('applySecurityHeaders case-insensitivity', () => {
  it('does not override lowercase headers set by route handlers', () => {
    const out = applySecurityHeaders(
      { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'none'" },
      {} as never,
    );
    const keys = Object.keys(out).map((k) => k.toLowerCase());
    expect(keys.filter((k) => k === 'x-frame-options')).toHaveLength(1);
    expect(keys.filter((k) => k === 'content-security-policy')).toHaveLength(1);
    expect(out['x-frame-options']).toBe('SAMEORIGIN');
  });
});
