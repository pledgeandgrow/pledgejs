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
