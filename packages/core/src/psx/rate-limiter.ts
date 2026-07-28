/**
 * Cross-worker rate limiter — token bucket algorithm with shared memory.
 *
 * Uses the rust-rate-limiter NAPI addon for cross-worker shared state.
 * When the native addon is not compiled, falls back to a per-process
 * JS Map which works for single-process mode.
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
    const addon = require('../native/rust-rate-limiter.node') as NativeRateLimiter;
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

function jsCheckRateLimit(key: string, maxTokens: number, refillRate: number): RateLimitResult {
  const now = Date.now();
  let bucket = jsBuckets.get(key);

  if (!bucket) {
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
