/**
 * Edge & Runtime Security — Secrets, rate limiting, auth, CSP, geo, bot, cold start, timeout.
 *
 * Items 177-184 of the PledgeStack roadmap.
 * These utilities run at the edge (Cloudflare Workers, Vercel Edge, Deno Deploy)
 * without Node.js builtins.
 */

import type { EdgeTarget } from './index';

// ---------------------------------------------------------------------------
// 177. Edge secrets management
// ---------------------------------------------------------------------------

export interface EdgeSecretsConfig {
  /** Target platform */
  target: EdgeTarget;
  /** Cloudflare Workers secret bindings */
  cloudflare?: Record<string, string>;
  /** Vercel Edge Config store ID */
  vercelEdgeConfig?: string;
  /** Deno KV namespace */
  denoKvNamespace?: string;
}

export interface EdgeSecretProvider {
  get(key: string): Promise<string | undefined>;
  keys(): Promise<string[]>;
}

/**
 * Creates a platform-specific secret provider for edge runtime.
 *
 * Cloudflare: uses env bindings (e.g. `env.MY_SECRET`)
 * Vercel: uses `@vercel/edge-config`
 * Deno: uses `Deno.KV`
 */
export function createEdgeSecretProvider(config: EdgeSecretsConfig): EdgeSecretProvider {
  switch (config.target) {
    case 'cloudflare':
      return {
        async get(key: string) {
          return config.cloudflare?.[key];
        },
        async keys() {
          return Object.keys(config.cloudflare ?? {});
        },
      };

    case 'vercel':
      return {
        async get(key: string) {
          // Dynamic import for Vercel Edge Config
          // In production: `import { get } from '@vercel/edge-config'`
          // This is a framework-level interface; the actual import
          // is resolved by the adapter at deploy time.
          throw new Error(`Vercel Edge Config: implement get('${key}') in adapter`);
        },
        async keys() {
          throw new Error('Vercel Edge Config: implement keys() in adapter');
        },
      };

    case 'deno':
      return {
        async get(key: string) {
          // Deno KV: `const kv = await Deno.openKv(); await kv.get([key])`
          throw new Error(`Deno KV: implement get('${key}') in adapter`);
        },
        async keys() {
          throw new Error('Deno KV: implement keys() in adapter');
        },
      };

    default:
      return {
        async get() { return undefined; },
        async keys() { return []; },
      };
  }
}

// ---------------------------------------------------------------------------
// 178. Edge rate limiting
// ---------------------------------------------------------------------------

export interface EdgeRateLimitConfig {
  /** Requests per window */
  limit: number;
  /** Window in seconds */
  windowSeconds: number;
  /** Key to limit by: 'ip', 'user', or custom */
  keyBy: 'ip' | 'user' | ((req: Request) => string);
  /** Backend for distributed state */
  backend?: 'cloudflare-do' | 'vercel-edge-config' | 'upstash-redis';
  /** Upstash Redis URL (if using Upstash) */
  upstashUrl?: string;
  /** Upstash Redis token (if using Upstash) */
  upstashToken?: string;
}

export interface RateLimitResult {
  limited: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * In-memory edge rate limiter (single-instance fallback).
 * For distributed rate limiting, use Cloudflare Durable Objects, Vercel Edge Config,
 * or Upstash Redis backends.
 */
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

/** Cap on the number of tracked buckets, to bound memory on a unique-key flood. */
const MAX_RATE_LIMIT_BUCKETS = 50000;

/**
 * Evict expired buckets; if still over the cap, drop the oldest entries.
 * Without this, a distributed scan with unique IPs grows the map until the
 * isolate runs out of memory.
 */
function evictRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt < now) rateLimitBuckets.delete(key);
  }
  if (rateLimitBuckets.size <= MAX_RATE_LIMIT_BUCKETS) return;
  const overflow = rateLimitBuckets.size - MAX_RATE_LIMIT_BUCKETS;
  let removed = 0;
  for (const key of rateLimitBuckets.keys()) {
    if (removed >= overflow) break;
    rateLimitBuckets.delete(key); // Map preserves insertion order → oldest first.
    removed++;
  }
}

export function checkEdgeRateLimit(
  identifier: string,
  config: EdgeRateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;
  const bucket = rateLimitBuckets.get(identifier);

  if (!bucket || bucket.resetAt < now) {
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) evictRateLimitBuckets(now);
    rateLimitBuckets.set(identifier, { count: 1, resetAt: now + windowMs });
    return { limited: false, limit: config.limit, remaining: config.limit - 1, resetAt: now + windowMs };
  }

  bucket.count++;
  const limited = bucket.count > config.limit;

  return {
    limited,
    limit: config.limit,
    remaining: Math.max(0, config.limit - bucket.count),
    resetAt: bucket.resetAt,
  };
}

/**
 * Creates rate limit headers for the response.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}

/**
 * Extracts the rate limit identifier from a request.
 */
export function getRateLimitIdentifier(req: Request, config: EdgeRateLimitConfig): string {
  if (typeof config.keyBy === 'function') return config.keyBy(req);
  if (config.keyBy === 'user') {
    const auth = req.headers.get('authorization') ?? '';
    return `user:${auth.slice(0, 20)}`;
  }
  const cfIp = req.headers.get('cf-connecting-ip') ?? '';
  const xForwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return `ip:${cfIp || xForwarded || 'unknown'}`;
}

// ---------------------------------------------------------------------------
// 179. Edge auth validation — JWT verification at edge
// ---------------------------------------------------------------------------

export interface EdgeJwtConfig {
  /** JWKS URI for key rotation */
  jwksUri: string;
  /** Issuer to validate */
  issuer?: string;
  /** Audience to validate */
  audience?: string;
  /** Cache TTL for JWKS in seconds (default: 3600) */
  cacheTtl?: number;
  /**
   * Algorithms permitted for the token's `alg` header. Defaults to
   * ['RS256', 'ES256']. Restricting this prevents algorithm-confusion attacks.
   */
  algorithms?: EdgeJwtAlgorithm[];
}

export type EdgeJwtAlgorithm = 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';

/** Decode a base64url string to raw bytes (Web-Crypto/edge-safe). */
function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Decode a base64url string to a UTF-8 string. */
function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

/** Map a JWS alg to its Web Crypto import + verify parameters. */
function webCryptoAlgParams(alg: EdgeJwtAlgorithm):
  | { importAlgo: RsaHashedImportParams | EcKeyImportParams; verifyAlgo: AlgorithmIdentifier | EcdsaParams }
  | null {
  switch (alg) {
    case 'RS256': return { importAlgo: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyAlgo: 'RSASSA-PKCS1-v1_5' };
    case 'RS384': return { importAlgo: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verifyAlgo: 'RSASSA-PKCS1-v1_5' };
    case 'RS512': return { importAlgo: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verifyAlgo: 'RSASSA-PKCS1-v1_5' };
    case 'ES256': return { importAlgo: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlgo: { name: 'ECDSA', hash: 'SHA-256' } };
    case 'ES384': return { importAlgo: { name: 'ECDSA', namedCurve: 'P-384' }, verifyAlgo: { name: 'ECDSA', hash: 'SHA-384' } };
    case 'ES512': return { importAlgo: { name: 'ECDSA', namedCurve: 'P-521' }, verifyAlgo: { name: 'ECDSA', hash: 'SHA-512' } };
    default: return null;
  }
}

interface CachedJwks {
  keys: Record<string, JsonWebKey>;
  expiresAt: number;
}

// Cache keyed by JWKS URI. A single global cache would serve one issuer's keys
// for another issuer's tokens whenever a `kid` collides — so each distinct
// jwksUri (i.e. each issuer) gets its own cache entry.
const jwksCacheByUri = new Map<string, CachedJwks>();

/**
 * Fetches and caches JWKS keys with automatic rotation.
 */
export async function getJwks(config: EdgeJwtConfig): Promise<Record<string, JsonWebKey>> {
  const ttl = (config.cacheTtl ?? 3600) * 1000;
  const cached = jwksCacheByUri.get(config.jwksUri);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetch(config.jwksUri);
  const data = await response.json() as { keys: Array<{ kid: string } & JsonWebKey> };
  const keys: Record<string, JsonWebKey> = {};
  for (const key of data.keys) {
    keys[key.kid!] = key;
  }

  jwksCacheByUri.set(config.jwksUri, { keys, expiresAt: Date.now() + ttl });
  return keys;
}

/**
 * Verifies a JWT token at the edge using Web Crypto API.
 * No Node.js dependencies — uses native Web Crypto.
 */
export async function verifyEdgeJwt(
  token: string,
  config: EdgeJwtConfig,
): Promise<{ valid: boolean; payload?: Record<string, unknown>; error?: string }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, error: 'Invalid token format' };

    // Header and payload are base64URL — decode with URL-alphabet conversion,
    // not bare atob() (which throws on any '-' or '_' in the segment).
    const header = JSON.parse(base64UrlToString(parts[0]));
    const payload = JSON.parse(base64UrlToString(parts[1]));

    // Validate the algorithm against the allow-list before doing anything else
    // (alg-confusion prevention). The verify algorithm is derived from the
    // token's declared alg only after it passes this gate.
    const allowed = config.algorithms ?? ['RS256', 'ES256'];
    if (!allowed.includes(header.alg)) {
      return { valid: false, error: `Algorithm ${header.alg} not allowed` };
    }
    const algParams = webCryptoAlgParams(header.alg);
    if (!algParams) return { valid: false, error: 'Unsupported algorithm' };

    if (config.issuer && payload.iss !== config.issuer) {
      return { valid: false, error: 'Invalid issuer' };
    }
    if (config.audience && payload.aud !== config.audience) {
      return { valid: false, error: 'Invalid audience' };
    }
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { valid: false, error: 'Token expired' };
    }

    const keys = await getJwks(config);
    const key = keys[header.kid];
    if (!key) return { valid: false, error: 'Key not found in JWKS' };

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      algParams.importAlgo,
      false,
      ['verify'],
    );

    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBytes(parts[2]);
    const valid = await crypto.subtle.verify(
      algParams.verifyAlgo,
      cryptoKey,
      signature as unknown as BufferSource,
      data as unknown as BufferSource,
    );

    return valid
      ? { valid: true, payload }
      : { valid: false, error: 'Signature verification failed' };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Verification error' };
  }
}

// ---------------------------------------------------------------------------
// 180. Edge CSP generation — per-request nonce
// ---------------------------------------------------------------------------

export interface EdgeCspConfig {
  /** Default directives */
  defaultSrc?: string;
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  connectSrc?: string[];
  fontSrc?: string[];
  objectSrc?: string;
  baseUri?: string;
  /** Whether to generate per-request nonces */
  nonceEnabled?: boolean;
  /** Whether to enable report-only mode */
  reportOnly?: boolean;
  /** Report endpoint */
  reportUri?: string;
}

/**
 * Generates a per-request CSP nonce for edge rendering.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Builds a CSP header value from config and optional nonce.
 */
export function buildEdgeCsp(config: EdgeCspConfig, nonce?: string): string {
  const directives: string[] = [];

  directives.push(`default-src ${config.defaultSrc ?? "'self'"}`);
  directives.push(`object-src ${config.objectSrc ?? "'none'"}`);
  directives.push(`base-uri ${config.baseUri ?? "'self'"}`);

  const scriptSrc = [...(config.scriptSrc ?? ["'self'"])];
  if (nonce) scriptSrc.push(`'nonce-${nonce}'`);
  directives.push(`script-src ${scriptSrc.join(' ')}`);

  const styleSrc = [...(config.styleSrc ?? ["'self'"])];
  if (nonce) styleSrc.push(`'nonce-${nonce}'`);
  directives.push(`style-src ${styleSrc.join(' ')}`);

  if (config.imgSrc) directives.push(`img-src ${config.imgSrc.join(' ')}`);
  if (config.connectSrc) directives.push(`connect-src ${config.connectSrc.join(' ')}`);
  if (config.fontSrc) directives.push(`font-src ${config.fontSrc.join(' ')}`);
  if (config.reportUri) directives.push(`report-uri ${config.reportUri}`);

  return directives.join('; ');
}

/**
 * Generates CSP headers for an edge response.
 */
export function edgeCspHeaders(config: EdgeCspConfig): { headers: Record<string, string>; nonce: string } {
  const nonce = config.nonceEnabled !== false ? generateCspNonce() : '';
  const csp = buildEdgeCsp(config, nonce || undefined);
  const headerName = config.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  return { headers: { [headerName]: csp }, nonce };
}

// ---------------------------------------------------------------------------
// 181. Edge geo-restriction
// ---------------------------------------------------------------------------

export interface GeoRestrictionConfig {
  /** Mode: 'block' blocks listed countries, 'allow' only allows listed countries */
  mode: 'block' | 'allow';
  /** ISO country codes */
  countries: string[];
  /** Custom message for blocked requests */
  blockMessage?: string;
}

/**
 * Extracts the country code from edge request headers.
 * Supports Cloudflare (CF-IPCountry) and Vercel (X-Vercel-IP-Country).
 */
export function getCountryCode(req: Request): string | null {
  return req.headers.get('cf-ipcountry')
    ?? req.headers.get('x-vercel-ip-country')
    ?? req.headers.get('x-cloudflare-ipcountry')
    ?? null;
}

/**
 * Checks if a request should be allowed based on geo-restriction config.
 */
export function checkGeoRestriction(req: Request, config: GeoRestrictionConfig): {
  allowed: boolean;
  country: string | null;
} {
  const country = getCountryCode(req);
  if (!country) {
    // No country header. Fail in the safe direction for each mode:
    // - 'allow' (allowlist): we cannot confirm the request is from a permitted
    //   country, so deny (fail closed). Otherwise stripping/spoofing away the
    //   country header would bypass the allowlist entirely.
    // - 'block' (blocklist): we cannot confirm it's a blocked country, so allow.
    return { allowed: config.mode !== 'allow', country: null };
  }

  const inList = config.countries.includes(country);
  const allowed = config.mode === 'block' ? !inList : inList;
  return { allowed, country };
}

/**
 * Creates a geo-restriction response for blocked requests.
 */
export function geoBlockResponse(config: GeoRestrictionConfig): Response {
  return new Response(
    JSON.stringify({ error: config.blockMessage ?? 'Access restricted in your region' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// 182. Edge bot mitigation
// ---------------------------------------------------------------------------

const BOT_USER_AGENTS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i, /curl/i, /wget/i,
  /python-requests/i, /go-http-client/i, /java\//i, /okhttp/i,
  /googlebot/i, /bingbot/i, /yandexbot/i, /baiduspider/i,
  /semrush/i, /ahrefs/i, /dotbot/i, /rogerbot/i,
];

const CHALLENGE_BOTS = [
  /curl/i, /wget/i, /python-requests/i, /go-http-client/i, /okhttp/i,
];

export interface BotCheckResult {
  isBot: boolean;
  shouldChallenge: boolean;
  confidence: number;
}

/**
 * Detects bots at the edge using User-Agent heuristics.
 */
export function detectBot(req: Request): BotCheckResult {
  const ua = req.headers.get('user-agent') ?? '';
  if (!ua) return { isBot: true, shouldChallenge: true, confidence: 0.9 };

  const isBot = BOT_USER_AGENTS.some((pattern) => pattern.test(ua));
  const shouldChallenge = CHALLENGE_BOTS.some((pattern) => pattern.test(ua));

  let confidence = 0;
  if (isBot) confidence = 0.7;
  if (shouldChallenge) confidence = 0.9;

  // Check for missing common browser headers
  const accept = req.headers.get('accept') ?? '';
  const acceptLanguage = req.headers.get('accept-language') ?? '';
  if (isBot && !acceptLanguage) confidence += 0.1;
  if (isBot && !accept.includes('text/html')) confidence += 0.1;

  return { isBot, shouldChallenge, confidence: Math.min(confidence, 1) };
}

/**
 * Generates a challenge page for suspicious requests.
 */
export function botChallengePage(): string {
  return `<!DOCTYPE html>
<html><head><title>Verifying...</title>
<script>
  // Simple JS challenge — bots without JS execution will fail
  document.cookie = "_pledge_bot=1; path=/; max-age=3600";
  location.reload();
</script>
<noscript>Please enable JavaScript to continue.</noscript>
</head><body><p>Verifying you are not a bot...</p></body></html>`;
}

// ---------------------------------------------------------------------------
// 183. Cold start optimization
// ---------------------------------------------------------------------------

export interface ColdStartConfig {
  /** Modules to pre-warm on startup */
  prewarmModules?: string[];
  /** Whether to lazy-load non-critical modules */
  lazyLoadNonCritical?: boolean;
  /** Critical path modules that must be eagerly loaded */
  criticalModules?: string[];
  /** Max bundle size for edge (KB) */
  maxBundleSizeKb?: number;
}

/**
 * Pre-warms critical modules to reduce cold start time.
 * Called during edge worker initialization.
 */
export async function prewarmEdgeModules(config: ColdStartConfig): Promise<void> {
  const modules = config.criticalModules ?? [];
  for (const mod of modules) {
    try {
      await import(mod);
    } catch {
      // Module not available — skip silently
    }
  }
}

/**
 * Analyzes bundle size and returns optimization recommendations.
 */
export function analyzeColdStart(
  bundleSizeBytes: number,
  config: ColdStartConfig = {},
): { optimized: boolean; sizeKb: number; recommendations: string[] } {
  const sizeKb = Math.round(bundleSizeBytes / 1024);
  const maxKb = config.maxBundleSizeKb ?? 1024; // 1MB default for edge
  const recommendations: string[] = [];

  if (sizeKb > maxKb) {
    recommendations.push(`Bundle size ${sizeKb}KB exceeds limit ${maxKb}KB — consider code splitting`);
  }
  if (config.lazyLoadNonCritical !== false) {
    recommendations.push('Lazy-load non-critical modules with dynamic import()');
  }
  if (!config.criticalModules?.length) {
    recommendations.push('Define criticalModules to pre-warm on cold start');
  }

  return {
    optimized: sizeKb <= maxKb,
    sizeKb,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// 184. Edge timeout enforcement
// ---------------------------------------------------------------------------

export interface EdgeTimeoutConfig {
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Whether to include response streaming in timeout */
  includeStreaming?: boolean;
  /** Custom timeout message */
  message?: string;
}

/**
 * Wraps an edge handler with timeout enforcement.
 * Returns a 504 Gateway Timeout if the handler exceeds the timeout.
 */
export function withEdgeTimeout(
  handler: (req: Request) => Promise<Response>,
  config: EdgeTimeoutConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await Promise.race([
        handler(req),
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('EDGE_TIMEOUT'));
          });
        }),
      ]);
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.message === 'EDGE_TIMEOUT') {
        return new Response(
          JSON.stringify({ error: config.message ?? 'Gateway Timeout' }),
          { status: 504, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw err;
    }
  };
}

/**
 * Creates a timeout signal for use in fetch calls within edge handlers.
 */
export function createEdgeTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
