import { describe, it, expect } from 'vitest';
import { createAuthenticatedWSRoute } from './auth';
import type { PledgeWebSocket, WebSocketMessage } from './index';

function fakeWs(id = 'ws1'): PledgeWebSocket & { closed: { code?: number; reason?: string } } {
  const state = { closed: {} as { code?: number; reason?: string } };
  return Object.assign(state, {
    id,
    send: () => {},
    sendBinary: () => {},
    close(code?: number, reason?: string) {
      state.closed = { code, reason };
    },
    broadcast: () => {},
    broadcastBinary: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    publish: () => {},
    meta: { url: new URL('ws://localhost/ws/x'), headers: {}, query: {} },
  }) as PledgeWebSocket & { closed: { code?: number; reason?: string } };
}

async function authenticatedWs(
  options?: Parameters<typeof createAuthenticatedWSRoute>[1],
) {
  const route = createAuthenticatedWSRoute({}, {
    authenticate: () => 'user-1',
    ...options,
  });
  const ws = fakeWs();
  await route.onOpen?.(ws);
  return { route, ws };
}

describe('createAuthenticatedWSRoute', () => {
  it('closes unauthenticated connections', async () => {
    const route = createAuthenticatedWSRoute({}, { authenticate: () => null });
    const ws = fakeWs();
    await route.onOpen?.(ws);
    expect(ws.closed.code).toBe(4001);
  });

  it('drops messages exceeding maxMessageBytes', async () => {
    const { route, ws } = await authenticatedWs({ maxMessageBytes: 8 });
    const big: WebSocketMessage = { type: 'text', data: 'x'.repeat(64) };
    route.onMessage?.(ws, big);
    expect(ws.closed.code).toBe(4003);
  });

  it('passes messages within the cap to the handler', async () => {
    let received = 0;
    const route = createAuthenticatedWSRoute(
      { onMessage: () => { received++; } },
      { authenticate: () => 'user-1', maxMessageBytes: 16 },
    );
    const ws = fakeWs();
    await route.onOpen?.(ws);
    route.onMessage?.(ws, { type: 'text', data: 'ok' });
    expect(received).toBe(1);
    expect(ws.closed.code).toBeUndefined();
  });

  it('applies the default 1 MiB cap to binary frames', async () => {
    const { route, ws } = await authenticatedWs();
    const big: WebSocketMessage = { type: 'binary', data: new ArrayBuffer(1024 * 1024 + 1) };
    route.onMessage?.(ws, big);
    expect(ws.closed.code).toBe(4003);
  });
});

describe('auth hardening', () => {
  it('fails closed when authenticate throws', async () => {
    const route = createAuthenticatedWSRoute({}, { authenticate: () => { throw new Error('boom'); } });
    const ws = fakeWs();
    await route.onOpen?.(ws);
    expect(ws.closed.code).toBe(4001);
  });

  it('measures string size in UTF-8 bytes', async () => {
    const { route, ws } = await authenticatedWs({ maxMessageBytes: 8 });
    route.onMessage?.(ws, { type: 'text', data: '€€€' });
    expect(ws.closed.code).toBe(4003);
  });

  it('extracts bearer token from a multi-protocol header', async () => {
    const { extractWSToken } = await import('./auth');
    expect(extractWSToken({ 'sec-websocket-protocol': 'chat, bearer.abc123' }, {})).toBe('abc123');
  });
});
