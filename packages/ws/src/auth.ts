import type { PledgeWebSocket, WebSocketRoute } from './index';

/**
 * WebSocket authentication utilities.
 *
 * Provides:
 * - Authentication of WebSocket upgrade requests
 * - Rejection of unauthenticated connections
 * - Per-connection rate limiting
 */

export interface WSAuthConfig {
  /** Authentication function — returns user ID or null */
  authenticate: (headers: Record<string, string>, query: Record<string, string>) => string | null | Promise<string | null>;
  /** Rate limit: max messages per second per connection (default: 10) */
  rateLimitPerSecond?: number;
  /** Rate limit: burst size (default: 20) */
  rateLimitBurst?: number;
  /** Close code for auth failure (default: 4001) */
  authFailureCode?: number;
  /** Close reason for auth failure */
  authFailureReason?: string;
  /** Maximum accepted message size in bytes (default: 1 MiB). Oversized
   * messages close the connection with 4003 — a single huge frame otherwise
   * allocates fully regardless of the per-second rate limit. */
  maxMessageBytes?: number;
}

const DEFAULT_RATE_LIMIT = 10;
const DEFAULT_BURST = 20;
const AUTH_FAILURE_CODE = 4001;
const AUTH_FAILURE_REASON = 'Authentication required';

/**
 * Authenticated WebSocket connection metadata.
 */
export interface AuthenticatedConnection {
  userId: string;
  ws: PledgeWebSocket;
  rateLimiter: RateLimiter;
}

/**
 * Token bucket rate limiter for per-connection message throttling.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(maxTokens: number, refillPerSecond: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillPerSecond;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

/**
 * Create an authenticated WebSocket route handler.
 *
 * Wraps a WebSocketRoute with authentication and rate limiting.
 * Unauthenticated connections are immediately closed.
 *
 * Usage:
 * ```typescript
 * import { createAuthenticatedWSRoute } from 'pledgestack/ws';
 *
 * export default createAuthenticatedWSRoute(
 *   { onOpen, onMessage, onClose },
 *   { authenticate: (headers) => verifyToken(headers.authorization) }
 * );
 * ```
 */
export function createAuthenticatedWSRoute(
  handler: WebSocketRoute,
  config: WSAuthConfig,
): WebSocketRoute {
  const rateLimitPerSecond = config.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT;
  const rateLimitBurst = config.rateLimitBurst ?? DEFAULT_BURST;
  const authFailureCode = config.authFailureCode ?? AUTH_FAILURE_CODE;
  const authFailureReason = config.authFailureReason ?? AUTH_FAILURE_REASON;
  const maxMessageBytes = config.maxMessageBytes ?? 1024 * 1024;

  const connections = new Map<string, AuthenticatedConnection>();

  return {
    async onOpen(ws: PledgeWebSocket) {
      let userId: string | null = null;
      try {
        userId = await config.authenticate(ws.meta.headers, ws.meta.query);
      } catch {
        // A throwing/rejecting authenticator must fail closed, not surface as
        // an unhandled rejection with the socket left open.
        userId = null;
      }
      if (!userId) {
        ws.close(authFailureCode, authFailureReason);
        return;
      }

      const rateLimiter = new RateLimiter(rateLimitBurst, rateLimitPerSecond);
      connections.set(ws.id, { userId, ws, rateLimiter });
      // Associate the socket with its user id so getWSUserId(ws) works — the
      // `connections` map is private to this closure and was never exposed.
      wsUserIds.set(ws, userId);

      handler.onOpen?.(ws);
    },

    onMessage(ws: PledgeWebSocket, data) {
      const conn = connections.get(ws.id);
      if (!conn) {
        ws.close(authFailureCode, 'Connection not authenticated');
        return;
      }

      if (!conn.rateLimiter.tryConsume()) {
        ws.close(4002, 'Rate limit exceeded');
        return;
      }

      // Size cap — the token bucket limits message frequency, not size; a
      // single oversized frame would otherwise allocate fully on receipt.
      const size = typeof data.data === 'string' ? utf8ByteLength(data.data) : data.data.byteLength;
      if (size > maxMessageBytes) {
        ws.close(4003, 'Message too large');
        return;
      }

      handler.onMessage?.(ws, data);
    },

    onClose(ws: PledgeWebSocket, code: number, reason: string) {
      connections.delete(ws.id);
      wsUserIds.delete(ws);
      handler.onClose?.(ws, code, reason);
    },

    onError(ws: PledgeWebSocket, error: Error) {
      connections.delete(ws.id);
      wsUserIds.delete(ws);
      handler.onError?.(ws, error);
    },
  };
}

function utf8ByteLength(s: string): number {
  // UTF-16 length undercounts multi-byte characters by up to 3x.
  return new TextEncoder().encode(s).byteLength;
}

/** Associates each authenticated socket with its user id (see getWSUserId). */
const wsUserIds = new WeakMap<PledgeWebSocket, string>();

/**
 * Extract authentication token from WebSocket upgrade request.
 * Accepts tokens from the Authorization header (Bearer) or the `Sec-WebSocket-Protocol`
 * subprotocol (e.g. `bearer.<token>`). Query-parameter tokens are intentionally
 * NOT accepted — they leak into server logs, browser history, and `Referer`
 * headers (#44). The `_query` parameter is kept in the signature for API
 * compatibility with existing callers but is intentionally unused.
 */
export function extractWSToken(headers: Record<string, string>, _query: Record<string, string>): string | null {
  const authHeader = headers['authorization'] ?? headers['Authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Subprotocol: clients can negotiate `Sec-WebSocket-Protocol: bearer.<token>`.
  // This is the WebSocket-standard way to pass credentials without exposing
  // them in URLs. The `query` parameter is accepted for API compatibility but
  // intentionally ignored.
  const subprotocol = headers['sec-websocket-protocol'];
  if (subprotocol) {
    // The header is a comma-separated list of offered protocols.
    for (const part of subprotocol.split(',')) {
      const p = part.trim();
      if (p.startsWith('bearer.') && p.length > 7) return p.slice(7);
    }
  }

  return null;
}

/**
 * Get the authenticated user ID for a WebSocket connection.
 *
 * Reads the association established when the socket authenticated. An optional
 * `connections` map (as held internally by createAuthenticatedWSRoute) may be
 * passed to look up there instead.
 */
export function getWSUserId(ws: PledgeWebSocket, connections?: Map<string, AuthenticatedConnection>): string | null {
  if (connections) return connections.get(ws.id)?.userId ?? null;
  return wsUserIds.get(ws) ?? null;
}
