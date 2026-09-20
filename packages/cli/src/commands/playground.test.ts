import { describe, it, expect } from 'vitest';
import { isTrustedPlaygroundRequest } from './playground';

describe('isTrustedPlaygroundRequest', () => {
  it('accepts same-origin loopback requests', () => {
    expect(isTrustedPlaygroundRequest({ host: 'localhost:7007' }, 7007)).toBe(true);
    expect(isTrustedPlaygroundRequest({ host: '127.0.0.1:7007', origin: 'http://127.0.0.1:7007' }, 7007)).toBe(true);
  });
  it('rejects cross-site origins (drive-by requests from other web pages)', () => {
    expect(isTrustedPlaygroundRequest({ host: 'localhost:7007', origin: 'https://evil.example' }, 7007)).toBe(false);
  });
  it('rejects non-loopback Host headers (DNS rebinding)', () => {
    expect(isTrustedPlaygroundRequest({ host: 'evil.example:7007' }, 7007)).toBe(false);
    expect(isTrustedPlaygroundRequest({ host: undefined }, 7007)).toBe(false);
  });
});
