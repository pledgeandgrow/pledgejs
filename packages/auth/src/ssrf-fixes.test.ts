import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSafeUrl, createSafeFetch } from './ssrf';

describe('isSafeUrl address classification', () => {
  it('blocks the unspecified address (routes to localhost on Linux)', async () => {
    expect((await isSafeUrl('http://0.0.0.0/')).safe).toBe(false);
    expect((await isSafeUrl('http://[::]/')).safe).toBe(false);
  });
  it('blocks IPv4-mapped IPv6 loopback/private literals', async () => {
    expect((await isSafeUrl('http://[::ffff:127.0.0.1]/')).safe).toBe(false);
    expect((await isSafeUrl('http://[::ffff:10.0.0.1]/')).safe).toBe(false);
    expect((await isSafeUrl('http://[::ffff:169.254.169.254]/')).safe).toBe(false);
  });
  it('blocks IPv6 loopback but honours allowLoopback for bracketed literals', async () => {
    expect((await isSafeUrl('http://[::1]/')).safe).toBe(false);
    expect((await isSafeUrl('http://[::1]/', { allowLoopback: true })).safe).toBe(true);
  });
  it('blocks CGNAT / shared address space', async () => {
    expect((await isSafeUrl('http://100.64.0.1/')).safe).toBe(false);
  });
});

describe('createSafeFetch responses', () => {
  it('handles bodiless status codes (204) without throwing', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const f = createSafeFetch({ allowLoopback: true });
      const res = await f(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(204);
    } finally {
      server.close();
    }
  });

  it('does not forward Authorization across origins on redirect', async () => {
    let seen: string | undefined = 'unset';
    const target = createServer((req, res) => {
      seen = req.headers.authorization;
      res.end('ok');
    });
    await new Promise<void>((r) => target.listen(0, '0.0.0.0', r));
    const tport = (target.address() as AddressInfo).port;
    const origin = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.2:${tport}/`);
      res.end();
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    try {
      const oport = (origin.address() as AddressInfo).port;
      const f = createSafeFetch({ allowLoopback: true });
      const res = await f(`http://127.0.0.1:${oport}/`, { headers: { Authorization: 'Bearer secret' } });
      expect(await res.text()).toBe('ok');
      expect(seen).toBeUndefined();
    } finally {
      origin.close();
      target.close();
    }
  });
});
