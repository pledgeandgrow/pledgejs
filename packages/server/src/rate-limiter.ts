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

import { checkRateLimit, isNativeRateLimiterAvailable } from 'pledgestack-core';
import type { PledgePlugin } from 'pledgestack-shared';

export interface RateLimitOptions {
  /** Maximum tokens (burst capacity). Default: 100 */
  maxTokens?: number;
  /** Tokens refilled per second (sustained rate). Default: 10 */
  refillRate?: number;
  /** Key function — defaults to IP address from x-forwarded-for or socket remoteAddress */
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
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.ip ?? 'unknown';
  });

  return {
    name: 'pledgestack-rate-limiter',

    routeMatch(ctx) {
      // Skip excluded paths
      if (excludePaths.some((p) => ctx.pathname.startsWith(p))) {
        return;
      }

      const key = keyFn({ headers: {}, ip: undefined });
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
