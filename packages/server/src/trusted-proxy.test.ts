import { describe, it, expect } from 'vitest';
import {
  isPrivateOrLoopback,
  isTrustedProxyAddress,
  isRemoteTrusted,
  resolveClientIdentifier,
} from './trusted-proxy';

describe('isPrivateOrLoopback', () => {
  it('recognizes loopback and private ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1']) {
      expect(isPrivateOrLoopback(ip)).toBe(true);
    }
  });

  it('rejects public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.9', '172.15.0.1', '172.32.0.1', '192.167.0.1']) {
      expect(isPrivateOrLoopback(ip)).toBe(false);
    }
  });

  it('rejects garbage', () => {
    expect(isPrivateOrLoopback(undefined)).toBe(false);
    expect(isPrivateOrLoopback('not-an-ip')).toBe(false);
    expect(isPrivateOrLoopback('999.1.1.1')).toBe(false);
  });
});

describe('isTrustedProxyAddress', () => {
  it('matches exact IPs and IPv4-mapped IPv6', () => {
    expect(isTrustedProxyAddress('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isTrustedProxyAddress('::ffff:203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isTrustedProxyAddress('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(isTrustedProxyAddress('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isTrustedProxyAddress('10.1.2.3', ['10.1.2.0/24'])).toBe(true);
    expect(isTrustedProxyAddress('10.1.3.3', ['10.1.2.0/24'])).toBe(false);
    expect(isTrustedProxyAddress('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
  });
});

describe('isRemoteTrusted', () => {
  it('trusts private peers by default', () => {
    expect(isRemoteTrusted('127.0.0.1')).toBe(true);
    expect(isRemoteTrusted('10.0.0.2')).toBe(true);
  });

  it('distrusts public peers by default', () => {
    expect(isRemoteTrusted('8.8.8.8')).toBe(false);
  });

  it('uses the allowlist when configured', () => {
    expect(isRemoteTrusted('8.8.8.8', ['8.8.8.8'])).toBe(true);
    // An allowlist replaces the private-IP default — a private peer NOT on
    // the list is no longer trusted.
    expect(isRemoteTrusted('10.0.0.2', ['8.8.8.8'])).toBe(false);
  });
});

describe('resolveClientIdentifier', () => {
  it('ignores spoofed forwarding headers from an untrusted peer', () => {
    const id = resolveClientIdentifier(
      { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' },
      '8.8.8.8',
    );
    expect(id).toBe('8.8.8.8');
  });

  it('honors forwarding headers from a trusted peer', () => {
    const id = resolveClientIdentifier(
      { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
      '127.0.0.1',
    );
    expect(id).toBe('1.2.3.4');
  });

  it('honors forwarding headers when the peer is on the allowlist', () => {
    const id = resolveClientIdentifier(
      { 'x-forwarded-for': '1.2.3.4' },
      '8.8.8.8',
      ['8.8.8.0/24'],
    );
    expect(id).toBe('1.2.3.4');
  });

  it('uses headers when no socket address exists (edge runtime)', () => {
    const id = resolveClientIdentifier({ 'x-forwarded-for': '1.2.3.4' });
    expect(id).toBe('1.2.3.4');
  });

  it('falls back to remote address then unknown', () => {
    expect(resolveClientIdentifier({}, '9.9.9.9')).toBe('9.9.9.9');
    expect(resolveClientIdentifier({})).toBe('unknown');
  });
});

describe('spoofed XFF prefix / mapped IPv6', () => {
  it('ignores a client-supplied leftmost XFF entry behind a trusted proxy', () => {
    const id = resolveClientIdentifier({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '127.0.0.1');
    expect(id).toBe('203.0.113.9');
  });
  it('matches IPv4 CIDR against an IPv4-mapped IPv6 peer', () => {
    expect(isTrustedProxyAddress('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });
});
