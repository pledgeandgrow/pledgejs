import type { PledgeRequest, PledgeResponse } from 'pledgestack-shared';

export type ApiRouteHandler = (
  req: PledgeRequest,
) => Promise<PledgeResponse> | PledgeResponse;

export interface ApiRouteOptions {
  /**
   * Reserved for request validation. Not applied yet — there is no schema
   * runtime wired in, so express validation via `middleware` (a function that
   * returns a 4xx response) instead of relying on this field.
   */
  validate?: {
    body?: unknown;
    query?: unknown;
    params?: unknown;
  };
  /** Rate limit configuration */
  rateLimit?: {
    windowMs: number;
    max: number;
  };
  /** Middleware to run before handler */
  middleware?: Array<(req: PledgeRequest) => Promise<PledgeResponse | null>>;
}

/** Sweep expired rate-limit buckets once the map reaches this size. */
const PRUNE_THRESHOLD = 1000;
/** Absolute upper bound on tracked rate-limit keys per route. */
const MAX_BUCKETS = 10_000;
/** Minimum gap between full expiry sweeps (keeps per-request cost O(1) amortized). */
const SWEEP_INTERVAL_MS = 1000;

export function defineApiRoute(
  handler: ApiRouteHandler,
  options?: ApiRouteOptions,
): ApiRouteHandler {
  if (!options || (!options.middleware && !options.rateLimit)) {
    return handler;
  }

  // Fixed-window rate-limit state, keyed by client identifier.
  const rlWindow = options.rateLimit;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;

  return async (req: PledgeRequest): Promise<PledgeResponse> => {
    // Rate limiting (previously the whole options object was ignored, so
    // rateLimit/middleware never ran).
    if (rlWindow) {
      // Prefer the handler-resolved IP (which honors the trustedProxies
      // config) — raw forwarded headers are client-spoofable when no
      // trusted proxy is configured.
      const key = req.ip
        ?? req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        ?? req.headers['x-real-ip']
        ?? 'unknown';
      const now = Date.now();
      // Sweep expired entries so long-running servers don't grow the map
      // unboundedly with keys that never return.
      if (buckets.size >= MAX_BUCKETS || (buckets.size >= PRUNE_THRESHOLD && now - lastSweep >= SWEEP_INTERVAL_MS)) {
        lastSweep = now;
        for (const [k, b] of buckets) {
          if (b.resetAt <= now) buckets.delete(k);
        }
        // Hard bound: if every remaining bucket is still live (a flood of
        // distinct client keys inside one window), evict oldest-inserted first
        // so memory can never exceed MAX_BUCKETS entries.
        while (buckets.size >= MAX_BUCKETS) {
          const oldest = buckets.keys().next();
          if (oldest.done) break;
          buckets.delete(oldest.value);
        }
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + rlWindow.windowMs });
      } else {
        bucket.count++;
        if (bucket.count > rlWindow.max) {
          const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
          return {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
            body: JSON.stringify({ error: 'Too Many Requests' }),
          };
        }
      }
    }

    // Middleware chain — the first middleware to return a response short-circuits.
    if (options.middleware) {
      for (const mw of options.middleware) {
        const result = await mw(req);
        if (result) return result;
      }
    }

    return handler(req);
  };
}
