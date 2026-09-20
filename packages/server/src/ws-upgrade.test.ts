import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createWsUpgradeHandler, WS_MISSING_MESSAGE, type WsUpgradeOptions } from './ws-upgrade';
import { createAuthenticatedWSRoute } from '../../ws/src/auth';

let server: Server | undefined;

async function start(opts: Partial<WsUpgradeOptions> & Pick<WsUpgradeOptions, 'routes'>): Promise<number> {
  const upgrade = createWsUpgradeHandler(opts);
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => { void upgrade(req, socket, head); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Resolves with the HTTP status of a rejected upgrade (or the close reason). */
function expectRejected(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = new WebSocket(url, { headers });
    c.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); c.terminate(); });
    c.on('open', () => reject(new Error('upgrade should have been rejected')));
    c.on('error', () => { /* socket destroyed */ });
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => { server!.closeAllConnections?.(); server!.close(() => r()); });
  server = undefined;
  vi.restoreAllMocks();
});

describe('Node WebSocket upgrade (real ws client, real http server)', () => {
  it('upgrades and round-trips messages on a registered /ws/ route', async () => {
    const port = await start({
      routes: { '/ws/echo': { onMessage: (ws, m) => ws.send(`echo:${m.data as string}`) } },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/ws/echo?x=1`);
      c.on('open', () => c.send('hi'));
      c.on('message', (d) => { resolve(d.toString()); c.close(); });
      c.on('error', reject);
    });
    expect(reply).toBe('echo:hi');
  });

  it('createAuthenticatedWSRoute: valid bearer token is accepted, bad one closed with 4001', async () => {
    const route = createAuthenticatedWSRoute(
      { onOpen: (ws) => ws.send('welcome') },
      { authenticate: (h) => (h['authorization'] === 'Bearer good' ? 'u1' : null) },
    );
    const port = await start({ routes: { '/ws/priv': route } });

    const ok = await new Promise<string>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/ws/priv`, { headers: { Authorization: 'Bearer good' } });
      c.on('message', (d) => { resolve(d.toString()); c.close(); });
      c.on('error', reject);
    });
    expect(ok).toBe('welcome');

    const code = await new Promise<number>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/ws/priv`, { headers: { Authorization: 'Bearer bad' } });
      c.on('close', (cd) => resolve(cd));
      c.on('error', reject);
    });
    expect(code).toBe(4001);
  });

  it('pre-upgrade authenticate failure -> 401 and socket destroyed (no upgrade)', async () => {
    const onOpen = vi.fn();
    const port = await start({
      routes: { '/ws/priv': { onOpen } },
      authenticate: (h) => (h['authorization'] === 'Bearer good' ? 'u1' : null),
    });
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/priv`)).toBe(401);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('throwing authenticate fails closed with 401', async () => {
    const port = await start({
      routes: { '/ws/priv': {} },
      authenticate: () => { throw new Error('boom'); },
    });
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/priv`)).toBe(401);
  });

  it('cross-origin upgrade -> 403; same-origin and allow-listed origins pass', async () => {
    const port = await start({
      routes: { '/ws/echo': { onOpen: (ws) => ws.send('ok') } },
      allowedOrigins: ['https://trusted.example'],
    });
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/echo`, { Origin: 'https://evil.example' })).toBe(403);
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/echo`, { Origin: 'not a url' })).toBe(403);

    for (const origin of [`http://127.0.0.1:${port}`, 'https://trusted.example']) {
      const msg = await new Promise<string>((resolve, reject) => {
        const c = new WebSocket(`ws://127.0.0.1:${port}/ws/echo`, { headers: { Origin: origin } });
        c.on('message', (d) => { resolve(d.toString()); c.close(); });
        c.on('error', reject);
      });
      expect(msg).toBe('ok');
    }
  });

  it('unknown /ws/ path -> 404; no routes configured -> 501', async () => {
    const port = await start({ routes: { '/ws/a': {} } });
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/nope`)).toBe(404);
    await new Promise<void>((r) => server!.close(() => r()));
    const port2 = await start({ routes: {} });
    expect(await expectRejected(`ws://127.0.0.1:${port2}/ws/a`)).toBe(501);
  });

  it('missing ws package -> 501 with a clear install error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = await start({
      routes: { '/ws/a': {} },
      loadWs: async () => { throw new Error("Cannot find package 'ws'"); },
    });
    expect(await expectRejected(`ws://127.0.0.1:${port}/ws/a`)).toBe(501);
    expect(err).toHaveBeenCalledWith(WS_MISSING_MESSAGE);
    expect(WS_MISSING_MESSAGE).toMatch(/optional peer dependency 'ws'.*npm install ws/);
  });

  it('broadcast reaches other clients in the same route', async () => {
    const port = await start({
      routes: { '/ws/room': { onMessage: (ws, m) => ws.broadcast(m.data as string, true) } },
    });
    const open = (): Promise<WebSocket> => new Promise((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/ws/room`);
      c.on('open', () => res(c)); c.on('error', rej);
    });
    const [a, b] = await Promise.all([open(), open()]);
    const got = new Promise<string>((r) => b.on('message', (d) => r(d.toString())));
    a.send('yo');
    expect(await got).toBe('yo');
    a.close(); b.close();
  });
});
