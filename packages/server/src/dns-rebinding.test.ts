import { describe, it, expect } from 'vitest';
import { validateHost } from './dns-rebinding';

describe('DNS Rebinding Protection (#15)', () => {
  it('allows localhost', () => {
    expect(validateHost('localhost:3000')).toBe(true);
  });

  it('allows 127.0.0.1', () => {
    expect(validateHost('127.0.0.1:3000')).toBe(true);
  });

  it('blocks unknown hosts by default', () => {
    expect(validateHost('evil.com:3000')).toBe(false);
  });

  it('blocks missing host header', () => {
    expect(validateHost(undefined)).toBe(false);
  });

  it('allows custom allowed hosts', () => {
    expect(validateHost('myapp.dev:3000', { allowedHosts: ['myapp.dev'] })).toBe(true);
  });

  it('allows all when blockDisallowed is false', () => {
    expect(validateHost('evil.com:3000', { blockDisallowed: false })).toBe(true);
  });
});
