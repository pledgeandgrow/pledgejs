import { describe, it, expect, afterEach } from 'vitest';
import { getPublicEnv, getPublicEnvScript } from './env';

describe('getPublicEnvScript', () => {
  afterEach(() => {
    delete process.env.PLEDGE_PUBLIC_TEST_BREAKOUT;
  });

  it('escapes </script> so a public env value cannot break out', () => {
    process.env.PLEDGE_PUBLIC_TEST_BREAKOUT = '</script><script>alert(1)</script>';
    const html = getPublicEnvScript();
    // The literal </script> terminator inside the value must be escaped.
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c/script>');
    // Still one script open + one close tag overall
    expect((html.match(/<script/g) ?? [])).toHaveLength(1);
    expect((html.match(/<\/script>/g) ?? [])).toHaveLength(1);
    // And the decoded payload parses back to the original value
    const json = html.slice(html.indexOf('=') + 1, html.lastIndexOf(';')).trim();
    expect(JSON.parse(json)).toEqual(getPublicEnv());
  });

  it('stamps a CSP nonce on the script tag', () => {
    const html = getPublicEnvScript('nonce-xyz');
    expect(html).toContain('nonce="nonce-xyz"');
  });

  it('only exposes PLEDGE_PUBLIC_ vars with the prefix stripped', () => {
    process.env.PLEDGE_PUBLIC_TEST_BREAKOUT = 'visible';
    process.env.PLEDGE_SECRET_NONEXISTENT_TEST = 'hidden';
    const env = getPublicEnv();
    expect(env.TEST_BREAKOUT).toBe('visible');
    expect(env.SECRET_NONEXISTENT_TEST).toBeUndefined();
    delete process.env.PLEDGE_SECRET_NONEXISTENT_TEST;
  });
});
