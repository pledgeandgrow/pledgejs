/**
 * Persistent fetch cache — survives server restarts.
 *
 * Uses SQLite (via better-sqlite3) as the storage backend for:
 * - Fetch cache entries (URL -> response data, with TTL and tags)
 * - Cache tag index (tag -> set of cache keys)
 *
 * This module is loaded lazily — if better-sqlite3 is not installed,
 * it falls back to in-memory storage.
 *
 * Features:
 * - Stale-while-revalidate: serve stale data immediately, refresh in background
 * - Tag-based invalidation: revalidate all entries with a given tag
 * - Time-based expiry: entries auto-expire after revalidate seconds
 * - Persistence: data survives process restarts
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchCacheOptions } from './fetch-cache';

export interface PersistentCacheConfig {
  /** Path to the SQLite database file (default: .pledge/cache.db) */
  dbPath?: string;
  /** Whether to enable persistence (default: true if better-sqlite3 is available) */
  enabled?: boolean;
}

export interface PersistentCacheEntry {
  key: string;
  data: string;
  status: number;
  headers: Record<string, string>;
  url: string;
  timestamp: number;
  revalidate?: number;
  tags: string[];
}

/** The subset of better-sqlite3's Database that is actually used here. */
interface RawSqliteDatabase {
  prepare: (sql: string) => { get: (...params: any[]) => any; all: (...params: any[]) => any[]; run: (...params: any[]) => { changes: number } };
  close: () => void;
}

/**
 * better-sqlite3 has no Database#run/get/all — those exist only on prepared
 * statements. Casting the raw Database to `DB` made every `dbInstance.run(...)`
 * throw TypeError during init, which the catch block turned into a silent
 * in-memory fallback, so nothing was ever persisted.
 */
function wrapDatabase(raw: RawSqliteDatabase): DB {
  return {
    get: (sql, ...params) => raw.prepare(sql).get(...params),
    all: (sql, ...params) => raw.prepare(sql).all(...params),
    run: (sql, ...params) => raw.prepare(sql).run(...params),
    prepare: (sql) => raw.prepare(sql),
    close: () => raw.close(),
  };
}

interface DB {
  get: (sql: string, ...params: any[]) => any;
  all: (sql: string, ...params: any[]) => any[];
  run: (sql: string, ...params: any[]) => { changes: number };
  prepare: (sql: string) => { get: (...params: any[]) => any; all: (...params: any[]) => any[]; run: (...params: any[]) => { changes: number } };
  close: () => void;
}

let dbInstance: DB | null = null;
let useInMemory = false;

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// In-memory fallback
const memCache = new Map<string, PersistentCacheEntry>();
const memTagIndex = new Map<string, Set<string>>();

/**
 * Initializes the persistent cache database.
 * Creates tables if they don't exist.
 */
export async function initPersistentCache(config: PersistentCacheConfig = {}): Promise<void> {
  if (config.enabled === false) {
    useInMemory = true;
    return;
  }

  const dbPath = config.dbPath ?? '.pledge/cache.db';

  try {
    const Database = (await import('better-sqlite3')).default;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    dbInstance = wrapDatabase(new Database(dbPath) as unknown as RawSqliteDatabase);
    useInMemory = false;

    // Create tables
    dbInstance.run(`
      CREATE TABLE IF NOT EXISTS fetch_cache (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        data TEXT NOT NULL,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        revalidate INTEGER,
        tags TEXT NOT NULL DEFAULT '[]'
      )
    `);

    dbInstance.run(`
      CREATE TABLE IF NOT EXISTS cache_tags (
        tag TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        PRIMARY KEY (tag, cache_key)
      )
    `);

    dbInstance.run(`
      CREATE INDEX IF NOT EXISTS idx_cache_tags_tag ON cache_tags(tag)
    `);

    dbInstance.run(`
      CREATE INDEX IF NOT EXISTS idx_fetch_cache_timestamp ON fetch_cache(timestamp)
    `);
  } catch {
    // better-sqlite3 not available (or the DB could not be opened) — fall back to in-memory
    if (dbInstance) {
      try { dbInstance.close(); } catch { /* ignore */ }
      dbInstance = null;
    }
    useInMemory = true;
  }
}

/**
 * Closes the database connection.
 */
export function closePersistentCache(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Gets a cache entry from persistent storage.
 * Returns null if not found or expired (beyond revalidate window).
 */
export function getPersistentEntry(key: string): PersistentCacheEntry | null {
  if (useInMemory || !dbInstance) {
    const entry = memCache.get(key);
    if (!entry) return null;
    return entry;
  }

  const row = dbInstance.prepare('SELECT * FROM fetch_cache WHERE key = ?').get(key) as any;
  if (!row) return null;

  return {
    key,
    data: row.data,
    status: row.status,
    headers: safeJsonParse(row.headers, {}),
    url: row.url,
    timestamp: row.timestamp,
    revalidate: row.revalidate ?? undefined,
    tags: safeJsonParse(row.tags, []),
  };
}

/**
 * Checks if a cache entry is stale (past its revalidate window).
 * Returns { isStale, entry } — if stale, the entry is still returned
 * for stale-while-revalidate serving.
 */
export function checkStale(key: string): { isStale: boolean; entry: PersistentCacheEntry | null } {
  const entry = getPersistentEntry(key);
  if (!entry) return { isStale: false, entry: null };

  if (entry.revalidate === undefined) {
    return { isStale: false, entry };
  }

  const ageSeconds = (Date.now() - entry.timestamp) / 1000;
  return { isStale: ageSeconds >= entry.revalidate, entry };
}

/**
 * Stores a cache entry in persistent storage.
 */
export function setPersistentEntry(key: string, entry: Omit<PersistentCacheEntry, 'key'>): void {
  const fullEntry: PersistentCacheEntry = { ...entry, key };

  if (useInMemory || !dbInstance) {
    memCache.set(key, fullEntry);
    for (const tag of entry.tags) {
      if (!memTagIndex.has(tag)) memTagIndex.set(tag, new Set());
      memTagIndex.get(tag)!.add(key);
    }
    return;
  }

  dbInstance.run(
    `INSERT OR REPLACE INTO fetch_cache (key, url, data, status, headers, timestamp, revalidate, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    key,
    entry.url,
    entry.data,
    entry.status,
    JSON.stringify(entry.headers),
    entry.timestamp,
    entry.revalidate ?? null,
    JSON.stringify(entry.tags),
  );

  // Update tag index
  dbInstance.run('DELETE FROM cache_tags WHERE cache_key = ?', key);
  for (const tag of entry.tags) {
    dbInstance.run('INSERT OR IGNORE INTO cache_tags (tag, cache_key) VALUES (?, ?)', tag, key);
  }
}

/**
 * Deletes a cache entry by key.
 */
export function deletePersistentEntry(key: string): void {
  if (useInMemory || !dbInstance) {
    const entry = memCache.get(key);
    if (entry) {
      for (const tag of entry.tags) {
        memTagIndex.get(tag)?.delete(key);
      }
      memCache.delete(key);
    }
    return;
  }

  dbInstance.run('DELETE FROM fetch_cache WHERE key = ?', key);
  dbInstance.run('DELETE FROM cache_tags WHERE cache_key = ?', key);
}

/**
 * Revalidates all cache entries associated with a tag.
 * Removes them from both the cache and tag index.
 */
export function revalidatePersistentTag(tag: string): string[] {
  if (useInMemory || !dbInstance) {
    const keys = Array.from(memTagIndex.get(tag) ?? []);
    for (const key of keys) {
      const entry = memCache.get(key);
      if (entry) {
        for (const t of entry.tags) {
          memTagIndex.get(t)?.delete(key);
        }
        memCache.delete(key);
      }
    }
    memTagIndex.delete(tag);
    return keys;
  }

  const rows = dbInstance.prepare('SELECT cache_key FROM cache_tags WHERE tag = ?').all(tag) as { cache_key: string }[];
  const keys = rows.map((r) => r.cache_key);

  for (const key of keys) {
    dbInstance.run('DELETE FROM fetch_cache WHERE key = ?', key);
    // Drop the key's rows under its OTHER tags too, or the tag index keeps dangling entries.
    dbInstance.run('DELETE FROM cache_tags WHERE cache_key = ?', key);
  }
  dbInstance.run('DELETE FROM cache_tags WHERE tag = ?', tag);

  return keys;
}

/**
 * Revalidates cache entries matching a path pattern.
 */
export function revalidatePersistentPath(path: string): string[] {
  if (useInMemory || !dbInstance) {
    const keys: string[] = [];
    for (const [key, entry] of memCache) {
      if (entry.url.includes(path)) {
        keys.push(key);
        for (const tag of entry.tags) {
          memTagIndex.get(tag)?.delete(key);
        }
        memCache.delete(key);
      }
    }
    return keys;
  }

  // instr() = literal substring match, same as the in-memory branch. LIKE would
  // treat '%' and '_' in the path as wildcards.
  const rows = dbInstance.prepare('SELECT key FROM fetch_cache WHERE instr(url, ?) > 0').all(path) as { key: string }[];
  const keys = rows.map((r) => r.key);

  for (const key of keys) {
    dbInstance.run('DELETE FROM fetch_cache WHERE key = ?', key);
    dbInstance.run('DELETE FROM cache_tags WHERE cache_key = ?', key);
  }

  return keys;
}

/**
 * Gets all cache entries (for cache inspector UI).
 */
export function getAllPersistentEntries(): PersistentCacheEntry[] {
  if (useInMemory || !dbInstance) {
    return Array.from(memCache.values());
  }

  const rows = dbInstance.prepare('SELECT * FROM fetch_cache').all() as any[];
  return rows.map((row) => ({
    key: row.key,
    data: row.data,
    status: row.status,
    headers: safeJsonParse(row.headers, {}),
    url: row.url,
    timestamp: row.timestamp,
    revalidate: row.revalidate ?? undefined,
    tags: safeJsonParse(row.tags, []),
  }));
}

/**
 * Gets all tags and their associated key counts.
 */
export function getAllPersistentTags(): Record<string, number> {
  if (useInMemory || !dbInstance) {
    const result: Record<string, number> = {};
    for (const [tag, keys] of memTagIndex) {
      result[tag] = keys.size;
    }
    return result;
  }

  const rows = dbInstance.prepare('SELECT tag, COUNT(*) as count FROM cache_tags GROUP BY tag').all() as { tag: string; count: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.tag] = row.count;
  }
  return result;
}

/**
 * Clears all persistent cache entries.
 */
export function clearPersistentCache(): void {
  if (useInMemory || !dbInstance) {
    memCache.clear();
    memTagIndex.clear();
    return;
  }

  dbInstance.run('DELETE FROM fetch_cache');
  dbInstance.run('DELETE FROM cache_tags');
}

/**
 * Removes expired entries (past their revalidate window with no SWR grace).
 * Called by the background revalidation worker.
 */
export function pruneExpiredEntries(maxAgeSeconds: number = 86400): number {
  const cutoff = Date.now() - maxAgeSeconds * 1000;

  if (useInMemory || !dbInstance) {
    let count = 0;
    for (const [key, entry] of memCache) {
      if (entry.timestamp < cutoff) {
        for (const tag of entry.tags) {
          memTagIndex.get(tag)?.delete(key);
        }
        memCache.delete(key);
        count++;
      }
    }
    return count;
  }

  const result = dbInstance.run('DELETE FROM fetch_cache WHERE timestamp < ?', cutoff);
  dbInstance.run('DELETE FROM cache_tags WHERE cache_key NOT IN (SELECT key FROM fetch_cache)');
  return result.changes;
}

/**
 * Computes a cache key from URL and options.
 */
export function computePersistentCacheKey(url: string, options: RequestInit & { next?: FetchCacheOptions } = {}): string {
  const data = `${url}:${options.method ?? 'GET'}:${JSON.stringify(options.headers ?? {})}`;
  return createHash('sha256').update(data).digest('hex');
}
