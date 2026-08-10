/**
 * Server-side fetch cache — re-exports core fetch-cache primitives and adds
 * server-specific extensions: background revalidation, Response-cloning cache,
 * and force-cache/no-store/isr cache modes.
 *
 * The core implementation (pledgestack-core/src/fetch-cache.ts) provides the
 * base cachedFetch, revalidateTag, revalidatePath, unstable_cache, registerISR,
 * and cookie-variant caching. This module extends it with server-only features
 * that rely on Node.js APIs (node:crypto for cache keys, Response.clone()).
 */

export {
  cachedFetch,
  revalidateTag,
  revalidatePath,
  clearCache,
  getCacheStats,
  unstable_cache,
  registerISR,
  unregisterISR,
  unregisterAllISR,
  cookieCacheKey,
  cachedFetchWithCookies,
  clearCookieVariantCache,
  type FetchCacheOptions,
  type CacheEntry,
} from 'pledgestack-core';

import { createHash } from 'node:crypto';
import { clearCache as clearCoreCache, revalidateTag as coreRevalidateTag, revalidatePath as coreRevalidatePath } from 'pledgestack-core';
import { kvOpen, kvSet, kvGet, kvKeys, isNativeKvStoreAvailable } from 'pledgestack-core';

// --- Server-specific extensions ---

export type FetchCacheOption = 'force-cache' | 'no-store' | 'default' | 'isr';

export interface FetchOptions extends Omit<RequestInit, 'cache'> {
  cache?: FetchCacheOption;
  revalidate?: number;
  tags?: string[];
}

interface ServerCacheEntry {
  response: Response;
  timestamp: number;
  revalidate?: number;
  tags: string[];
}

const serverCache = new Map<string, ServerCacheEntry>();
const serverTagIndex = new Map<string, Set<string>>();

/** Maximum server cache entries before LRU eviction */
const MAX_SERVER_CACHE_ENTRIES = 5000;

function enforceServerMaxEntries(): void {
  if (serverCache.size <= MAX_SERVER_CACHE_ENTRIES) return;
  const toEvict = serverCache.size - MAX_SERVER_CACHE_ENTRIES;
  let count = 0;
  for (const key of serverCache.keys()) {
    if (count >= toEvict) break;
    serverCache.delete(key);
    for (const [tag, keys] of serverTagIndex.entries()) {
      if (keys.has(key)) {
        keys.delete(key);
        if (keys.size === 0) serverTagIndex.delete(tag);
      }
    }
    count++;
  }
}

/**
 * Server-side cached fetch with Response cloning and background revalidation.
 * Supports 'force-cache', 'no-store', 'default', and 'isr' cache modes.
 *
 * For the core cachedFetch (Next.js-style `next:` options), use the re-exported
 * version from pledgestack-core directly.
 */
export async function serverCachedFetch(url: string | URL, options: FetchOptions = {}): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString();
  const cacheMode = options.cache ?? 'default';
  const revalidate = options.revalidate;
  const tags = options.tags ?? [];

  // SSRF protection — validate URL before fetching
  try {
    const { isSafeUrl } = await import('pledgestack-auth');
    const result = await isSafeUrl(urlStr);
    if (!result.safe) {
      throw new Error(`SSRF blocked: ${urlStr} — ${result.reason ?? 'private/internal address'}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) {
      throw err;
    }
    // URL parsing failed — let the actual fetch handle it
  }

  if (cacheMode === 'no-store') {
    return fetch(url, stripPledgeOptions(options));
  }

  const cacheKey = computeCacheKey(urlStr, options);
  const cached = serverCache.get(cacheKey);

  if (cached) {
    const now = Date.now();

    if (cacheMode === 'force-cache') {
      return cached.response.clone();
    }

    if (cached.revalidate !== undefined) {
      const ageSeconds = (now - cached.timestamp) / 1000;
      if (ageSeconds < cached.revalidate) {
        return cached.response.clone();
      }
      revalidateInBackground(cacheKey, urlStr, options, revalidate, tags);
      return cached.response.clone();
    }

    const ageSeconds = (now - cached.timestamp) / 1000;
    if (ageSeconds < 300) {
      return cached.response.clone();
    }
  }

  const response = await fetch(url, stripPledgeOptions(options));
  const entry: ServerCacheEntry = {
    response: response.clone(),
    timestamp: Date.now(),
    revalidate: cacheMode === 'isr' ? revalidate : undefined,
    tags,
  };

  serverCache.set(cacheKey, entry);

  for (const tag of tags) {
    if (!serverTagIndex.has(tag)) serverTagIndex.set(tag, new Set());
    serverTagIndex.get(tag)!.add(cacheKey);
  }

  enforceServerMaxEntries();

  return response.clone();
}

/**
 * Revalidates all server-cached responses associated with a tag.
 * Also delegates to the core cache's revalidateTag.
 */
export function serverRevalidateTag(tag: string): void {
  coreRevalidateTag(tag);
  const keys = serverTagIndex.get(tag);
  if (!keys) return;
  for (const key of keys) {
    serverCache.delete(key);
  }
  serverTagIndex.delete(tag);
}

/**
 * Revalidates server-cached responses for a specific path.
 * Also delegates to the core cache's revalidatePath.
 */
export function serverRevalidatePath(path: string): void {
  coreRevalidatePath(path);
  for (const [key, entry] of serverCache) {
    if (key.includes(path)) {
      serverCache.delete(key);
      for (const tag of entry.tags) {
        serverTagIndex.get(tag)?.delete(key);
      }
    }
  }
}

/**
 * Clears the entire server fetch cache (Response-cloning layer).
 * Also clears the core cache.
 */
export function clearFetchCache(): void {
  serverCache.clear();
  serverTagIndex.clear();
  clearCoreCache();
}

function stripPledgeOptions(options: FetchOptions): RequestInit {
  const { cache: _cache, revalidate: _revalidate, tags: _tags, ...init } = options;
  return init;
}

function computeCacheKey(url: string, options: FetchOptions): string {
  const data = `${url}:${options.method ?? 'GET'}:${JSON.stringify(options.headers ?? {})}`;
  return createHash('sha256').update(data).digest('hex');
}

async function revalidateInBackground(
  cacheKey: string,
  url: string,
  options: FetchOptions,
  revalidate: number | undefined,
  tags: string[],
): Promise<void> {
  try {
    const response = await fetch(url, stripPledgeOptions(options));
    serverCache.set(cacheKey, {
      response: response.clone(),
      timestamp: Date.now(),
      revalidate,
      tags,
    });
    // Persist to KV store if available
    await persistToKV(cacheKey, response.clone());
  } catch {
    // Keep stale data on background fetch failure
  }
}

// --- KV Store Persistence ---

let kvInitialized = false;
const KV_PREFIX = 'fetch-cache:';

/**
 * Initializes the KV store for persistent fetch caching.
 * Call this at server startup to enable crash-safe ISR cache persistence.
 *
 * @param path File path for the KV store (default: .pledge-cache/kv-store.json)
 */
export async function initKvCache(path?: string): Promise<void> {
  if (kvInitialized) return;
  kvInitialized = true;
  await kvOpen(path ?? '.pledge-cache/kv-store.json');
}

/**
 * Persists a cache entry to the KV store.
 */
async function persistToKV(cacheKey: string, response: Response): Promise<void> {
  if (!kvInitialized) return;
  try {
    const body = await response.text();
    const entry = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
      timestamp: Date.now(),
    };
    await kvSet(`${KV_PREFIX}${cacheKey}`, Buffer.from(JSON.stringify(entry), 'utf-8'));
  } catch {
    // KV store not available or write failed — continue with in-memory cache
  }
}

/**
 * Retrieves cached responses from the KV store.
 * Used on server startup to restore cache from disk.
 * Iterates all keys with the fetch-cache: prefix and loads them into serverCache.
 */
export async function restoreFromKV(): Promise<void> {
  if (!kvInitialized) return;

  try {
    const allKeys = await kvKeys();
    const cacheKeys = allKeys.filter((k) => k.startsWith(KV_PREFIX));

    for (const key of cacheKeys) {
      try {
        const buf = await kvGet(key);
        if (!buf) continue;

        const entry = JSON.parse(buf.toString('utf-8')) as {
          url: string;
          status: number;
          headers: Record<string, string>;
          body: string;
          timestamp: number;
          revalidate?: number;
          tags?: string[];
        };

        // Reconstruct Response object from cached data
        const response = new Response(entry.body, {
          status: entry.status,
          headers: entry.headers,
        });

        const cacheKey = key.slice(KV_PREFIX.length);
        const cacheEntry: ServerCacheEntry = {
          response,
          timestamp: entry.timestamp,
          revalidate: entry.revalidate,
          tags: entry.tags ?? [],
        };

        serverCache.set(cacheKey, cacheEntry);

        // Rebuild tag index
        for (const tag of cacheEntry.tags) {
          let tagSet = serverTagIndex.get(tag);
          if (!tagSet) {
            tagSet = new Set();
            serverTagIndex.set(tag, tagSet);
          }
          tagSet.add(cacheKey);
        }
      } catch {
        // Skip corrupted entries
      }
    }
  } catch {
    // KV store not available or read failed — continue with empty cache
  }
}

/**
 * Whether the native KV store is being used for cache persistence.
 */
export function isUsingNativeKvCache(): boolean {
  return kvInitialized && isNativeKvStoreAvailable();
}
