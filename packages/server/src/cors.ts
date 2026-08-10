/**
 * CORS middleware for API routes.
 *
 * Sets Access-Control-* headers based on configuration and handles
 * preflight OPTIONS requests. Unlike the dev-mode warnings in safety-net.ts,
 * this is actual CORS enforcement for production use.
 */

export interface CorsConfig {
  /** Allowed origins (e.g. ['https://example.com']). Use ['*'] for any origin. */
  origins: string[];
  /** Allowed methods (default: GET, POST, PUT, DELETE, PATCH, OPTIONS) */
  methods?: string[];
  /** Allowed headers (default: Content-Type, Authorization, X-Pledge-CSRF) */
  allowedHeaders?: string[];
  /** Headers exposed to the client */
  exposedHeaders?: string[];
  /** Whether to allow credentials (cookies, Authorization) */
  credentials?: boolean;
  /** Max age for preflight cache (seconds, default: 86400) */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
const DEFAULT_HEADERS = ['Content-Type', 'Authorization', 'X-Pledge-CSRF'];

/**
 * Generates CORS headers for a given request origin.
 * Returns an object with Access-Control-* headers, or empty object if origin not allowed.
 */
export function generateCorsHeaders(
  requestOrigin: string | undefined,
  config: CorsConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Handle origin
  if (config.origins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (requestOrigin && config.origins.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin;
    headers['Vary'] = 'Origin';
  } else {
    // Origin not allowed — return empty headers (CORS check will fail)
    return {};
  }

  // Methods
  headers['Access-Control-Allow-Methods'] = (config.methods ?? DEFAULT_METHODS).join(', ');

  // Allowed headers
  headers['Access-Control-Allow-Headers'] = (config.allowedHeaders ?? DEFAULT_HEADERS).join(', ');

  // Exposed headers
  if (config.exposedHeaders && config.exposedHeaders.length > 0) {
    headers['Access-Control-Expose-Headers'] = config.exposedHeaders.join(', ');
  }

  // Credentials
  if (config.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  // Max age
  headers['Access-Control-Max-Age'] = String(config.maxAge ?? 86400);

  return headers;
}

/**
 * Checks if a request is a CORS preflight (OPTIONS) request.
 */
export function isPreflightRequest(method: string, headers: Record<string, string>): boolean {
  return method === 'OPTIONS' && !!headers['access-control-request-method'];
}

/**
 * CORS middleware — applies CORS headers to a response and handles preflight.
 *
 * Returns null if the request should continue (actual request),
 * or a preflight response object if it was an OPTIONS preflight.
 */
export function corsMiddleware(
  method: string,
  headers: Record<string, string>,
  config: CorsConfig,
): { headers: Record<string, string> } | null {
  const origin = headers['origin'] ?? headers['Origin'];

  if (isPreflightRequest(method, headers)) {
    const corsHeaders = generateCorsHeaders(origin, config);
    if (Object.keys(corsHeaders).length === 0) {
      // Origin not allowed — return 403
      return { headers: { 'Content-Type': 'text/plain' } };
    }
    return { headers: corsHeaders };
  }

  // For actual requests, return CORS headers to be merged with response
  const corsHeaders = generateCorsHeaders(origin, config);
  return { headers: corsHeaders };
}

/**
 * Default CORS config — restrictive (same-origin only).
 * Override via pledge.config.ts: `cors: { origins: [...] }`
 */
export const DEFAULT_CORS_CONFIG: CorsConfig = {
  origins: [],
  methods: DEFAULT_METHODS,
  allowedHeaders: DEFAULT_HEADERS,
  credentials: false,
  maxAge: 86400,
};
