/**
 * Pluggable key-value store for security state (lockout counters, TOTP
 * replay guards, brute-force trackers).
 *
 * The default in-memory implementation is process-local — in multi-instance
 * deployments (multiple workers or hosts), each process tracks its own state
 * and effective limits multiply by instance count. For those deployments,
 * provide a shared store implementation backed by Redis, a KV service, or a
 * database. Any async KV API maps trivially onto this interface.
 */
export interface SecurityKeyValueStore {
  /** Get a value by key, or null when absent/expired. */
  get(key: string): Promise<string | null>;
  /** Set a value, optionally expiring after ttlMs. */
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Delete a key. */
  delete(key: string): Promise<void>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * Default in-memory SecurityKeyValueStore. Entries expire lazily on read.
 */
export class InMemorySecurityStore implements SecurityKeyValueStore {
  private entries = new Map<string, MemoryEntry>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * Convenience adapter for building a SecurityKeyValueStore from three async
 * functions — useful for wrapping an existing Redis/KV client inline:
 *
 * ```ts
 * const store = createSecurityStore({
 *   get: (k) => redis.get(k),
 *   set: (k, v, ttl) => redis.set(k, v, 'PX', ttl ?? 60000),
 *   delete: (k) => redis.del(k),
 * });
 * ```
 */
export function createSecurityStore(fns: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}): SecurityKeyValueStore {
  return {
    get: fns.get,
    set: fns.set,
    delete: fns.delete,
  };
}
