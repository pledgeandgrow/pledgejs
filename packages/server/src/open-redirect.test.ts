import { describe, it, expect } from 'vitest';
import { safeRedirect, validateRedirect } from 'pledgestack-auth';

describe('Open Redirect Protection (#2)', () => {
  it('allows relative URLs', () => {
    expect(validateRedirect('/about')).toBe('/about');
  });

  it('allows same-origin absolute URLs', () => {
    expect(validateRedirect('http://localhost:3000/about', { origin: 'http://localhost:3000' })).toBe('http://localhost:3000/about');
  });

  it('blocks external URLs', () => {
    expect(validateRedirect('http://evil.com')).toBeNull();
  });

  it('blocks javascript: URLs', () => {
    expect(validateRedirect('javascript:alert(1)')).toBeNull();
  });

  it('blocks data: URLs', () => {
    expect(validateRedirect('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('blocks protocol-relative URLs to external hosts', () => {
    expect(validateRedirect('//evil.com/path')).toBeNull();
  });

  it('allows external hosts in allowlist', () => {
    expect(validateRedirect('http://allowed.com/path', { allowedHosts: ['allowed.com'] })).toBe('http://allowed.com/path');
  });

  it('blocks path traversal in redirects', () => {
    expect(validateRedirect('/../../etc/passwd')).toBeNull();
  });

  it('safeRedirect returns a Response', () => {
    const response = safeRedirect('/about');
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe('/about');
  });

  it('safeRedirect returns 400 for invalid URLs', () => {
    const response = safeRedirect('javascript:alert(1)');
    expect(response.status).toBe(400);
  });
});
