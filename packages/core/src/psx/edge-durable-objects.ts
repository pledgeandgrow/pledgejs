// @unconsumed — exported but not used in the request path. See REMAINING-ISSUES.md.

/**
 * #273 — Edge Durable Objects.
 *
 * Cloudflare Durable Objects integration for stateful edge compute:
 * real-time collaboration, presence, distributed locks.
 *
 * Provides:
 * - Durable Object class generator
 * - WebSocket connection management
 * - Presence tracking
 * - Distributed lock manager
 * - State synchronization
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DurableObjectConfig {
  /** Name of the Durable Object class */
  className: string;
  /** Whether to enable WebSocket support */
  enableWebsockets?: boolean;
  /** Whether to enable presence tracking */
  enablePresence?: boolean;
  /** Whether to enable distributed locks */
  enableLocks?: boolean;
  /** State sync interval in ms (default: 1000) */
  syncIntervalMs?: number;
  /** Max connections per instance (default: 100) */
  maxConnections?: number;
}

export interface PresenceEntry {
  id: string;
  data: Record<string, unknown>;
  lastSeen: number;
}

export interface DistributedLock {
  key: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface DurableObjectStub {
  id: string;
  className: string;
  fetch(request: Request): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Durable Object Generator
// ---------------------------------------------------------------------------

/**
 * Generates a Cloudflare Durable Object class for stateful edge compute.
 */
export function generateDurableObject(config: DurableObjectConfig): string {
  const lines: string[] = [
    '/**',
    ` * Auto-generated Durable Object: ${config.className}`,
    ' * Do not edit manually — PledgePack regenerates on build.',
    ' */',
    '',
    'export class ' + config.className + ' {',
    '  private state: DurableObjectState;',
    '  private env: Record<string, unknown>;',
    '  private sessions = new Map<string, WebSocket>();',
    '',
    '  constructor(state: DurableObjectState, env: Record<string, unknown>) {',
    '    this.state = state;',
    '    this.env = env;',
    '  }',
    '',
  ];

  if (config.enableWebsockets) {
    lines.push(
      '  async fetch(request: Request): Promise<Response> {',
      '    const upgradeHeader = request.headers.get("Upgrade");',
      '    if (upgradeHeader !== "websocket") {',
      '      return new Response("Expected websocket", { status: 400 });',
      '    }',
      '    const pair = new WebSocketPair();',
      '    const [client, server] = Object.values(pair);',
      '    const sessionId = crypto.randomUUID();',
      '    this.sessions.set(sessionId, server);',
      '    server.accept();',
      '',
      '    server.addEventListener("close", () => {',
      '      this.sessions.delete(sessionId);',
      '    });',
      '',
      '    return new Response(null, { status: 101, webSocket: client });',
      '  }',
      '',
      '  broadcast(message: string, exclude?: string): void {',
      '    for (const [id, ws] of this.sessions) {',
      '      if (id !== exclude) ws.send(message);',
      '    }',
      '  }',
    );
  } else {
    lines.push(
      '  async fetch(request: Request): Promise<Response> {',
      '    return new Response("OK");',
      '  }',
    );
  }

  if (config.enablePresence) {
    lines.push(
      '',
      '  // Presence tracking',
      '  private presence = new Map<string, { data: unknown; lastSeen: number }>();',
      '',
      '  updatePresence(id: string, data: unknown): void {',
      '    this.presence.set(id, { data, lastSeen: Date.now() });',
      '    this.broadcast(JSON.stringify({ type: "presence", id, data }));',
      '  }',
      '',
      '  removePresence(id: string): void {',
      '    this.presence.delete(id);',
      '    this.broadcast(JSON.stringify({ type: "presence-remove", id }));',
      '  }',
      '',
      '  getPresence(): Map<string, unknown> {',
      '    const result = new Map();',
      '    const now = Date.now();',
      '    for (const [id, entry] of this.presence) {',
      '      if (now - entry.lastSeen < 30000) {',
      '        result.set(id, entry.data);',
      '      } else {',
      '        this.presence.delete(id);',
      '      }',
      '    }',
      '    return result;',
      '  }',
    );
  }

  if (config.enableLocks) {
    lines.push(
      '',
      '  // Distributed locks',
      '  private locks = new Map<string, { holder: string; expiresAt: number }>();',
      '',
      '  acquireLock(key: string, holder: string, ttlMs: number = 30000): boolean {',
      '    const existing = this.locks.get(key);',
      '    if (existing && Date.now() < existing.expiresAt) return false;',
      '    this.locks.set(key, { holder, expiresAt: Date.now() + ttlMs });',
      '    return true;',
      '  }',
      '',
      '  releaseLock(key: string, holder: string): boolean {',
      '    const lock = this.locks.get(key);',
      '    if (!lock || lock.holder !== holder) return false;',
      '    this.locks.delete(key);',
      '    return true;',
      '  }',
      '',
      '  renewLock(key: string, holder: string, ttlMs: number = 30000): boolean {',
      '    const lock = this.locks.get(key);',
      '    if (!lock || lock.holder !== holder) return false;',
      '    lock.expiresAt = Date.now() + ttlMs;',
      '    return true;',
      '  }',
    );
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates the wrangler.toml configuration for Durable Objects.
 */
export function generateWranglerConfig(
  objects: Array<{ name: string; className: string; script?: string }>,
): string {
  const bindings = objects.map(o =>
    `  { name = "${o.name}", class_name = "${o.className}"${o.script ? `, script_name = "${o.script}"` : ''} }`,
  ).join(',\n');

  return `# Auto-generated wrangler.toml for Durable Objects
name = "pledge-edge"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[durable_objects_bindings]]
${bindings}

[[migrations]]
tag = "v1"
new_classes = [${objects.map(o => `"${o.className}"`).join(', ')}]
`;
}

// ---------------------------------------------------------------------------
// Client-side Durable Object Manager
// ---------------------------------------------------------------------------

/**
 * Client-side manager for interacting with Durable Objects.
 */
export class DurableObjectManager extends EventEmitter {
  private config: Required<DurableObjectConfig>;
  private presence = new Map<string, PresenceEntry>();
  private locks = new Map<string, DistributedLock>();
  private connections = new Map<string, WebSocket>();

  constructor(config: DurableObjectConfig) {
    super();
    this.config = {
      className: config.className,
      enableWebsockets: config.enableWebsockets ?? true,
      enablePresence: config.enablePresence ?? true,
      enableLocks: config.enableLocks ?? true,
      syncIntervalMs: config.syncIntervalMs ?? 1000,
      maxConnections: config.maxConnections ?? 100,
    };
  }

  /**
   * Connects to a Durable Object via WebSocket.
   */
  connect(id: string, url: string): WebSocket {
    if (this.connections.size >= this.config.maxConnections) {
      throw new Error(`Max connections (${this.config.maxConnections}) reached`);
    }
    const ws = new WebSocket(url);
    this.connections.set(id, ws);

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.emit('message', { id, msg });
      } catch {
        this.emit('raw', { id, data: event.data });
      }
    });

    ws.addEventListener('close', () => {
      this.connections.delete(id);
      this.emit('disconnect', { id });
    });

    return ws;
  }

  /**
   * Updates presence for a user.
   */
  updatePresence(id: string, data: Record<string, unknown>): void {
    this.presence.set(id, { id, data, lastSeen: Date.now() });
    this.emit('presence-update', { id, data });
  }

  /**
   * Removes a user from presence.
   */
  removePresence(id: string): void {
    this.presence.delete(id);
    this.emit('presence-remove', { id });
  }

  /**
   * Gets all presence entries.
   */
  getPresence(): PresenceEntry[] {
    const now = Date.now();
    const entries: PresenceEntry[] = [];
    for (const [id, entry] of this.presence) {
      if (now - entry.lastSeen < 30000) {
        entries.push(entry);
      } else {
        this.presence.delete(id);
      }
    }
    return entries;
  }

  /**
   * Attempts to acquire a distributed lock.
   */
  acquireLock(key: string, holder: string, ttlMs = 30000): boolean {
    const existing = this.locks.get(key);
    if (existing && Date.now() < existing.expiresAt) return false;
    // Clean up expired lock if present
    if (existing) this.locks.delete(key);
    this.locks.set(key, { key, holder, acquiredAt: Date.now(), expiresAt: Date.now() + ttlMs });
    this.emit('lock-acquired', { key, holder });
    return true;
  }

  /**
   * Releases a distributed lock.
   */
  releaseLock(key: string, holder: string): boolean {
    const lock = this.locks.get(key);
    if (!lock || lock.holder !== holder) return false;
    this.locks.delete(key);
    this.emit('lock-released', { key, holder });
    return true;
  }

  /**
   * Renews a distributed lock.
   */
  renewLock(key: string, holder: string, ttlMs = 30000): boolean {
    const lock = this.locks.get(key);
    if (!lock || lock.holder !== holder) return false;
    lock.expiresAt = Date.now() + ttlMs;
    return true;
  }

  /**
   * Gets active locks.
   */
  getLocks(): DistributedLock[] {
    const now = Date.now();
    const active: DistributedLock[] = [];
    for (const [key, lock] of this.locks) {
      if (now < lock.expiresAt) {
        active.push(lock);
      } else {
        this.locks.delete(key);
      }
    }
    return active;
  }

  /**
   * Disconnects all connections.
   */
  disconnect(): void {
    for (const [, ws] of this.connections) {
      ws.close();
    }
    this.connections.clear();
    this.presence.clear();
    this.locks.clear();
  }
}
