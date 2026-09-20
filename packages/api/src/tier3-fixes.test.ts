import { describe, it, expect } from 'vitest';
import type { PledgeRequest } from 'pledgestack-shared';
import { binary } from './response-typing';
import { defineApiRoute } from './route';
import { CronScheduler } from './cron';

describe('binary() response (#binary)', () => {
  it('base64-encodes an ArrayBuffer and flags isBase64', () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
    const res = binary(bytes.buffer, 'image/png');
    expect(res.isBase64).toBe(true);
    expect(res.body).toBe(Buffer.from(bytes).toString('base64'));
    // The old code produced "137,80,78,71" — make sure that never happens.
    expect(res.body).not.toContain(',');
  });

  it('passes a string body through unchanged', () => {
    const res = binary('hello', 'text/plain');
    expect(res.body).toBe('hello');
    expect(res.isBase64).toBeUndefined();
  });
});

describe('defineApiRoute options (#defineApiRoute)', () => {
  const req = { headers: {} } as unknown as PledgeRequest;

  it('runs middleware and short-circuits on the first response', async () => {
    const handler = defineApiRoute(
      () => ({ status: 200, headers: {}, body: 'handler' }),
      { middleware: [() => ({ status: 401, headers: {}, body: 'blocked' })] },
    );
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(res.body).toBe('blocked');
  });

  it('enforces the rate limit', async () => {
    const handler = defineApiRoute(
      () => ({ status: 200, headers: {}, body: 'ok' }),
      { rateLimit: { windowMs: 60000, max: 2 } },
    );
    expect((await handler(req)).status).toBe(200);
    expect((await handler(req)).status).toBe(200);
    expect((await handler(req)).status).toBe(429);
  });

  it('keys rate limits on req.ip, not spoofable X-Forwarded-For', async () => {
    const handler = defineApiRoute(
      () => ({ status: 200, headers: {}, body: 'ok' }),
      { rateLimit: { windowMs: 60000, max: 1 } },
    );
    // Same trusted proxy-resolved IP, rotating spoofed XFF — an attacker
    // rotating XFF must NOT bypass the limit.
    const spoof = (xff: string): PledgeRequest =>
      ({ headers: { 'x-forwarded-for': xff }, ip: '203.0.113.7' }) as unknown as PledgeRequest;
    expect((await handler(spoof('1.1.1.1'))).status).toBe(200);
    expect((await handler(spoof('2.2.2.2'))).status).toBe(429);
    expect((await handler(spoof('3.3.3.3'))).status).toBe(429);
  });

  it('returns the handler unchanged when no options are given', () => {
    const h = () => ({ status: 200, headers: {}, body: 'x' });
    expect(defineApiRoute(h)).toBe(h);
  });
});

describe('CronScheduler standard cron (#cron)', () => {
  it('accepts a standard 5-field cron expression without throwing', () => {
    const sched = new CronScheduler({ autoStart: false });
    expect(() => sched.register({ name: 'daily', schedule: '0 2 * * *', handler: async () => {} })).not.toThrow();
    sched.stopAll();
  });

  it('still accepts the every-N-unit shorthand', () => {
    const sched = new CronScheduler({ autoStart: false });
    expect(() => sched.register({ name: 'freq', schedule: 'every-5-minutes', handler: async () => {} })).not.toThrow();
    sched.stopAll();
  });

  it('rejects a truly invalid schedule', () => {
    const sched = new CronScheduler({ autoStart: true });
    expect(() => sched.register({ name: 'bad', schedule: 'not-a-schedule', handler: async () => {} })).toThrow();
  });
});
