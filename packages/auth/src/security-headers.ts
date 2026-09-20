/**
 * Security headers middleware — automatic security headers on all responses.
 *
 * Adds: X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 * Permissions-Policy, Strict-Transport-Security, and clickjacking protection.
 */

export interface SecurityHeadersOptions {
  /** Enable HSTS (default: true in production) */
  hsts?: boolean;
  /** HSTS max-age in seconds (default: 31536000 = 1 year) */
  hstsMaxAge?: number;
  /** Include subdomains in HSTS (default: true) */
  hstsIncludeSubdomains?: boolean;
  /** Preload HSTS (default: true) */
  hstsPreload?: boolean;
  /** X-Frame-Options value (default: 'DENY') — use 'SAMEORIGIN' to allow same-origin frames */
  frameOptions?: 'DENY' | 'SAMEORIGIN';
  /** Referrer-Policy (default: 'strict-origin-when-cross-origin') */
  referrerPolicy?: string;
  /** Permissions-Policy — disable unused browser APIs */
  permissionsPolicy?: Record<string, string[]>;
  /** X-Content-Type-Options (default: 'nosniff') */
  contentTypeOptions?: string;
  /** Cross-Origin-Opener-Policy (default: 'same-origin') */
  coop?: string;
  /** Cross-Origin-Embedder-Policy (default: not set) */
  coep?: string;
  /** Cross-Origin-Resource-Policy (default: 'same-site') */
  corp?: string;
}

export const DEFAULT_PERMISSIONS_POLICY: Record<string, string[]> = {
  camera: [],
  microphone: [],
  geolocation: [],
  'midi': [],
  'usb': [],
  'accelerometer': [],
  'gyroscope': [],
  'magnetometer': [],
  'payment': [],
};

export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // same-origin-allow-popups keeps OAuth popup flows working while severing
  // cross-origin window.opener access.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

/**
 * Generate the full set of security headers.
 */
export function generateSecurityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': options.contentTypeOptions ?? 'nosniff',
    'X-Frame-Options': options.frameOptions ?? 'DENY',
    'Referrer-Policy': options.referrerPolicy ?? 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': options.coop ?? 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': options.corp ?? 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'X-Permitted-Cross-Domain-Policies': 'none',
  };

  if (options.coep) {
    headers['Cross-Origin-Embedder-Policy'] = options.coep;
  }

  const pp = options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY;
  const ppParts: string[] = [];
  for (const [feature, allowlist] of Object.entries(pp)) {
    if (allowlist.length === 0) {
      ppParts.push(`${feature}=()`);
    } else {
      ppParts.push(`${feature}=(${allowlist.join(' ')})`);
    }
  }
  if (ppParts.length > 0) {
    headers['Permissions-Policy'] = ppParts.join(', ');
  }

  if (options.hsts !== false) {
    const maxAge = options.hstsMaxAge ?? 31536000;
    const parts = [`max-age=${maxAge}`];
    if (options.hstsIncludeSubdomains !== false) parts.push('includeSubDomains');
    if (options.hstsPreload !== false) parts.push('preload');
    headers['Strict-Transport-Security'] = parts.join('; ');
  }

  return headers;
}

/**
 * Clickjacking protection — combines X-Frame-Options and CSP frame-ancestors.
 * Returns headers that prevent the page from being embedded in an iframe.
 */
export function clickjackingHeaders(mode: 'deny' | 'sameorigin' = 'deny'): Record<string, string> {
  if (mode === 'sameorigin') {
    return {
      'X-Frame-Options': 'SAMEORIGIN',
    };
  }
  return {
    'X-Frame-Options': 'DENY',
  };
}

/**
 * Middleware that applies security headers to every response.
 * Use in pledge.config.ts: `plugins: [securityHeadersMiddleware()]`
 */
export function securityHeadersMiddleware(options?: SecurityHeadersOptions) {
  const headers = generateSecurityHeaders(options);

  return {
    name: 'pledgestack-security-headers',
    configureResponse(responseHeaders: Record<string, string>): Record<string, string> {
      return { ...headers, ...responseHeaders };
    },
    getHeaders(): Record<string, string> {
      return { ...headers };
    },
  };
}
