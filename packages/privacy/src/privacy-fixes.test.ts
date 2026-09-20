import { describe, it, expect } from 'vitest';
import type { PledgeRequest } from 'pledgestack-shared';
import { ConsentManager } from './consent';

function reqWithCookie(name: string, value: string): PledgeRequest {
  return { cookies: { [name]: value } } as unknown as PledgeRequest;
}

describe('ConsentManager signed cookie', () => {
  const secret = 'test-secret-key';
  const mgr = new ConsentManager({ secret });

  it('round-trips a signed consent cookie', () => {
    const state = mgr.createConsentState({ analytics: true });
    const cookie = mgr.consentCookie(state);
    // Extract the cookie value (before the first ';').
    const value = cookie.split(';')[0].split('=').slice(1).join('=');
    const read = mgr.getConsent(reqWithCookie('__pledge_consent', value));
    expect(read).not.toBeNull();
    expect(read!.records.find((r) => r.category === 'analytics')?.granted).toBe(true);
  });

  it('rejects a forged cookie (no valid signature)', () => {
    const forged = encodeURIComponent(JSON.stringify({
      version: '1',
      updatedAt: Date.now(),
      records: [{ category: 'marketing', granted: true, timestamp: Date.now(), version: '1' }],
    }));
    // No signature appended → rejected.
    expect(mgr.getConsent(reqWithCookie('__pledge_consent', forged))).toBeNull();
    // Wrong signature → rejected.
    expect(mgr.getConsent(reqWithCookie('__pledge_consent', `${forged}.deadbeef`))).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const other = new ConsentManager({ secret: 'different' });
    const state = other.createConsentState({ marketing: true });
    const value = other.consentCookie(state).split(';')[0].split('=').slice(1).join('=');
    expect(mgr.getConsent(reqWithCookie('__pledge_consent', value))).toBeNull();
  });
});

import { PIIRedactor } from './pii';

describe('PIIRedactor.redactObject robustness', () => {
  const r = new PIIRedactor();
  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(() => r.redactObject(a)).not.toThrow();
  });
  it('preserves Date values', () => {
    const d = new Date('2020-01-01T00:00:00Z');
    expect((r.redactObject({ when: d }) as { when: Date }).when).toBe(d);
  });
  it('redacts sensitive keys case-insensitively', () => {
    const out = r.redactObject({ apikey: 'abc', APIKEY: 'd', accesstoken: 'e' }) as Record<string, string>;
    expect(out).toEqual({ apikey: '[REDACTED]', APIKEY: '[REDACTED]', accesstoken: '[REDACTED]' });
  });
});

describe('ConsentManager cookie round-trip', () => {
  it('verifies a signed cookie after the server percent-decodes the value', () => {
    const m = new ConsentManager({ secret: 's3cret-s3cret' });
    const setCookie = m.consentCookie(m.createConsentState({ analytics: true }));
    const raw = setCookie.split(';')[0].slice(m['cookieName'].length + 1);
    const decoded = decodeURIComponent(raw); // what parseCookies hands over
    const req = { cookies: { [m['cookieName']]: decoded } } as unknown as PledgeRequest;
    expect(m.hasConsent(req, 'analytics')).toBe(true);
  });
  it('rejects malformed state without throwing', () => {
    const m = new ConsentManager();
    const req = { cookies: { [m['cookieName']]: encodeURIComponent('{"version":"1"}') } } as unknown as PledgeRequest;
    expect(m.hasConsent(req, 'analytics')).toBe(false);
  });
});

import { resolvePrivacyConfig } from './config';
import { GDPRManager } from './gdpr';

describe('privacy config / gdpr hardening', () => {
  it('keeps defaults when an option is explicitly undefined', () => {
    expect(resolvePrivacyConfig({ requireConsent: undefined }).requireConsent).toBe(true);
  });
  it('sanitizes the export filename and reports failed sources', async () => {
    const g = new GDPRManager();
    g.registerCollector({ name: 'bad', canDelete: true, export: async () => { throw new Error('x'); }, delete: async () => 0 });
    const res = await g.exportResponse('a"b' + String.fromCharCode(13, 10) + 'X: y');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="user-data-a_b__X__y.json"');
    expect(JSON.parse(res.body as string).failedSources).toEqual(['bad']);
  });
});
