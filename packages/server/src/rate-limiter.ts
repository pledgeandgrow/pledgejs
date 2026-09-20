/**
 * Rate limiter middleware — uses native Rust shared-memory rate limiter
 * when available, falls back to per-process JS token bucket.
 *
 * Usage in pledge.config.ts:
 *   import { rateLimitMiddleware } from 'pledgestack';
 *   plugins: [rateLimitMiddleware({ maxTokens: 100, refillRate: 10 })]
 *
 * Or in middleware.ts:
 *   import { checkRateLimit } from 'pledgestack';
 *   const result = checkRateLimit(req.ip, 100, 10);
 *   if (!result.allowed) return Response.json({ error: 'Too many requests' }, { status: 429 });
 */

import { checkRateLimit } from 'pledgestack-core';
import type { PledgePlugin } from 'pledgestack-shared';

export interface RateLimitOptions {
  /** Maximum tokens (burst capacity). Default: 100 */
  maxTokens?: number;
  /** Tokens refilled per second (sustained rate). Default: 10 */
  refillRate?: number;
  /** Key function — defaults to the handler's trusted-proxy-resolved client IP */
  keyFn?: (req: { headers: Record<string, string>; ip?: string }) => string;
  /** Paths to exclude from rate limiting. Default: ['/api/health'] */
  excludePaths?: string[];
}

/**
 * Creates a rate limiter plugin for the PledgeStack plugin system.
 *
 * @example
 * ```ts
 * // pledge.config.ts
 * import { defineConfig } from 'pledgestack';
 * import { rateLimitMiddleware } from 'pledgestack';
 *
 * export default defineConfig({
 *   plugins: [rateLimitMiddleware({ maxTokens: 100, refillRate: 10 })],
 * });
 * ```
 */
export function rateLimitMiddleware(options: RateLimitOptions = {}): PledgePlugin {
  const maxTokens = options.maxTokens ?? 100;
  const refillRate = options.refillRate ?? 10;
  const excludePaths = options.excludePaths ?? ['/api/health'];
  const keyFn = options.keyFn ?? ((req) => {
    // ctx.ip is resolved by the handler through the trusted-proxy model —
    // X-Forwarded-For is only honored when the peer is a configured trusted
    // proxy, so a direct client can't spoof a fresh bucket per request.
    // Falling back to raw XFF here would re-open that hole.
    if (req.ip) return req.ip;
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return 'unknown';
  });

  return {
    name: 'pledgestack-rate-limiter',

    routeMatch(ctx) {
      // Skip excluded paths
      if (excludePaths.some((p) => ctx.pathname.startsWith(p))) {
        return;
      }

      // Derive the key from the real request context. Previously this was
      // called with a hardcoded empty request, so every client resolved to
      // 'unknown' and shared a single global bucket.
      const key = keyFn({ headers: ctx.headers ?? {}, ip: ctx.ip });
      const result = checkRateLimit(key, maxTokens, refillRate);

      if (!result.allowed) {
        return {
          ...ctx,
          response: {
            status: 429,
            body: JSON.stringify({
              error: 'Too Many Requests',
              retryAfterMs: result.retryAfterMs,
            }),
          },
        };
      }
    },
  };
}

export { checkRateLimit, isNativeRateLimiterAvailable } from 'pledgestack-core';
