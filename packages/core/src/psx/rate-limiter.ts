/**
 * Rate limiter — token bucket algorithm.
 *
 * When the rust-rate-limiter NAPI addon is compiled it provides cross-worker
 * shared state. When it is NOT compiled, this falls back to a per-process JS
 * Map.
 *
 * IMPORTANT: the JS fallback is PER-PROCESS, not cross-worker. In a clustered
 * / multi-worker deployment each worker enforces its own independent bucket,
 * so the effective limit is `maxTokens × workerCount`. For a hard global limit
 * without the native addon, put the rate limiter behind a shared store
 * (e.g. Redis) or run a single process. `isNativeRateLimiterAvailable()`
 * reports which mode is active.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NativeRateLimiter {
  checkRateLimit: (key: string, maxTokens: number, refillRate: number) => RateLimitResult;
  resetRateLimit: (key: string) => void;
  clearAllRateLimits: () => void;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

let nativeAddon: NativeRateLimiter | null = null;
let loadAttempted = false;

function loadNative(): NativeRateLimiter | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../../native/rust-rate-limiter.node') as NativeRateLimiter;
    if (typeof addon.checkRateLimit === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

// JS fallback state
interface JsBucket {
  tokens: number;
  lastRefill: number;
}
const jsBuckets = new Map<string, JsBucket>();

/** Cap on tracked buckets so a unique-key flood cannot grow memory unbounded. */
const MAX_JS_BUCKETS = 50000;
let fallbackWarned = false;

function warnFallbackOnce(): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[pledgestack] rate limiter is using the per-process JS fallback ' +
      '(rust-rate-limiter addon not compiled). Limits are NOT shared across ' +
      'workers; effective limit is maxTokens × workerCount.',
    );
  }
}

/** Evict a fully-refilled (idle) bucket, or the oldest, when over the cap. */
function evictJsBuckets(maxTokens: number): void {
  for (const [key, bucket] of jsBuckets) {
    if (bucket.tokens >= maxTokens) jsBuckets.delete(key);
  }
  if (jsBuckets.size <= MAX_JS_BUCKETS) return;
  const overflow = jsBuckets.size - MAX_JS_BUCKETS;
  let removed = 0;
  for (const key of jsBuckets.keys()) {
    if (removed >= overflow) break;
    jsBuckets.delete(key);
    removed++;
  }
}

function jsCheckRateLimit(key: string, maxTokens: number, refillRate: number): RateLimitResult {
  warnFallbackOnce();
  const now = Date.now();
  let bucket = jsBuckets.get(key);

  if (!bucket) {
    if (jsBuckets.size >= MAX_JS_BUCKETS) evictJsBuckets(maxTokens);
    bucket = { tokens: maxTokens, lastRefill: now };
    jsBuckets.set(key, bucket);
  }

  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1.0) {
    bucket.tokens -= 1.0;
    return { allowed: true, remaining: bucket.tokens, retryAfterMs: 0 };
  }

  const retrySecs = (1.0 - bucket.tokens) / refillRate;
  return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(retrySecs * 1000) };
}

export type { RateLimitResult };

/**
 * Checks if a request should be allowed under the rate limit.
 *
 * @param key Identifier (IP, API key, user ID)
 * @param maxTokens Burst capacity
 * @param refillRate Tokens per second (sustained rate)
 */
export function checkRateLimit(key: string, maxTokens: number, refillRate: number): RateLimitResult {
  const addon = loadNative();
  if (addon) {
    return addon.checkRateLimit(key, maxTokens, refillRate);
  }
  return jsCheckRateLimit(key, maxTokens, refillRate);
}

/**
 * Resets the rate limit for a given key.
 */
export function resetRateLimit(key: string): void {
  const addon = loadNative();
  if (addon) {
    addon.resetRateLimit(key);
    return;
  }
  jsBuckets.delete(key);
}

/**
 * Clears all rate limit buckets.
 */
export function clearAllRateLimits(): void {
  const addon = loadNative();
  if (addon) {
    addon.clearAllRateLimits();
    return;
  }
  jsBuckets.clear();
}

/**
 * Whether the native rate limiter is available.
 */
export function isNativeRateLimiterAvailable(): boolean {
  return loadNative() !== null;
}
