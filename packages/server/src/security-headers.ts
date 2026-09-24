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
 * - Cross-Origin-Opener-Policy: same-origin-allow-popups
 * - Cross-Origin-Resource-Policy: same-origin
 * - Origin-Agent-Cluster: ?1
 * - X-Permitted-Cross-Domain-Policies: none
 * - Content-Security-Policy: nonce-based strict policy when the handler
 *   stamped a per-request nonce on the response's scripts; otherwise a
 *   restrictive unsafe-inline fallback (used for ISR-cached HTML, whose
 *   markup is shared across requests and cannot carry a per-request nonce).
 *
 * Users can override these via middleware headers or config.plugins.
 */

import type { PledgeConfig } from 'pledgestack-shared';

/** Default security headers applied to all responses */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Explicitly 0 — the legacy XSS auditor was removed from Chrome and its
  // "block" mode introduced more XSS vectors than it stopped. Modern
  // protection is the CSP below; the header is still sent to disable the
  // auditor in browsers old enough to ship it.
  'X-XSS-Protection': '0',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  // same-origin-allow-popups (not bare same-origin) so OAuth-style popup
  // flows (window.open to an IdP that postMessages back) keep working while
  // cross-origin window.opener access is still severed.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  // CORP same-origin blocks cross-site embedding of responses. API routes
  // with a permissive CORS config override this to cross-origin in the
  // handler, where the route's intent is known.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

/** HSTS header — only applied on HTTPS */
export const HSTS_HEADER = 'Strict-Transport-Security: max-age=31536000; includeSubDomains; preload';

export interface SecurityHeaderOptions {
  /**
   * Per-request CSP nonce. When present (and no user/config CSP), the
   * emitted policy uses `script-src 'self' 'nonce-<value>' 'strict-dynamic'`
   * — no 'unsafe-inline' — because the handler stamps the same nonce on
   * every executable <script> tag in the response.
   */
  cspNonce?: string;
  /**
   * Extra origins appended to script-src — e.g. the bundler dev-server
   * origin in dev mode, whose generated client script imports modules
   * cross-origin (different port).
   */
  scriptSrc?: string[];
  /**
   * Extra origins appended to connect-src — e.g. the bundler dev-server
   * HTTP + WebSocket origins for HMR.
   */
  connectSrc?: string[];
  /**
   * Allow 'unsafe-eval' in script-src. Needed in dev only — some bundler
   * dev pipelines evaluate transformed modules.
   */
  allowEval?: boolean;
  /**
   * CSP `script-src` hash sources (`'sha256-…'`) covering the response's
   * inline <script> bodies. Used when a per-request nonce is impossible —
   * ISR-cached and prerendered HTML is frozen, so hashes are the strict
   * alternative to 'unsafe-inline'. Computed from the final response body.
   */
  scriptHashes?: string[];
  /**
   * Emit the policy as Content-Security-Policy-Report-Only — the browser
   * reports violations without blocking. Used by config.cspReportOnly to
   * trial strict CSP before enforcing it.
   */
  reportOnly?: boolean;
  /**
   * report-uri target for violation reports (default: the built-in
   * /__pledge__/csp-report collector endpoint).
   */
  reportUri?: string;
}

/**
 * Applies security headers to a response headers object.
 * Does not override headers that are already set (user/middleware takes precedence).
 */
export function applySecurityHeaders(
  headers: Record<string, string>,
  config: PledgeConfig,
  isHttps = false,
  options: SecurityHeaderOptions = {},
): Record<string, string> {
  // Skip if security headers are disabled in config
  if (config.securityHeaders === false) {
    return headers;
  }

  const result = { ...headers };
  // HTTP header names are case-insensitive, and route handlers hand us
  // lowercased names (Headers#entries()). An exact-case `in` check missed
  // e.g. `x-frame-options` / `content-security-policy`, so the framework
  // default was added alongside (and overrode) the route's own value.
  const has = (name: string): boolean => {
    const lower = name.toLowerCase();
    return Object.keys(result).some((k) => k.toLowerCase() === lower);
  };

  // Apply default security headers (don't override existing ones)
  for (const [key, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
    if (!has(key)) {
      result[key] = value;
    }
  }

  // Apply HSTS only on HTTPS
  if (isHttps && !has('Strict-Transport-Security')) {
    result['Strict-Transport-Security'] = HSTS_HEADER.split(': ')[1];
  }

  // Apply CSP header if not already set and config has CSP directives
  const cspHeaderName = options.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  if (!has(cspHeaderName) && !has('Content-Security-Policy')) {
    // Violation reports go to the built-in collector endpoint so developers
    // can see what a policy would break — no external service needed. Both
    // mechanisms are emitted: report-uri for older browsers, report-to
    // (with its Reporting-Endpoints declaration) for the modern API.
    const reportUri = options.reportUri ?? '/__pledge__/csp-report';
    const reportDirective = `report-uri ${reportUri}; report-to csp-endpoint`;
    if (!has('Reporting-Endpoints')) {
      result['Reporting-Endpoints'] = `csp-endpoint="${reportUri}"`;
    }
    const cspConfig = config.csp;
    // Baseline directives shared by both generated policies. base-uri 'none'
    // matters specifically because the framework emits relative script srcs —
    // an injected <base href> would otherwise retarget them cross-origin.
    const baseline = [
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
      // upgrade-insecure-requests only on HTTPS deployments — on plain-HTTP
      // dev it would force-upgrade the page's own subresources to https.
      ...(isHttps ? ['upgrade-insecure-requests'] : []),
    ];
    if (cspConfig) {
      const directives = Object.entries(cspConfig)
        .map(([key, value]) => `${key} ${value}`)
        .join('; ');
      result[cspHeaderName] = directives;
    } else if (options.cspNonce) {
      // Strict nonce-based policy — the handler stamps this nonce on every
      // executable <script> tag it emits, so inline injection is blocked
      // without 'unsafe-inline'. style-src keeps 'unsafe-inline' because
      // framework output (React style attributes, injected <style> tags)
      // legitimately needs it and style injection is far lower risk.
      const scriptSrc = ["'self'", `'nonce-${options.cspNonce}'`, "'strict-dynamic'"];
      if (options.allowEval) scriptSrc.push("'unsafe-eval'");
      if (options.scriptSrc) scriptSrc.push(...options.scriptSrc);
      const connectSrc = ["'self'", ...(options.connectSrc ?? [])];
      result[cspHeaderName] = [
        "default-src 'self'",
        `script-src ${scriptSrc.join(' ')}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        `connect-src ${connectSrc.join(' ')}`,
        ...baseline,
        reportDirective,
      ].join('; ') + ';';
    } else {
      // Hash-based policy for responses that can't carry a nonce —
      // ISR-cached HTML is shared across requests, so a frozen nonce would
      // never match, but the inline scripts' bytes are frozen too, making
      // 'sha256-…' sources exact and stable. 'unsafe-inline' survives only
      // as the last resort when no hashes were computed (non-HTML bodies,
      // streaming paths that don't expose the payload).
      const scriptSrc = options.scriptHashes?.length
        ? `'self' ${options.scriptHashes.join(' ')}`
        : "'self' 'unsafe-inline'";
      result[cspHeaderName] = `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; ${baseline.join('; ')}; ${reportDirective};`;
    }
  }

  return result;
}
