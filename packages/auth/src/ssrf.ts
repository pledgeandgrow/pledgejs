import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function isPrivate(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('169.254.')) return true;
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return false;
}

function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.') || ip.startsWith('fe80:');
}

export interface SsrfCheckOptions {
  /** Allow loopback addresses (127.x.x.x) — default: false */
  allowLoopback?: boolean;
  /** Allow private network addresses (10.x, 192.168.x, etc) — default: false */
  allowPrivate?: boolean;
  /** Allow link-local addresses (169.254.x) — default: false */
  allowLinkLocal?: boolean;
  /** Blocklist of domains */
  blocklist?: string[];
  /** Allowlist of domains (if set, only these are allowed) */
  allowlist?: string[];
  /** Timeout for DNS resolution in ms (default: 5000) */
  dnsTimeout?: number;
}

export async function isSafeUrl(
  url: string,
  options: SsrfCheckOptions = {},
): Promise<{ safe: boolean; reason?: string }> {
  const {
    allowLoopback = false,
    allowPrivate = false,
    allowLinkLocal = false,
    blocklist = [],
    allowlist,
    dnsTimeout = 5000,
  } = options;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  const hostname = parsed.hostname;

  if (allowlist && !allowlist.includes(hostname)) {
    return { safe: false, reason: `Hostname ${hostname} not in allowlist` };
  }

  if (blocklist.includes(hostname)) {
    return { safe: false, reason: `Hostname ${hostname} is blocklisted` };
  }

  if (isIP(hostname)) {
    const check = checkIp(hostname, { allowLoopback, allowPrivate, allowLinkLocal });
    if (!check.safe) return check;
  } else {
    try {
      const addresses = await withTimeout(lookup(hostname, { all: true }), dnsTimeout);
      for (const addr of addresses) {
        const check = checkIp(addr.address, { allowLoopback, allowPrivate, allowLinkLocal });
        if (!check.safe) return check;
      }
    } catch {
      return { safe: false, reason: 'DNS resolution failed' };
    }
  }

  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { safe: false, reason: `Protocol ${protocol} not allowed` };
  }

  return { safe: true };
}

function checkIp(
  ip: string,
  opts: { allowLoopback: boolean; allowPrivate: boolean; allowLinkLocal: boolean },
): { safe: boolean; reason?: string } {
  if (isLoopback(ip) && !opts.allowLoopback) {
    return { safe: false, reason: 'Loopback address blocked' };
  }
  if (isPrivate(ip) && !opts.allowPrivate) {
    return { safe: false, reason: 'Private network address blocked' };
  }
  if (isLinkLocal(ip) && !opts.allowLinkLocal) {
    return { safe: false, reason: 'Link-local address blocked' };
  }
  return { safe: true };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS timeout')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const MAX_REDIRECTS = 10;

export function createSafeFetch(options: SsrfCheckOptions = {}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'object' && !(input instanceof URL) && 'url' in input) {
      // Request object — merge its own method/headers/body with init (init wins).
      const merged: RequestInit = {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? (input.method !== 'GET' && input.method !== 'HEAD' ? await input.arrayBuffer() : undefined),
        signal: init?.signal ?? input.signal,
        redirect: init?.redirect ?? input.redirect,
      };
      return safeRequest(input.url, merged, options, 0);
    }
    const url = typeof input === 'string' ? input : input.href;
    return safeRequest(url, init, options, 0);
  };
}

/**
 * Performs an HTTP(S) request with SSRF validation and DNS-rebinding (TOCTOU)
 * pinning. Every redirect hop is re-validated — without that, an allowed URL
 * could 302 to a private/metadata address and bypass the initial check.
 *
 * Pinning is done via the `lookup` socket option rather than URL rewriting:
 * the hostname stays in the URL, so TLS SNI and certificate validation work
 * normally (the previous IP-rewrite approach broke HTTPS cert validation).
 */
async function safeRequest(
  url: string,
  init: RequestInit | undefined,
  options: SsrfCheckOptions,
  redirectCount: number,
): Promise<Response> {
  const check = await isSafeUrl(url, options);
  if (!check.safe) {
    throw new Error(`SSRF blocked: ${check.reason}`);
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Pin the resolved IP to prevent DNS rebinding (TOCTOU): isSafeUrl resolved
  // the hostname and validated the IP, but a naive request would re-resolve
  // DNS — allowing a malicious DNS server to return a safe IP for the check
  // and a private IP (e.g. 169.254.169.254) for the actual connection.
  let resolvedIp: string | null = null;
  if (!isIP(hostname)) {
    try {
      const addresses = await withTimeout(lookup(hostname, { all: true }), options.dnsTimeout ?? 5000);
      // isSafeUrl already validated all addresses; use the first.
      if (addresses.length > 0) resolvedIp = addresses[0].address;
    } catch {
      // If DNS fails here, isSafeUrl would have caught it. Fall through —
      // Node will resolve normally.
    }
  }

  return new Promise<Response>((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const req = mod(
      url,
      {
        method: init?.method ?? 'GET',
        headers,
        // Pin DNS: return the validated IP for the hostname. The hostname
        // itself stays in the request, so TLS SNI and certificate
        // validation still see the real domain — only the TCP connection
        // goes to the pinned address.
        lookup: resolvedIp
          ? (
              _host: string,
              opts: { all?: boolean } | undefined,
              cb: (err: Error | null, address: string | import('node:dns').LookupAddress[], family?: number) => void,
            ) => {
              const family = isIP(resolvedIp) === 6 ? 6 : 4;
              // Node calls lookup with all:true for some connection paths
              // (expecting [{address,family}]) and all:false for others
              // (expecting (address, family)). Handle both.
              if (opts?.all) cb(null, [{ address: resolvedIp, family }]);
              else cb(null, resolvedIp, family);
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', async () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;

          // Handle redirects per fetch semantics: 'error' rejects, 'manual'
          // returns the 3xx response, 'follow' (default) re-validates each hop.
          if (status >= 300 && status < 400 && res.headers.location) {
            if (init?.redirect === 'manual') {
              // Fall through to return the 3xx response as-is.
            } else if (init?.redirect === 'error') {
              reject(new Error(`SSRF fetch encountered a redirect (${status})`));
              return;
            } else if (redirectCount >= MAX_REDIRECTS) {
              reject(new Error('SSRF fetch exceeded maximum redirects'));
              return;
            } else {
              try {
                const redirectUrl = new URL(res.headers.location, url).href;
                // Per fetch spec, 301/302/303 downgrade non-GET/HEAD to GET.
                const downgrade = status === 301 || status === 302 || status === 303;
                const method = init?.method ?? 'GET';
                const redirectInit: RequestInit = {
                  ...init,
                  method: downgrade && method !== 'GET' && method !== 'HEAD' ? 'GET' : method,
                  body: downgrade && method !== 'GET' && method !== 'HEAD' ? undefined : init?.body,
                };
                const next = await safeRequest(redirectUrl, redirectInit, options, redirectCount + 1);
                resolve(next);
              } catch (err) {
                reject(err);
              }
              return;
            }
          }

          const resHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) resHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
          }

          resolve(
            new Response(body, {
              status,
              statusText: res.statusMessage,
              headers: resHeaders,
            }),
          );
        });
      },
    );

    req.on('error', reject);

    const writeBody = async () => {
      const body = init?.body;
      if (!body) return;
      // Convert any BodyInit to bytes — req.write only accepts
      // string | Buffer | Uint8Array, but BodyInit includes streams,
      // FormData, Blob, ArrayBuffer, URLSearchParams, etc.
      if (typeof body === 'string' || body instanceof Uint8Array) {
        req.write(body);
      } else {
        const bytes = Buffer.from(await new Response(body as BodyInit).arrayBuffer());
        req.write(bytes);
      }
    };

    writeBody()
      .then(() => req.end())
      .catch((err) => {
        req.destroy(err);
        reject(err);
      });
  });
}
