import { describe, it, expect } from 'vitest';
import { validateRedirect, safeRedirect } from './open-redirect';

describe('Open Redirect Protection', () => {
  describe('validateRedirect', () => {
    it('allows relative paths', () => {
      expect(validateRedirect('/dashboard')).toBe('/dashboard');
      expect(validateRedirect('/about')).toBe('/about');
    });

    it('blocks javascript: scheme', () => {
      expect(validateRedirect('javascript:alert(1)')).toBeNull();
    });

    it('blocks data: scheme', () => {
      expect(validateRedirect('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('blocks vbscript: scheme', () => {
      expect(validateRedirect('vbscript:msgbox(1)')).toBeNull();
    });

    it('blocks file: scheme', () => {
      expect(validateRedirect('file:///etc/passwd')).toBeNull();
    });

    it('blocks protocol-relative URLs', () => {
      expect(validateRedirect('//evil.com')).toBeNull();
    });

    it('blocks path traversal in redirects', () => {
      expect(validateRedirect('/../etc/passwd')).toBeNull();
    });

    it('blocks external URLs without allowlist', () => {
      expect(validateRedirect('https://evil.com')).toBeNull();
    });

    it('allows external URLs in allowlist', () => {
      expect(validateRedirect('https://trusted.com', { allowedHosts: ['trusted.com'] })).toBe('https://trusted.com');
    });

    it('allows same-origin absolute URLs', () => {
      expect(validateRedirect('https://example.com/page', {
        allowSameOrigin: true,
        origin: 'https://example.com',
      })).toBe('https://example.com/page');
    });

    it('blocks empty input', () => {
      expect(validateRedirect('')).toBeNull();
    });

    it('blocks non-string input', () => {
      expect(validateRedirect(null as any)).toBeNull();
    });
  });

  describe('safeRedirect', () => {
    it('returns a Response with redirect when valid', () => {
      const response = safeRedirect('/dashboard');
      expect(response.status).toBe(307);
      expect(response.headers.get('Location')).toBe('/dashboard');
    });

    it('returns 400 when URL is dangerous', () => {
      const response = safeRedirect('javascript:alert(1)');
      expect(response.status).toBe(400);
    });

    it('returns 400 when URL is null', () => {
      const response = safeRedirect(null as any);
      expect(response.status).toBe(400);
    });

    it('supports custom status code', () => {
      const response = safeRedirect('/dashboard', 302);
      expect(response.status).toBe(302);
    });
  });
});
