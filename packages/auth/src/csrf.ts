/**
 * CSRF protection for server actions — double-submit cookie + Origin validation.
 *
 * Validates that state-changing requests (POST, PUT, DELETE, PATCH) include
 * a valid CSRF token via double-submit cookie pattern and Origin/Sec-Fetch-Site
 * header validation.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PledgeRequest } from 'pledgestack-shared';

export interface CsrfOptions {
  /** Cookie name for CSRF token (default: '__pledge_csrf') */
  cookieName?: string;
  /** Header name to read CSRF token from (default: 'x-pledge-csrf') */
  headerName?: string;
  /** Token length in bytes (default: 32) */
  tokenLength?: number;
  /** Whether to enforce Origin header check (default: true) */
  checkOrigin?: boolean;
  /** Allowed origins for Origin header validation */
  allowedOrigins?: string[];
}

const DEFAULT_COOKIE_NAME = '__pledge_csrf';
const DEFAULT_HEADER_NAME = 'x-pledge-csrf';

/**
 * Generate a new CSRF token.
 */
export function generateCsrfToken(length = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Build the Set-Cookie header for the CSRF token.
 */
export function csrfCookie(token: string, options?: CsrfOptions): string {
  const name = options?.cookieName ?? DEFAULT_COOKIE_NAME;
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Validate the CSRF token using double-submit cookie pattern.
 * The token must be present in both the cookie and the header/body.
 */
export function validateCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined,
): boolean {
  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length !== headerToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));
  } catch {
    return false;
  }
}

/**
 * Validate the Origin header against allowed origins.
 */
export function validateOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

/**
 * Check Sec-Fetch-Site header for same-origin requests.
 * Returns true only when the header explicitly says so — a missing header
 * (older browsers, non-browser HTTP clients, or a request deliberately
 * crafted without it) returns false rather than being assumed safe, since
 * treating "unknown" as "same-site" would let a forged cross-origin request
 * skip Origin validation simply by omitting this header.
 */
export function isSameSiteRequest(headers: Record<string, string>): boolean {
  const secFetchSite = headers['sec-fetch-site'];
  if (!secFetchSite) return false;
  return secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none';
}

/**
 * CSRF middleware — validates all state-changing requests.
 * Returns true if the request is valid, false if it should be rejected.
 */
export function csrfProtection(req: PledgeRequest, options?: CsrfOptions): boolean {
  const method = req.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const cookieName = options?.cookieName ?? DEFAULT_COOKIE_NAME;
  const headerName = options?.headerName ?? DEFAULT_HEADER_NAME;
  const checkOrigin = options?.checkOrigin ?? true;

  const cookieToken = req.cookies[cookieName];
  const headerToken = req.headers[headerName];

  if (!validateCsrfToken(cookieToken, headerToken)) {
    return false;
  }

  if (checkOrigin && !isSameSiteRequest(req.headers)) {
    // Not confirmed same-site (either explicitly cross-site, or the client
    // didn't send Sec-Fetch-Site at all) — fall back to validating Origin.
    // Note: this only rejects when `allowedOrigins` is configured; without
    // it, Origin validation is a no-op and the double-submit cookie check
    // above remains the only enforced protection.
    const origin = req.headers['origin'];
    if (options?.allowedOrigins && !validateOrigin(origin, options.allowedOrigins)) {
      return false;
    }
  }

  return true;
}

/**
 * Create a CSRF protection middleware function for use in the request pipeline.
 * Returns a function that takes a request and returns true (valid) or throws (invalid).
 */
export function createCsrfMiddleware(options?: CsrfOptions) {
  return (req: PledgeRequest): boolean => {
    if (!csrfProtection(req, options)) {
      throw new Response(JSON.stringify({ error: 'CSRF token validation failed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return true;
  };
}
