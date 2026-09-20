import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';

/**
 * Production WebSocket upgrade handling for the Node server.
 *
 * `ws` is an OPTIONAL peer dependency, loaded lazily on the first accepted
 * upgrade so apps that don't use WebSockets never need it installed.
 *
 * Route handlers are structurally compatible with `pledgestack-ws`'s
 * `WebSocketRoute` (including `createAuthenticatedWSRoute` output); the types
 * are redeclared here to avoid a package dependency cycle.
 */

export interface WsSocketLike {
  id: string;
  send(data: string): void;
  sendBinary(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  broadcast(data: string, excludeSelf?: boolean): void;
  broadcastBinary(data: ArrayBuffer, excludeSelf?: boolean): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: string): void;
  meta: { url: URL; headers: Record<string, string>; query: Record<string, string> };
}

export interface WsRouteHandler {
  onOpen?: (ws: WsSocketLike) => void | Promise<void>;
  onMessage?: (ws: WsSocketLike, data: { type: 'text' | 'binary'; data: string | ArrayBuffer }) => void;
  onClose?: (ws: WsSocketLike, code: number, reason: string) => void;
  onError?: (ws: WsSocketLike, error: Error) => void;
}

export interface WsUpgradeOptions {
  /** Routes keyed by exact pathname, e.g. `/ws/chat`. */
  routes: Record<string, WsRouteHandler>;
  /** Origins allowed in addition to same-host (config.cors.origins). */
  allowedOrigins?: string[];
  /**
   * Optional pre-upgrade authentication. Return a non-empty user id to accept;
   * null/empty (or a throw) rejects the upgrade with 401 before any WebSocket
   * is created. Route-level auth (createAuthenticatedWSRoute) still applies.
   */
  authenticate?: (headers: Record<string, string>, query: Record<string, string>) => string | null | Promise<string | null>;
  /** Max inbound message size in bytes (default 1 MiB). */
  maxPayloadBytes?: number;
  /** Override the `ws` loader (used by tests to simulate a missing package). */
  loadWs?: () => Promise<unknown>;
}

export const WS_MISSING_MESSAGE =
  "[pledgestack] WebSocket routes require the optional peer dependency 'ws'. Install it with: npm install ws";

interface WsModuleShape {
  WebSocketServer: new (opts: { noServer: true; maxPayload?: number }) => {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: RawWs) => void): void;
  };
}
interface RawWs {
  readyState: number;
  send(data: string | ArrayBuffer | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* socket already gone */ }
  socket.destroy();
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Returns false (and rejects 403) when the Origin is not permitted. */
function checkOrigin(req: IncomingMessage, socket: Duplex, allowed: string[]): boolean {
  const origin = req.headers['origin'];
  if (!origin) return true; // non-browser client
  try {
    const originUrl = new URL(origin);
    const host = req.headers['host'];
    const corsAllowed = allowed.includes('*') || allowed.includes(origin);
    if (host && originUrl.host !== host && !corsAllowed) {
      reject(socket, 403, 'Forbidden');
      return false;
    }
    return true;
  } catch {
    reject(socket, 403, 'Forbidden');
    return false;
  }
}

export function createWsUpgradeHandler(options: WsUpgradeOptions) {
  const { routes, allowedOrigins = [], authenticate, maxPayloadBytes = 1024 * 1024 } = options;
  const loader = options.loadWs ?? (() => import('ws' as string));
  let serverPromise: Promise<InstanceType<WsModuleShape['WebSocketServer']>> | null = null;
  const rooms = new Map<string, Map<string, WsSocketLike>>();
  const topics = new Map<string, Map<string, Set<string>>>();

  const getServer = () => {
    if (!serverPromise) {
      serverPromise = (async () => {
        let mod: unknown;
        try {
          mod = await loader();
        } catch {
          throw new Error(WS_MISSING_MESSAGE);
        }
        const m = mod as Partial<WsModuleShape> & { default?: Partial<WsModuleShape> };
        const Ctor = m.WebSocketServer ?? m.default?.WebSocketServer;
        if (!Ctor) throw new Error(WS_MISSING_MESSAGE);
        return new Ctor({ noServer: true, maxPayload: maxPayloadBytes });
      })();
      // Allow retry after a failed load (e.g. package installed later).
      serverPromise.catch(() => { serverPromise = null; });
    }
    return serverPromise;
  };

  return async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      if (!checkOrigin(req, socket, allowedOrigins)) return;

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const route = routes[url.pathname];
      if (!route) {
        reject(socket, Object.keys(routes).length === 0 ? 501 : 404,
          Object.keys(routes).length === 0 ? 'Not Implemented' : 'Not Found');
        return;
      }

      const headers = flattenHeaders(req);
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { query[k] = v; });

      let wss;
      try {
        wss = await getServer();
      } catch (err) {
        console.error((err as Error).message);
        reject(socket, 501, 'Not Implemented');
        return;
      }

      if (authenticate) {
        let userId: string | null = null;
        try { userId = await authenticate(headers, query); } catch { userId = null; }
        if (!userId) {
          reject(socket, 401, 'Unauthorized');
          return;
        }
      }

      const path = url.pathname;
      wss.handleUpgrade(req, socket, head, (raw) => {
        const id = `ws_${randomUUID()}`;
        let room = rooms.get(path);
        if (!room) { room = new Map(); rooms.set(path, room); }
        let roomTopics = topics.get(path);
        if (!roomTopics) { roomTopics = new Map(); topics.set(path, roomTopics); }
        const r = room;
        const rt = roomTopics;

        const toBuf = (d: ArrayBuffer): Buffer => Buffer.from(d);
        const safeSend = (target: WsSocketLike, data: string | ArrayBuffer) => {
          try {
            if (typeof data === 'string') target.send(data); else target.sendBinary(data);
          } catch { /* isolate per-client failure */ }
        };

        const pws: WsSocketLike = {
          id,
          send: (d) => { if (raw.readyState === 1) raw.send(d); },
          sendBinary: (d) => { if (raw.readyState === 1) raw.send(toBuf(d)); },
          close: (code, reason) => { try { raw.close(code, reason); } catch { /* already closed */ } },
          broadcast: (d, excludeSelf) => { for (const [cid, c] of r) if (!(excludeSelf && cid === id)) safeSend(c, d); },
          broadcastBinary: (d, excludeSelf) => { for (const [cid, c] of r) if (!(excludeSelf && cid === id)) safeSend(c, d); },
          subscribe: (t) => { let s = rt.get(t); if (!s) { s = new Set(); rt.set(t, s); } s.add(id); },
          unsubscribe: (t) => { const s = rt.get(t); if (s) { s.delete(id); if (s.size === 0) rt.delete(t); } },
          publish: (t, d) => { const s = rt.get(t); if (!s) return; for (const cid of s) { const c = r.get(cid); if (c) safeSend(c, d); } },
          meta: { url, headers, query },
        };
        r.set(id, pws);

        const fail = (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          try { route.onError?.(pws, e); } catch { /* handler error must not crash the server */ }
        };

        // Serialize message handling behind onOpen so async auth completes
        // before the first message is evaluated.
        let opened: Promise<void>;
        try { opened = Promise.resolve(route.onOpen?.(pws)).catch(fail); } catch (e) { fail(e); opened = Promise.resolve(); }

        raw.on('message', (data, isBinary) => {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const msg = isBinary
            ? { type: 'binary' as const, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }
            : { type: 'text' as const, data: buf.toString('utf8') };
          void opened.then(() => { try { route.onMessage?.(pws, msg); } catch (e) { fail(e); } });
        });
        raw.on('close', (code, reason) => {
          r.delete(id);
          for (const [t, s] of rt) { s.delete(id); if (s.size === 0) rt.delete(t); }
          if (r.size === 0) { rooms.delete(path); topics.delete(path); }
          try { route.onClose?.(pws, code, reason.toString('utf8')); } catch { /* ignore */ }
        });
        raw.on('error', fail);
      });
    } catch (err) {
      console.error('[pledgestack] WebSocket upgrade error:', err);
      reject(socket, 500, 'Internal Server Error');
    }
  };
}
