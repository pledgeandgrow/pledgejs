import { describe, it, expect } from 'vitest';
import { isBlockedDotPath } from './node';

describe('isBlockedDotPath — dotfile static-serving protection', () => {
  it('blocks dotfiles in public/', () => {
    expect(isBlockedDotPath('/.env')).toBe(true);
    expect(isBlockedDotPath('/.git/config')).toBe(true);
    expect(isBlockedDotPath('/.htaccess')).toBe(true);
    expect(isBlockedDotPath('/assets/.DS_Store')).toBe(true);
    expect(isBlockedDotPath('/dir/.npmrc')).toBe(true);
  });

  it('allows /.well-known/ paths (security.txt, ACME)', () => {
    expect(isBlockedDotPath('/.well-known/security.txt')).toBe(false);
    expect(isBlockedDotPath('/.well-known/acme-challenge/token')).toBe(false);
  });

  it('does not allow near-misses of .well-known', () => {
    expect(isBlockedDotPath('/.well-known-evil/x')).toBe(true);
    expect(isBlockedDotPath('/.wellknown/security.txt')).toBe(true);
  });

  it('allows ordinary paths', () => {
    expect(isBlockedDotPath('/assets/app.js')).toBe(false);
    expect(isBlockedDotPath('/images/logo.svg')).toBe(false);
    expect(isBlockedDotPath('/index.html')).toBe(false);
  });
});

import { parseCookies } from './handler';
describe('parseCookies', () => {
  it('does not throw on malformed percent-escapes', () => {
    expect(parseCookies({ cookie: 'a=%; b=ok%20x' })).toEqual({ a: '%', b: 'ok x' });
  });
  it('ignores __proto__ cookie names', () => {
    const c = parseCookies({ cookie: '__proto__=evil; x=1' });
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(c.x).toBe('1');
  });
});
