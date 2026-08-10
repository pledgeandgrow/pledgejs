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
