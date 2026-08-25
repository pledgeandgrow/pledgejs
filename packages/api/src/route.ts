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

  return async (req: PledgeRequest): Promise<PledgeResponse> => {
    // Rate limiting (previously the whole options object was ignored, so
    // rateLimit/middleware never ran).
    if (rlWindow) {
      const key = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        ?? req.headers['x-real-ip']
        ?? 'unknown';
      const now = Date.now();
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
