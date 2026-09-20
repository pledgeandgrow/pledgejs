import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { CookieJar, signCookieValue, verifyCookieValue } from './server-utils';

describe('CookieJar secure defaults', () => {
  it('defaults to HttpOnly + SameSite=Lax', () => {
    const jar = new CookieJar({});
    jar.set('a', 'b');
    const c = jar.get('a')!;
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });

  it('adds Secure when the request context defaults say so', () => {
    const jar = new CookieJar({}, { secure: true });
    jar.set('a', 'b');
    expect(jar.get('a')).toContain('Secure');
  });

  it('omits Secure on plain-HTTP dev requests', () => {
    const jar = new CookieJar({}, { secure: false });
    jar.set('a', 'b');
    expect(jar.get('a')).not.toContain('Secure');
  });

  it('supports explicit opt-out of HttpOnly', () => {
    const jar = new CookieJar({}, { secure: true });
    jar.set('a', 'b', { httpOnly: false, secure: false });
    const c = jar.get('a')!;
    expect(c).not.toContain('HttpOnly');
    expect(c).not.toContain('Secure');
  });

  it('serializes standard attributes and escapes the value', () => {
    const jar = new CookieJar({});
    jar.set('a', 'hello world; x', {
      maxAge: 60,
      expires: new Date('2030-01-01T00:00:00Z'),
      path: '/app',
      domain: 'example.com',
      sameSite: 'strict',
    });
    const c = jar.get('a')!;
    expect(c).toContain('a=hello%20world%3B%20x');
    expect(c).toContain('Max-Age=60');
    expect(c).toContain('Expires=Tue, 01 Jan 2030 00:00:00 GMT');
    expect(c).toContain('Path=/app');
    expect(c).toContain('Domain=example.com');
    expect(c).toContain('SameSite=Strict');
  });
});

describe('setSession (__Host- enforcement)', () => {
  it('enforces Secure, Path=/, no Domain, HttpOnly and adds the prefix', () => {
    const jar = new CookieJar({});
    jar.setSession('sess', 'token-value');
    const c = jar.get('__Host-sess')!;
    expect(c).toBeDefined();
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toContain('Domain=');
  });

  it('does not double-prefix a __Host- name', () => {
    const jar = new CookieJar({});
    jar.setSession('__Host-sess', 'v');
    expect(jar.get('__Host-sess')).toBeDefined();
    expect(jar.get('__Host-__Host-sess')).toBeUndefined();
  });

  it('rejects a Domain attribute', () => {
    const jar = new CookieJar({});
    expect(() => jar.setSession('sess', 'v', { domain: 'example.com' })).toThrow(/Domain/);
  });
});

describe('cookie name/value hygiene', () => {
  it('rejects names containing CR/LF or separators', () => {
    const jar = new CookieJar({});
    expect(() => jar.set('bad\r\nname', 'v')).toThrow(/Invalid cookie name/);
    expect(() => jar.set('with space', 'v')).toThrow(/Invalid cookie name/);
    expect(() => jar.set('semi;colon', 'v')).toThrow(/Invalid cookie name/);
  });

  it('rejects a domain containing control characters', () => {
    const jar = new CookieJar({});
    expect(() => jar.set('a', 'b', { domain: 'x.com\r\nInjected: y' })).toThrow(/Invalid cookie domain/);
  });
});

describe('signed cookies', () => {
  it('round-trips a signed value', () => {
    const signed = signCookieValue('user:42', 'sid');
    expect(verifyCookieValue(signed, 'sid')).toBe('user:42');
  });

  it('rejects a tampered value', () => {
    const signed = signCookieValue('user:42', 'sid');
    const tampered = signed.replace('user:42', 'user:43');
    expect(verifyCookieValue(tampered, 'sid')).toBeNull();
  });

  it('rejects a truncated or malformed value', () => {
    expect(verifyCookieValue('user:42', 'sid')).toBeNull();
    expect(verifyCookieValue('v0.user:42.deadbeef', 'sid')).toBeNull();
    expect(verifyCookieValue('', 'sid')).toBeNull();
  });

  it('binds the cookie name into the MAC (no cross-cookie replay)', () => {
    const signed = signCookieValue('admin', 'draft');
    expect(verifyCookieValue(signed, 'draft')).toBe('admin');
    expect(verifyCookieValue(signed, 'role')).toBeNull();
  });

  it('rejects legacy unbound v1 signatures unless PLEDGE_ACCEPT_LEGACY_COOKIES=1', () => {
    process.env.PLEDGE_SECRET = 'test-secret';
    const hex = createHmac('sha256', 'test-secret').update('cookie:user:42').digest('hex');
    const legacy = `v1.user:42.${hex}`;
    try {
      expect(verifyCookieValue(legacy, 'sid')).toBeNull();
      process.env.PLEDGE_ACCEPT_LEGACY_COOKIES = '1';
      expect(verifyCookieValue(legacy, 'sid')).toBe('user:42');
    } finally {
      delete process.env.PLEDGE_ACCEPT_LEGACY_COOKIES;
      delete process.env.PLEDGE_SECRET;
    }
  });

  it('setSigned stores an HttpOnly signed cookie', () => {
    const jar = new CookieJar({});
    jar.setSigned('role', 'admin');
    const stored = jar.get('role')!;
    expect(stored).toContain('HttpOnly');
    const raw = decodeURIComponent(stored.split(';')[0]!.split('=').slice(1).join('='));
    expect(verifyCookieValue(raw, 'role')).toBe('admin');
  });
});

describe('SameSite=None enforcement', () => {
  it('forces Secure when sameSite is none — browsers reject the pair otherwise', () => {
    const jar = new CookieJar({}, { secure: false });
    jar.set('a', 'b', { sameSite: 'none', secure: false });
    const c = jar.get('a')!;
    expect(c).toContain('SameSite=None');
    expect(c).toContain('Secure');
  });

  it('keeps explicit Secure for lax/strict', () => {
    const jar = new CookieJar({}, { secure: false });
    jar.set('a', 'b', { sameSite: 'lax' });
    expect(jar.get('a')).not.toContain('Secure');
  });
});

describe('rotateSession', () => {
  it('issues a fresh __Host- session id and returns it', () => {
    const jar = new CookieJar({});
    const id = jar.rotateSession();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const c = jar.get('__Host-session')!;
    expect(c).toContain(`__Host-session=${id}`);
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
  });

  it('produces a different id each call — fixation requires rotation', () => {
    const jar = new CookieJar({});
    expect(jar.rotateSession()).not.toBe(jar.rotateSession());
  });
});

describe('clearSession', () => {
  it('expires the __Host- cookie and emits Clear-Site-Data', () => {
    const responseHeaders: Record<string, string> = {};
    const jar = new CookieJar({}, {}, () => responseHeaders);
    jar.clearSession();
    const expired = jar.get('__Host-session')!;
    expect(expired).toContain('Max-Age=0');
    expect(responseHeaders['Clear-Site-Data']).toBe('"cookies", "storage"');
  });

  it('does not touch headers when no store is wired', () => {
    const jar = new CookieJar({});
    expect(() => jar.clearSession('other')).not.toThrow();
  });
});
