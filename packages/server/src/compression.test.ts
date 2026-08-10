import { describe, it, expect } from 'vitest';
import { compressResponse } from 'pledgestack-core';

describe('Compression (#47)', () => {
  it('compresses with gzip when accepted', () => {
    const body = 'a'.repeat(1000);
    const { body: compressed, encoding } = compressResponse(body, 'gzip');
    expect(encoding).toBe('gzip');
    expect(compressed.length).toBeLessThan(Buffer.byteLength(body));
  });

  it('compresses with deflate when accepted', () => {
    const body = 'a'.repeat(1000);
    const { body: compressed, encoding } = compressResponse(body, 'deflate');
    expect(encoding).toBe('deflate');
    expect(compressed.length).toBeLessThan(Buffer.byteLength(body));
  });

  it('returns no encoding when none accepted', () => {
    const body = 'test body';
    const { encoding } = compressResponse(body, '');
    expect(encoding).toBeNull();
  });

  it('prefers gzip over deflate', () => {
    const body = 'a'.repeat(1000);
    const { encoding } = compressResponse(body, 'deflate, gzip');
    expect(encoding).toBe('gzip');
  });

  it('returns null encoding for unsupported encodings', () => {
    const body = 'test body';
    const { encoding } = compressResponse(body, 'br');
    expect(encoding).toBeNull();
  });

  it('handles empty accept-encoding', () => {
    const body = 'test';
    const { body: result, encoding } = compressResponse(body, '');
    expect(encoding).toBeNull();
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});
