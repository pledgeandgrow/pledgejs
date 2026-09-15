import type { PledgePlugin, PluginServerContext } from 'pledgestack-shared';
import { wsCompress, wsDecompress, isNativeWsCompressionAvailable } from 'pledgestack-core';

/**
 * Compresses a WebSocket message using native permessage-deflate.
 * Uses rust-ws-compression NAPI addon when available, falls back to Node zlib.
 */
export function compressMessage(data: Buffer, level?: number): Buffer {
  return wsCompress(data, level);
}

/**
 * Decompresses a WebSocket message.
 */
export function decompressMessage(data: Buffer): Buffer {
  return wsDecompress(data);
}

/**
 * Whether native WebSocket compression is available.
 */
export function hasNativeWsCompression(): boolean {
  return isNativeWsCompressionAvailable();
}

/**
 * WebSocket support for PledgeStack.
 *
 * PledgePack already runs a WebSocket server for HMR. This package provides
 * the framework-level WebSocket route handling that piggybacks on PledgePack's
 * dev server WebSocket and provides a production WebSocket server for `pledgestack start`.
 *
 * Usage in app/ws/chat/route.ts:
 * ```typescript
 * import { defineWebSocketRoute } from 'pledgestack-ws';
 *
 * export default defineWebSocketRoute({
 *   onOpen(ws) {
 *     ws.send('Welcome!');
 *   },
 *   onMessage(ws, data) {
 *     ws.broadcast(data);
 *   },
 *   onClose(ws) {
 *     console.log('Client disconnected');
 *   },
 * });
 * ```
 */

export interface WebSocketRoute {
  onOpen?: (ws: PledgeWebSocket) => void;
  onMessage?: (ws: PledgeWebSocket, data: WebSocketMessage) => void;
  onClose?: (ws: PledgeWebSocket, code: number, reason: string) => void;
  onError?: (ws: PledgeWebSocket, error: Error) => void;
}

export interface WebSocketMessage {
  type: 'text' | 'binary';
  data: string | ArrayBuffer;
}

export interface PledgeWebSocket {
  /** Unique connection ID */
  id: string;
  /** Send a text message to this client */
  send(data: string): void;
  /** Send a binary message to this client */
  sendBinary(data: ArrayBuffer): void;
  /** Close this connection */
  close(code?: number, reason?: string): void;
  /** Broadcast to all connected clients in the same route */
  broadcast(data: string, excludeSelf?: boolean): void;
  /** Broadcast binary to all connected clients in the same route */
  broadcastBinary(data: ArrayBuffer, excludeSelf?: boolean): void;
  /** Subscribe to a topic/channel */
  subscribe(topic: string): void;
  /** Unsubscribe from a topic/channel */
  unsubscribe(topic: string): void;
  /** Publish to a topic/channel */
  publish(topic: string, data: string): void;
  /** Connection metadata */
  meta: {
    url: URL;
    headers: Record<string, string>;
    query: Record<string, string>;
  };
}

/**
 * Define a WebSocket route handler.
 *
 * In the app directory, place this in a `route.ts` file under a `ws/` directory.
 * PledgeStack detects the ws/ prefix and registers it as a WebSocket route.
 */
export function defineWebSocketRoute(handler: WebSocketRoute): WebSocketRoute {
  return handler;
}

/**
 * WebSocket plugin — registers WebSocket route handling with PledgePack's dev server.
 *
 * PledgePack already has a WebSocket server for HMR. This plugin adds a
 * middleware that upgrades requests to `/ws/*` paths to WebSocket connections
 * and routes them to the appropriate handler.
 */
export function websocketPlugin(): PledgePlugin {
  return {
    name: 'pledgestack-ws',

    configureServer(_server: PluginServerContext) {
      // PledgePack's dev server WebSocket handles HMR on a separate path.
      // This plugin registers a handler for /ws/* paths for app WebSocket routes.
      // The actual WebSocket upgrade is handled by pledgepack's httpServer.
    },
  };
}

/**
 * WebSocket room manager — manages connected clients per route.
 * Used by the production server for `pledgestack start`.
 */
export class WSRoom {
  private clients: Map<string, PledgeWebSocket> = new Map();
  private topics: Map<string, Set<string>> = new Map();
  /** Maximum concurrent clients per room. Prevents a single room from
   * accumulating unbounded connections (and unbounded broadcast cost). */
  private maxClients: number;
  /** Maximum subscribers per topic. Bounds the per-topic fan-out. */
  private maxTopicSize: number;

  constructor(options?: { maxClients?: number; maxTopicSize?: number }) {
    this.maxClients = options?.maxClients ?? 10_000;
    this.maxTopicSize = options?.maxTopicSize ?? 10_000;
  }

  addClient(ws: PledgeWebSocket): boolean {
    if (this.clients.size >= this.maxClients && !this.clients.has(ws.id)) {
      // Room is full — reject so the caller can close the connection with a
      // policy-violation code rather than silently exceeding the cap.
      return false;
    }
    this.clients.set(ws.id, ws);
    return true;
  }

  removeClient(ws: PledgeWebSocket): void {
    this.clients.delete(ws.id);
    for (const [topic, subscribers] of this.topics) {
      subscribers.delete(ws.id);
      // Delete empty topics so the topics map doesn't accumulate dead entries
      // over the lifetime of a long-running room.
      if (subscribers.size === 0) this.topics.delete(topic);
    }
  }

  broadcast(data: string, excludeId?: string): void {
    for (const [id, ws] of this.clients) {
      if (id !== excludeId) {
        // Isolate per-client send errors so one bad socket doesn't abort the
        // whole broadcast loop and leave remaining clients unnotified.
        try {
          ws.send(data);
        } catch {
          // A send failure (e.g. socket already closing) is logged at most by
          // the socket impl; the broadcast continues to other clients.
        }
      }
    }
  }

  broadcastBinary(data: ArrayBuffer, excludeId?: string): void {
    for (const [id, ws] of this.clients) {
      if (id !== excludeId) {
        try {
          ws.sendBinary(data);
        } catch {
          // Isolate per-client send errors — see broadcast().
        }
      }
    }
  }

  subscribe(clientId: string, topic: string): boolean {
    let subscribers = this.topics.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.topics.set(topic, subscribers);
    }
    if (subscribers.size >= this.maxTopicSize && !subscribers.has(clientId)) {
      return false;
    }
    subscribers.add(clientId);
    return true;
  }

  unsubscribe(clientId: string, topic: string): void {
    const subscribers = this.topics.get(topic);
    if (!subscribers) return;
    subscribers.delete(clientId);
    if (subscribers.size === 0) this.topics.delete(topic);
  }

  publish(topic: string, data: string, excludeId?: string): void {
    const subscribers = this.topics.get(topic);
    if (!subscribers) return;
    for (const id of subscribers) {
      if (id !== excludeId) {
        const ws = this.clients.get(id);
        if (ws) {
          try {
            ws.send(data);
          } catch {
            // Isolate per-subscriber send errors.
          }
        }
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getTopicCount(): number {
    return this.topics.size;
  }
}

/**
 * Generate a unique WebSocket connection ID.
 */
export function generateConnectionId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export { createAuthenticatedWSRoute, extractWSToken, getWSUserId, RateLimiter, type WSAuthConfig, type AuthenticatedConnection } from './auth';
