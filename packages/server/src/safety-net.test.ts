import { describe, it, expect, beforeEach } from 'vitest';
import { detectBot, checkBruteForce, recordFailedAttempt } from './safety-net';

describe('detectBot', () => {
  it('detects Googlebot', () => {
    const result = detectBot({ userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    expect(result.isBot).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects curl', () => {
    const result = detectBot({ userAgent: 'curl/8.0.1' });
    expect(result.isBot).toBe(true);
  });

  it('detects headless Chrome', () => {
    const result = detectBot({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome' });
    expect(result.isBot).toBe(true);
  });

  it('does not flag regular browsers', () => {
    const result = detectBot({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
    expect(result.isBot).toBe(false);
  });

  it('handles missing User-Agent (empty UA is suspicious)', () => {
    const result = detectBot({ userAgent: '' });
    // Empty UA is treated as a bot signal
    expect(result.isBot).toBe(true);
  });

  it('detects Python requests', () => {
    const result = detectBot({ userAgent: 'python-requests/2.31.0' });
    expect(result.isBot).toBe(true);
  });
});

describe('checkBruteForce', () => {
  const testId = 'test-user-' + Date.now();

  it('allows first attempt', () => {
    const result = checkBruteForce(testId);
    expect(result.allowed).toBe(true);
    expect(result.lockedOut).toBe(false);
    expect(result.requiresCaptcha).toBe(false);
  });

  it('blocks after max attempts', () => {
    const id = 'brute-test-' + Date.now();
    // Record multiple failed attempts
    for (let i = 0; i < 10; i++) {
      recordFailedAttempt(id);
    }
    const result = checkBruteForce(id, { maxAttempts: 5 });
    expect(result.allowed).toBe(false);
    expect(result.lockedOut).toBe(true);
  });

  it('requires captcha after threshold', () => {
    const id = 'captcha-test-' + Date.now();
    for (let i = 0; i < 3; i++) {
      recordFailedAttempt(id);
    }
    const result = checkBruteForce(id, { maxAttempts: 10, captchaThreshold: 3 });
    expect(result.requiresCaptcha).toBe(true);
  });

  it('respects custom config', () => {
    const id = 'custom-test-' + Date.now() + '-' + Math.random();
    // Record 3 failed attempts with maxAttempts=2 — should be locked out
    recordFailedAttempt(id, { maxAttempts: 2 });
    recordFailedAttempt(id, { maxAttempts: 2 });
    const result = checkBruteForce(id, { maxAttempts: 2 });
    expect(result.allowed).toBe(false);
    expect(result.lockedOut).toBe(true);
  });
});
