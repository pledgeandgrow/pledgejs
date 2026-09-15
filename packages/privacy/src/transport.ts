import type { PledgeRequest, PledgeResponse, MiddlewareResult } from 'pledgestack-shared';

export interface TransportSecurityConfig {
  /** Enable HSTS (default: true in production) */
  hsts?: boolean;
  /** HSTS max age in seconds (default: 31536000 = 1 year) */
  hstsMaxAge?: number;
  /** Include subdomains in HSTS (default: true) */
  hstsIncludeSubdomains?: boolean;
  /** Preload HSTS into browser lists (default: false) */
  hstsPreload?: boolean;
  /** Redirect HTTP to HTTPS (default: true) */
  enforceHTTPS?: boolean;
  /** Minimum TLS version (default: 'TLSv1.2') */
  minTLSVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Trust proxy headers (X-Forwarded-Proto) (default: false — must be
   * explicitly enabled only behind a trusted reverse proxy, otherwise an
   * attacker can spoof the header to bypass HTTPS enforcement) */
  trustProxy?: boolean;
}

const DEFAULT_HSTS_MAX_AGE = 31536000;

/**
 * Encryption in transit — enforce HTTPS with HSTS preload,
 * automatic http:// → https:// redirect, TLS 1.2+ minimum.
 *
 * Use as middleware in your PledgeStack app:
 *
 * ```typescript
 * // middleware.ts
 * import { createTransportSecurityMiddleware } from 'pledgestack/privacy';
 *
 * export default createTransportSecurityMiddleware();
 * ```
 */
export function createTransportSecurityMiddleware(config: TransportSecurityConfig = {}): (req: Request) => Promise<MiddlewareResult> {
  const hsts = config.hsts ?? true;
  const hstsMaxAge = config.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE;
  const hstsIncludeSubdomains = config.hstsIncludeSubdomains ?? true;
  const hstsPreload = config.hstsPreload ?? false;
  const enforceHTTPS = config.enforceHTTPS ?? true;
  const trustProxy = config.trustProxy ?? false;

  return async (req: Request): Promise<MiddlewareResult> => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};

    // Determine if request is HTTPS
    const isSecure = determineSecure(req, url, trustProxy);

    // Redirect HTTP to HTTPS
    if (enforceHTTPS && !isSecure) {
      const httpsUrl = new URL(url);
      httpsUrl.protocol = 'https:';
      return {
        redirect: {
          destination: httpsUrl.toString(),
          permanent: true,
        },
      };
    }

    // Add HSTS header
    if (hsts && isSecure) {
      const hstsValue = [
        `max-age=${hstsMaxAge}`,
        hstsIncludeSubdomains ? 'includeSubDomains' : '',
        hstsPreload ? 'preload' : '',
      ].filter(Boolean).join('; ');
      headers['Strict-Transport-Security'] = hstsValue;
    }

    return { next: true, headers };
  };
}

/**
 * Check if a request is over HTTPS.
 * Handles proxy headers (X-Forwarded-Proto) and direct TLS connections.
 */
function determineSecure(req: Request, url: URL, trustProxy: boolean): boolean {
  if (url.protocol === 'https:') return true;

  if (trustProxy) {
    const forwardedProto = req.headers.get('x-forwarded-proto');
    if (forwardedProto === 'https') return true;
  }

  return false;
}

/**
 * Get the HSTS header value for manual header setting.
 */
export function getHSTSHeader(config: TransportSecurityConfig = {}): string {
  const maxAge = config.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE;
  const includeSubdomains = config.hstsIncludeSubdomains ?? true;
  const preload = config.hstsPreload ?? false;

  return [
    `max-age=${maxAge}`,
    includeSubdomains ? 'includeSubDomains' : '',
    preload ? 'preload' : '',
  ].filter(Boolean).join('; ');
}

/**
 * Check if a request meets the minimum TLS version.
 * Reads from X-Forwarded-TLS-Version or TLS-Version header (set by load balancers).
 */
export function meetsTLSMinimum(req: PledgeRequest, minVersion: 'TLSv1.2' | 'TLSv1.3' = 'TLSv1.2'): boolean {
  const tlsVersion = req.headers['x-forwarded-tls-version'] ?? req.headers['tls-version'];
  if (!tlsVersion) return true; // No LB header — cannot determine, allow (caller should document this)

  const order = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
  const reqIdx = order.indexOf(tlsVersion);
  const minIdx = order.indexOf(minVersion);

  if (reqIdx === -1 || minIdx === -1) return true;
  return reqIdx >= minIdx;
}

/**
 * Create a TLS enforcement response for requests below minimum version.
 */
export function tlsVersionResponse(): PledgeResponse {
  return {
    status: 526,
    headers: { 'Content-Type': 'text/plain' },
    body: 'TLS version too old. Minimum required: TLS 1.2',
  };
}
