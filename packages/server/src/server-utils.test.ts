import { describe, it, expect } from 'vitest';
import type { PledgeRequest } from 'pledgestack-shared';
import { CookieJar, draftMode, setRequestContext, signCookieValue } from './server-utils';

function req(cookies: Record<string, string>): PledgeRequest {
  return {
    url: new URL('http://localhost/'),
    method: 'GET',
    headers: {},
    params: {},
    query: {},
    cookies,
  } as PledgeRequest;
}

describe('CookieJar path validation', () => {
  it('rejects a Path that would inject cookie attributes', () => {
    const jar = new CookieJar({});
    expect(() => jar.set('a', 'b', { path: '/; Domain=evil.com' })).toThrow();
    expect(() => jar.set('a', 'b', { path: '/ok' })).not.toThrow();
  });
});

describe('draftMode', () => {
  it('ignores an unsigned draft cookie', () => {
    setRequestContext(req({ __pledge_draft: 'true' }));
    expect(draftMode().isEnabled).toBe(false);
  });

  it('accepts a signed draft cookie', () => {
    setRequestContext(req({ __pledge_draft: signCookieValue('true', '__pledge_draft') }));
    expect(draftMode().isEnabled).toBe(true);
  });

  it('enable() actually sets a response cookie', () => {
    const r = req({});
    setRequestContext(r);
    draftMode().enable();
    const c = (r as unknown as { _responseCookies?: Record<string, string> })._responseCookies;
    expect(c?.__pledge_draft).toContain('__pledge_draft=');
  });
});
