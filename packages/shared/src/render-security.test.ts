import { describe, it, expect } from 'vitest';
import {
  generateCspNonce,
  scriptSecurityAttrs,
  applyScriptSecurity,
  escapeJsonForScript,
  findExternalAssetsWithoutIntegrity,
} from './render-security';

describe('generateCspNonce', () => {
  it('produces base64 nonces of 128 bits', () => {
    const nonce = generateCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('is unique per call', () => {
    expect(generateCspNonce()).not.toBe(generateCspNonce());
  });
});

describe('scriptSecurityAttrs', () => {
  it('stamps nonce and integrity', () => {
    const attrs = scriptSecurityAttrs(
      { cspNonce: 'abc123', assetIntegrity: { '/x.js': 'sha384-zzz' } },
      '/x.js',
    );
    expect(attrs).toBe(' nonce="abc123" integrity="sha384-zzz"');
  });

  it('returns empty string without security', () => {
    expect(scriptSecurityAttrs(undefined, '/x.js')).toBe('');
  });
});

describe('applyScriptSecurity', () => {
  const sec = { cspNonce: 'N0NCE', assetIntegrity: { '/__pledge__/client.js': 'sha384-AAA', '/__pledge__/client.css': 'sha384-CSS' } };

  it('stamps nonce on framework JSON bootstrap scripts', () => {
    const out = applyScriptSecurity('<script>window.__PLEDGE_ROUTE__={"path":"/"}</script>', sec);
    expect(out).toBe('<script nonce="N0NCE">window.__PLEDGE_ROUTE__={"path":"/"}</script>');
    const env = applyScriptSecurity('<script>window.__PLEDGE_ENV__ = {"A":"1"};</script>', sec);
    expect(env).toContain('nonce="N0NCE"');
  });

  it('does NOT stamp user/plugin/injected inline scripts', () => {
    for (const html of [
      '<script>window.x=1</script>',
      '<script>alert(document.cookie)</script>',
      '<script>window.__PLEDGE_ROUTE__={"a":1};alert(1)</script>',
      '<script>window.__PLEDGE_ROUTE__=alert(1)</script>',
      '<script type="module">import("/evil.js")</script>',
    ]) {
      expect(applyScriptSecurity(html, sec)).toBe(html);
    }
  });

  it('does NOT stamp third-party or unregistered script srcs', () => {
    for (const html of [
      '<script src="https://evil.example/x.js"></script>',
      '<script src="/uploads/x.js"></script>',
    ]) {
      expect(applyScriptSecurity(html, sec)).toBe(html);
    }
  });

  it('stamps nonce + integrity on module scripts with src', () => {
    const out = applyScriptSecurity('<script type="module" src="/__pledge__/client.js"></script>', sec);
    expect(out).toContain('nonce="N0NCE"');
    expect(out).toContain('integrity="sha384-AAA"');
  });

  it('leaves JSON data blocks untouched', () => {
    const html = '<script id="m" type="application/json">{"a":1}</script>';
    expect(applyScriptSecurity(html, sec)).toBe(html);
  });

  it('leaves ld+json blocks untouched', () => {
    const html = '<script type="application/ld+json">{"@type":"x"}</script>';
    expect(applyScriptSecurity(html, sec)).toBe(html);
  });

  it('does not double-stamp an existing nonce', () => {
    const html = '<script nonce="existing">x()</script>';
    expect(applyScriptSecurity(html, sec)).toBe(html);
  });

  it('stamps integrity on framework stylesheet links', () => {
    const out = applyScriptSecurity('<link rel="stylesheet" href="/__pledge__/client.css" />', sec);
    expect(out).toContain('integrity="sha384-CSS"');
  });

  it('leaves unknown links alone', () => {
    const html = '<link rel="icon" href="/favicon.ico" />';
    expect(applyScriptSecurity(html, sec)).toBe(html);
  });

  it('is a no-op without security context', () => {
    const html = '<script>x()</script>';
    expect(applyScriptSecurity(html, undefined)).toBe(html);
    expect(applyScriptSecurity(html, {})).toBe(html);
  });
});

describe('escapeJsonForScript', () => {
  it('prevents </script> breakout', () => {
    const json = JSON.stringify({ x: '</script><script>alert(1)</script>' });
    const escaped = escapeJsonForScript(json);
    expect(escaped).not.toContain('</script>');
    expect(escaped).not.toContain('<script>');
    // Still valid JSON that parses to the original value
    expect(JSON.parse(escaped)).toEqual({ x: '</script><script>alert(1)</script>' });
  });
});

describe('findExternalAssetsWithoutIntegrity', () => {
  it('flags cross-origin scripts and links without integrity', () => {
    const html = [
      '<script src="https://cdn.example.com/lib.js"></script>',
      '<link rel="stylesheet" href="https://fonts.example.com/x.css" />',
    ].join('');
    expect(findExternalAssetsWithoutIntegrity(html)).toEqual([
      'https://cdn.example.com/lib.js',
      'https://fonts.example.com/x.css',
    ]);
  });

  it('ignores same-origin and integrity-bearing assets', () => {
    const html = [
      '<script src="/__pledge__/client.js"></script>',
      '<script src="https://cdn.example.com/lib.js" integrity="sha384-x"></script>',
      '<link href="https://cdn.example.com/x.css" integrity="sha384-y" />',
    ].join('');
    expect(findExternalAssetsWithoutIntegrity(html)).toEqual([]);
  });
});
