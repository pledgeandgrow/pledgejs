import { describe, it, expect } from 'vitest';
import { sha256Hex, hmacSha256Hex, timingSafeEqualStr } from './crypto';

describe('sha256Hex', () => {
  it('matches the well-known "abc" vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('handles the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('handles keys longer than the 64-byte block size', () => {
    const longKey = 'k'.repeat(100);
    const sig = hmacSha256Hex(longKey, 'msg');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).not.toBe(hmacSha256Hex('other', 'msg'));
  });
});

describe('timingSafeEqualStr', () => {
  it('accepts equal strings and rejects different ones', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});
