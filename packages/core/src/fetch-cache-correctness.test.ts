import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cachedFetch, clearCache } from './fetch-cache';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('cachedFetch correctness', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => clearCache());
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

  it('does not serve one user\'s authenticated response to another user', async () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      return json({ owner: auth });
    }) as typeof fetch;
    const next = { revalidate: 60 };
    const a = await (await cachedFetch('https://api.example.com/me', { headers: { Authorization: 'Bearer alice' }, next })).json();
    const b = await (await cachedFetch('https://api.example.com/me', { headers: { Authorization: 'Bearer bob' }, next })).json();
    expect(a).toEqual({ owner: 'Bearer alice' });
    expect(b).toEqual({ owner: 'Bearer bob' });
  });

  it('does not cache non-OK responses and preserves their status', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? json({ error: 'boom' }, 500) : json({ ok: true });
    }) as typeof fetch;
    const next = { revalidate: 60 };
    const first = await cachedFetch('https://api.example.com/x', { next });
    expect(first.status).toBe(500);
    const second = await cachedFetch('https://api.example.com/x', { next });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });

  it('keeps stale data when the background refresh returns an error response', async () => {
    vi.useFakeTimers();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? json({ v: 1 }) : json({ error: 'down' }, 503);
    }) as typeof fetch;
    const next = { revalidate: 1 };
    await cachedFetch('https://api.example.com/y', { next });
    await vi.advanceTimersByTimeAsync(2000);
    await cachedFetch('https://api.example.com/y', { next }); // stale, triggers bg refresh (503)
    await vi.advanceTimersByTimeAsync(10);
    const res = await cachedFetch('https://api.example.com/y', { next });
    expect(await res.json()).toEqual({ v: 1 });
  });
});
