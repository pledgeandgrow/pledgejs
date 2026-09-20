import { describe, it, expect } from 'vitest';
import type { PledgeRequest } from 'pledgestack-shared';
import { defineApiRoute } from './route';
import {
  sanitizeMongoQuery,
  hasDangerousOperators,
  stripOperators,
  sanitizeProjection,
} from './nosql-injection';

const ok = () => ({ status: 200, headers: {}, body: 'ok' });
const reqFrom = (ip: string) => ({ ip, headers: {} }) as unknown as PledgeRequest;

describe('api rate-limit buckets are bounded', () => {
  it('evicts old keys instead of growing without limit under a distinct-key flood', async () => {
    const handler = defineApiRoute(ok, { rateLimit: { windowMs: 3_600_000, max: 1 } });
    // Far more distinct live keys than the hard cap (10_000).
    for (let i = 0; i < 12_000; i++) await handler(reqFrom(`10.0.${i >> 8}.${i & 255}-${i}`));
    // The very first key was evicted, so it starts a fresh bucket (200, not 429)...
    expect((await handler(reqFrom('10.0.0.0-0'))).status).toBe(200);
    // ...while a recent key is still tracked and gets limited.
    expect((await handler(reqFrom(`10.0.${11_999 >> 8}.${11_999 & 255}-11999`))).status).toBe(429);
  });

  it('still rate limits a normal client', async () => {
    const handler = defineApiRoute(ok, { rateLimit: { windowMs: 60_000, max: 2 } });
    const r = reqFrom('1.1.1.1');
    expect((await handler(r)).status).toBe(200);
    expect((await handler(r)).status).toBe(200);
    expect((await handler(r)).status).toBe(429);
  });
});

describe('nosql sanitizer prototype-pollution keys', () => {
  const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"name":"a","nested":{"constructor":{"x":1},"ok":2}}');

  it('strips __proto__/constructor/prototype and does not alter the result prototype', () => {
    const out = sanitizeMongoQuery(polluted) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as any).isAdmin).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['name', 'nested']);
    expect(out.nested).toEqual({ ok: 2 });
  });

  it('strips them even when nested under operators', () => {
    const out = sanitizeMongoQuery(JSON.parse('{"$and":{"prototype":1,"a":1}}'), { allowedOperators: ['$and'] });
    expect(out).toEqual({ $and: { a: 1 } });
  });

  it('flags them via hasDangerousOperators', () => {
    expect(hasDangerousOperators(polluted)).toBe(true);
    expect(hasDangerousOperators({ a: 1 })).toBe(false);
  });

  it('stripOperators and sanitizeProjection drop them too', () => {
    expect(Object.keys(stripOperators(polluted))).toEqual(['name', 'nested']);
    expect(sanitizeProjection(JSON.parse('{"__proto__":1,"constructor":1,"a":1}'))).toEqual({ a: 1 });
  });
});
