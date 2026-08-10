import { describe, it, expect } from 'vitest';
import { generateETag, isETagMatch, handleETag } from './etag';

describe('ETag (#10)', () => {
  it('generates a weak ETag from a string body', () => {
    const etag = generateETag('hello world');
    expect(etag).toMatch(/^W\/".*"$/);
  });

  it('generates different ETags for different content', () => {
    const etag1 = generateETag('content1');
    const etag2 = generateETag('content2');
    expect(etag1).not.toBe(etag2);
  });

  it('generates same ETag for same content', () => {
    const etag1 = generateETag('same content');
    const etag2 = generateETag('same content');
    expect(etag1).toBe(etag2);
  });

  it('matches If-None-Match header', () => {
    const etag = generateETag('test content');
    expect(isETagMatch(etag, etag)).toBe(true);
  });

  it('does not match different ETag', () => {
    const etag1 = generateETag('content1');
    const etag2 = generateETag('content2');
    expect(isETagMatch(etag1, etag2)).toBe(false);
  });

  it('handles comma-separated If-None-Match', () => {
    const etag = generateETag('test');
    expect(isETagMatch(`${etag}, "other-etag"`, etag)).toBe(true);
  });

  it('handles undefined If-None-Match', () => {
    const etag = generateETag('test');
    expect(isETagMatch(undefined, etag)).toBe(false);
  });

  it('handleETag returns 304 when ETag matches', () => {
    const body = 'test body';
    const etag = generateETag(body);
    const result = handleETag(body, {}, etag);
    expect(result.status).toBe(304);
    expect(result.headers.ETag).toBe(etag);
  });

  it('handleETag returns 200 with ETag when no match', () => {
    const body = 'test body';
    const result = handleETag(body, {}, 'different-etag');
    expect(result.status).toBe(200);
    expect(result.headers.ETag).toBeDefined();
    expect(result.body).toBe(body);
  });
});
