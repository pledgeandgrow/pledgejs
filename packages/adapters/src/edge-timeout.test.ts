import { describe, it, expect } from 'vitest';
import { withEdgeTimeout } from './edge-security';

describe('withEdgeTimeout', () => {
  it('returns 504 when the handler rejects with AbortError on abort (race)', async () => {
    const handler = withEdgeTimeout(
      (req) => new Promise<Response>((_, reject) => {
        // Reacts synchronously to the abort, like fetch(req.signal) does.
        req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
      { timeoutMs: 20 },
    );
    const res = await handler(new Request('http://x/'));
    expect(res.status).toBe(504);
  });

  it('returns 504 for a slow handler and no unhandled rejection later', async () => {
    const handler = withEdgeTimeout(
      () => new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('late')), 60)),
      { timeoutMs: 10 },
    );
    const res = await handler(new Request('http://x/'));
    expect(res.status).toBe(504);
    await new Promise((r) => setTimeout(r, 100));
  });

  it('passes through a fast response and real errors', async () => {
    const ok = withEdgeTimeout(async () => new Response('ok'), { timeoutMs: 50 });
    expect((await ok(new Request('http://x/'))).status).toBe(200);
    const bad = withEdgeTimeout(async () => { throw new Error('boom'); }, { timeoutMs: 50 });
    await expect(bad(new Request('http://x/'))).rejects.toThrow('boom');
  });
});
