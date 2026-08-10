import { describe, it, expect } from 'vitest';
import { detectBot } from './safety-net';

describe('Bot Detection (#45)', () => {
  it('detects Googlebot', () => {
    const result = detectBot({
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      method: 'GET',
      path: '/',
    });
    expect(result.isBot).toBe(true);
  });

  it('detects curl as a bot/tool', () => {
    const result = detectBot({
      headers: { 'user-agent': 'curl/7.68.0' },
      method: 'GET',
      path: '/',
    });
    expect(result.isBot).toBe(true);
  });

  it('does not flag regular browsers as bots', () => {
    const result = detectBot({
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
      method: 'GET',
      path: '/',
    });
    expect(result.isBot).toBe(false);
  });

  it('detects headless browsers', () => {
    const result = detectBot({
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/91.0.4472.114 Safari/537.36' },
      method: 'GET',
      path: '/',
    });
    expect(result.isBot).toBe(true);
  });

  it('provides shouldChallenge flag', () => {
    const result = detectBot({
      headers: { 'user-agent': 'Googlebot/2.1' },
      method: 'GET',
      path: '/',
    });
    expect(typeof result.shouldChallenge).toBe('boolean');
  });
});
