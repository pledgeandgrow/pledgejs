/**
 * Fetch cache with revalidation tags — core caching primitive.
 *
 * Provides a cached fetch() that stores responses with TTL and tag-based
 * revalidation. Used by server components for automatic data caching.
 *
 * Supports:
 * - Time-based revalidation (TTL in seconds)
 * - Tag-based revalidation (revalidateTag)
 * - On-demand revalidation (revalidatePath)
 * - Request-level deduplication (same URL returns same promise)
 */

export interface CacheEntry {
  data: unknown;
  timestamp: number;
  revalidate: number;
  tags: string[];
}

export interface FetchCacheOptions {
  /** Revalidation TTL in seconds (0 = no cache, -1 = cache forever) */
  revalidate?: number;
  /** Tags for tag-based revalidation */
  tags?: string[];
  /** Force no-cache */
  noStore?: boolean;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
const tagIndex = new Map<string, Set<string>>();

/** Maximum number of cache entries before LRU eviction kicks in */
const MAX_CACHE_ENTRIES = 10000;

/** Interval for periodic expired-entry cleanup (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Evicts least-recently-used entries when cache exceeds MAX_CACHE_ENTRIES.
 * Map iteration order in JS follows insertion order, so the first entries
 * are the oldest. We delete from the front until we're under the limit.
 */
function enforceMaxEntries(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const toEvict = cache.size - MAX_CACHE_ENTRIES;
  let count = 0;
  for (const key of cache.keys()) {
    if (count >= toEvict) break;
    cache.delete(key);
    // Clean up tag index for evicted key
    for (const [tag, keys] of tagIndex.entries()) {
      if (keys.has(key)) {
        keys.delete(key);
        if (keys.size === 0) tagIndex.delete(tag);
      }
    }
    count++;
  }
}

/**
 * Removes expired entries from the cache.
 * Called periodically by the cleanup timer.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    const age = (now - entry.timestamp) / 1000;
    // Remove entries that have passed their revalidation window
    // (Infinity means cache forever, so skip those)
    if (entry.revalidate !== Infinity && age > entry.revalidate * 2) {
      cache.delete(key);
      for (const [tag, keys] of tagIndex.entries()) {
        if (keys.has(key)) {
          keys.delete(key);
          if (keys.size === 0) tagIndex.delete(tag);
        }
      }
    }
  }
}

/**
 * Starts the periodic cleanup timer. Called automatically on first cache use.
 */
function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
  // Don't keep the process alive just for cleanup
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/**
 * Stops the cleanup timer (for tests or graceful shutdown).
 */
export function stopCacheCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Cached fetch — wraps global fetch with caching and revalidation support.
 *
 * Usage in server components:
 *   const res = await cachedFetch('https://api.example.com/data', {
 *     next: { revalidate: 60, tags: ['posts'] }
 *   });
 */
export async function cachedFetch(
  url: string | URL,
  options: RequestInit & { next?: FetchCacheOptions } = {},
): Promise<Response> {
  const cacheKey = typeof url === 'string' ? url : url.toString();
  const cacheOpts = options.next ?? {};
  const revalidate = cacheOpts.revalidate ?? 0;
  const tags = cacheOpts.tags ?? [];

  if (cacheOpts.noStore || revalidate === 0) {
    return globalThis.fetch(url, options);
  }

  ensureCleanupTimer();

  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached) {
    const age = (now - cached.timestamp) / 1000;
    if (age < cached.revalidate) {
      return new Response(JSON.stringify(cached.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Stale-while-revalidate: serve stale data, refresh in background
    revalidateInBackground(cacheKey, url, options, revalidate, tags);
    return new Response(JSON.stringify(cached.data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Pledge-Cache': 'stale-while-revalidate' },
    });
  }

  if (inflight.has(cacheKey)) {
    const data = await inflight.get(cacheKey);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const promise = (async () => {
    const response = await globalThis.fetch(url, options);
    const data = await response.json();
    return data;
  })();

  inflight.set(cacheKey, promise);

  try {
    const data = await promise;
    cache.set(cacheKey, {
      data,
      timestamp: now,
      revalidate: revalidate === -1 ? Infinity : revalidate,
      tags,
    });

    for (const tag of tags) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
      tagIndex.get(tag)!.add(cacheKey);
    }

    enforceMaxEntries();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    inflight.delete(cacheKey);
  }
}

/**
 * Revalidate all cache entries with the given tag.
 */
export function revalidateTag(tag: string): void {
  const keys = tagIndex.get(tag);
  if (keys) {
    for (const key of keys) {
      cache.delete(key);
    }
    tagIndex.delete(tag);
  }
}

/**
 * Revalidate a specific path's cache entry.
 */
export function revalidatePath(path: string): void {
  cache.delete(path);
  for (const [tag, keys] of tagIndex.entries()) {
    if (keys.has(path)) {
      keys.delete(path);
      if (keys.size === 0) tagIndex.delete(tag);
    }
  }
}

/**
 * Clear the entire cache.
 */
export function clearCache(): void {
  cache.clear();
  inflight.clear();
  tagIndex.clear();
}

/**
 * Get cache stats for debugging.
 */
export function getCacheStats(): { size: number; tags: number; inflight: number } {
  return {
    size: cache.size,
    tags: tagIndex.size,
    inflight: inflight.size,
  };
}

/**
 * React cache() wrapper — deduplicates identical function calls within
 * a single request. Used for automatic data fetching deduplication.
 */
export function unstable_cache<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  keyParts: string[] = [],
  options: FetchCacheOptions = {},
): T {
  const cachedFn = async (...args: never[]) => {
    const cacheKey = keyParts.join(':') + ':' + JSON.stringify(args);
    const now = Date.now();
    const cached = cache.get(cacheKey);

    if (cached) {
      const age = (now - cached.timestamp) / 1000;
      if (age < cached.revalidate) {
        return cached.data;
      }
    }

    const data = await fn(...args);
    cache.set(cacheKey, {
      data,
      timestamp: now,
      revalidate: options.revalidate === -1 ? Infinity : (options.revalidate ?? 60),
      tags: options.tags ?? [],
    });

    if (options.tags) {
      for (const tag of options.tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
        tagIndex.get(tag)!.add(cacheKey);
      }
    }

    enforceMaxEntries();

    return data;
  };

  return cachedFn as T;
}

// --- ISR Background Revalidation (#25) ---

const isrTimers = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Register a route for ISR background revalidation.
 * The route's data will be refreshed in the background at the given interval,
 * serving stale content while refreshing.
 *
 * Usage:
 *   registerISR('/blog/[slug]', { revalidate: 60, tags: ['posts'] });
 */
export function registerISR(
  pattern: string,
  options: { revalidate: number; tags?: string[]; handler?: () => Promise<void> },
): void {
  // Clear any existing timer for this pattern
  unregisterISR(pattern);

  const timer = setInterval(async () => {
    try {
      // Revalidate all tagged entries
      if (options.tags) {
        for (const tag of options.tags) {
          revalidateTag(tag);
        }
      }
      // Call custom handler if provided
      if (options.handler) {
        await options.handler();
      }
    } catch (err) {
      console.error(`[pledgestack] ISR revalidation failed for ${pattern}:`, err);
    }
  }, options.revalidate * 1000);

  isrTimers.set(pattern, timer);
}

/**
 * Unregister ISR background revalidation for a route.
 */
export function unregisterISR(pattern: string): void {
  const timer = isrTimers.get(pattern);
  if (timer) {
    clearInterval(timer);
    isrTimers.delete(pattern);
  }
}

/**
 * Unregister all ISR timers (for graceful shutdown).
 */
export function unregisterAllISR(): void {
  for (const timer of isrTimers.values()) {
    clearInterval(timer);
  }
  isrTimers.clear();
}

// --- Cookie-based Cache Variants (#27) ---

const cookieVariantCache = new Map<string, CacheEntry>();

/**
 * Generate a cache key that includes cookie-based variant information.
 * This enables per-user or per-segment caching based on cookie values.
 *
 * Usage:
 *   const variantKey = cookieCacheKey('/dashboard', ['session', 'theme']);
 *   // Returns '/dashboard:session=abc123:theme=dark'
 */
export function cookieCacheKey(
  baseKey: string,
  cookieNames: string[],
  cookies: Record<string, string>,
): string {
  const variantParts: string[] = [];
  for (const name of cookieNames) {
    const value = cookies[name] ?? '';
    variantParts.push(`${name}=${value}`);
  }
  return variantParts.length > 0 ? `${baseKey}:${variantParts.join(':')}` : baseKey;
}

/**
 * Cached fetch with cookie-based cache variants.
 * Returns different cached responses based on the provided cookie values.
 *
 * Usage:
 *   const res = await cachedFetchWithCookies('/dashboard', {
 *     cookies: { session: 'abc123', theme: 'dark' },
 *     variantCookies: ['session', 'theme'],
 *     next: { revalidate: 60 },
 *   });
 */
export async function cachedFetchWithCookies(
  url: string | URL,
  options: RequestInit & {
    next?: FetchCacheOptions;
    cookies?: Record<string, string>;
    variantCookies?: string[];
  } = {},
): Promise<Response> {
  const cacheKey = typeof url === 'string' ? url : url.toString();
  const cookies = options.cookies ?? {};
  const variantCookies = options.variantCookies ?? [];
  const variantKey = cookieCacheKey(cacheKey, variantCookies, cookies);
  const cacheOpts = options.next ?? {};
  const revalidate = cacheOpts.revalidate ?? 0;

  if (cacheOpts.noStore || revalidate === 0) {
    return globalThis.fetch(url, options);
  }

  const now = Date.now();
  const cached = cookieVariantCache.get(variantKey);

  if (cached) {
    const age = (now - cached.timestamp) / 1000;
    if (age < cached.revalidate) {
      return new Response(JSON.stringify(cached.data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const response = await globalThis.fetch(url, options);
  const data = await response.json();

  cookieVariantCache.set(variantKey, {
    data,
    timestamp: now,
    revalidate: revalidate === -1 ? Infinity : revalidate,
    tags: cacheOpts.tags ?? [],
  });

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Clear cookie variant cache entries.
 */
export function clearCookieVariantCache(): void {
  cookieVariantCache.clear();
}

// --- Stale-While-Revalidate Background Refresh ---

/**
 * Tracks background revalidation promises to prevent duplicate refreshes.
 */
const swrInflight = new Set<string>();

/**
 * Triggers a background revalidation for a stale cache entry.
 * Does not block the current request — serves stale data while refreshing.
 */
function revalidateInBackground(
  cacheKey: string,
  url: string | URL,
  options: RequestInit & { next?: FetchCacheOptions },
  revalidate: number,
  tags: string[],
): void {
  if (swrInflight.has(cacheKey)) return;
  swrInflight.add(cacheKey);

  (async () => {
    try {
      const response = await globalThis.fetch(url, options);
      const data = await response.json();
      const now = Date.now();
      cache.set(cacheKey, {
        data,
        timestamp: now,
        revalidate: revalidate === -1 ? Infinity : revalidate,
        tags,
      });
      for (const tag of tags) {
        if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
        tagIndex.get(tag)!.add(cacheKey);
      }
    } catch {
      // Keep stale data on background fetch failure
    } finally {
      swrInflight.delete(cacheKey);
    }
  })();
}
