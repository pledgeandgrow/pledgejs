/**
 * Security headers middleware — auto-applies security headers to all responses.
 *
 * When config.securityHeaders is true (default), the following headers are
 * automatically applied to every HTTP response:
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY
 * - X-XSS-Protection: 1; mode=block
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - X-DNS-Prefetch-Control: off
 * - Strict-Transport-Security: max-age=31536000; includeSubDomains (HTTPS only)
 * - Permissions-Policy: restrictive default
 *
 * Users can override these via middleware headers or config.plugins.
 */

import type { PledgeConfig } from 'pledgestack-shared';

/** Default security headers applied to all responses */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
};

/** HSTS header — only applied on HTTPS */
export const HSTS_HEADER = 'Strict-Transport-Security: max-age=31536000; includeSubDomains; preload';

/**
 * Applies security headers to a response headers object.
 * Does not override headers that are already set (user/middleware takes precedence).
 */
export function applySecurityHeaders(
  headers: Record<string, string>,
  config: PledgeConfig,
  isHttps = false,
): Record<string, string> {
  // Skip if security headers are disabled in config
  if (config.securityHeaders === false) {
    return headers;
  }

  const result = { ...headers };

  // Apply default security headers (don't override existing ones)
  for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }

  // Apply HSTS only on HTTPS
  if (isHttps && !('Strict-Transport-Security' in result)) {
    result['Strict-Transport-Security'] = HSTS_HEADER.split(': ')[1];
  }

  // Apply CSP header if not already set and config has CSP directives
  if (!('Content-Security-Policy' in result)) {
    const cspConfig = (config as unknown as Record<string, unknown>).csp as Record<string, string> | undefined;
    if (cspConfig) {
      const directives = Object.entries(cspConfig)
        .map(([key, value]) => `${key} ${value}`)
        .join('; ');
      result['Content-Security-Policy'] = directives;
    } else {
      // Apply default CSP — restrictive but functional
      result['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';";
    }
  }

  return result;
}
