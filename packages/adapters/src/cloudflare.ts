import { createEdgeHandler } from 'pledgestack-server';
import type { PledgeConfig } from 'pledgestack-shared';
import { createEdgeConfig, type EdgeBundleConfig } from './index';
import { checkEdgeRateLimit, detectBot, checkGeoRestriction } from './edge-security';
import { createKvAdapter, type KvAdapter } from 'pledgestack-core';

export { createEdgeConfig, type EdgeBundleConfig };

/**
 * Cloudflare Workers adapter for PledgeStack.
 *
 * PledgePack generates an edge-safe bundle. This adapter provides the
 * Cloudflare Workers entry point that wraps PledgeStack's edge handler.
 * Includes edge security: rate limiting, bot detection, geo restrictions, CSP.
 *
 * Usage in wrangler.toml:
 * ```toml
 * [build]
 * command = "pledgestack build --edge cloudflare"
 * ```
 */

/** Minimal Cloudflare KV namespace binding shape (see @cloudflare/workers-types for the full type). */
export interface CloudflareKvNamespace {
  get(key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'stream' }): Promise<unknown>;
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

export interface CloudflareEnv {
  [key: string]: string | { fetch: (request: Request) => Promise<Response> } | CloudflareKvNamespace | undefined;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  /** Cloudflare KV binding for edge cache */
  CACHE?: CloudflareKvNamespace;
}

export function createCloudflareAdapter(config: PledgeConfig) {
  const handler = createEdgeHandler({ config });
  let kvAdapter: KvAdapter | null = null;

  return {
    /** Cloudflare Workers fetch handler */
    async fetch(request: Request, env?: CloudflareEnv): Promise<Response> {
      // Initialize KV adapter from Cloudflare binding (once)
      if (!kvAdapter && env?.CACHE) {
        try {
          kvAdapter = createKvAdapter({
            platform: 'cloudflare',
            binding: env.CACHE,
            namespace: 'pledgestack',
          });
        } catch {
          // KV binding not available — continue without edge cache
        }
      }

      // Edge security runs BEFORE static asset serving. Previously assets were
      // served first, so any path handled by Cloudflare Pages assets bypassed
      // rate limiting, bot detection, and geo restriction entirely.

      // Edge security: rate limiting
      if (config.rateLimit) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const rateLimitConfig = typeof config.rateLimit === 'object' ? config.rateLimit : {};
        const maxTokens = rateLimitConfig.maxTokens ?? 100;
        const refillRate = rateLimitConfig.refillRate ?? 10;
        // checkEdgeRateLimit uses a fixed-window model (limit/windowSeconds), while
        // PledgeConfig.rateLimit describes a token bucket (maxTokens/refillRate) —
        // approximate the window as the time to fully refill the bucket.
        const rateResult = checkEdgeRateLimit(ip, {
          limit: maxTokens,
          windowSeconds: Math.max(1, Math.ceil(maxTokens / refillRate)),
          keyBy: 'ip',
        });
        if (rateResult.limited) {
          const retryAfterSeconds = Math.max(0, Math.ceil((rateResult.resetAt - Date.now()) / 1000));
          return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) },
          });
        }
      }

      // Edge security: bot detection
      if (config.botDetection) {
        const botResult = detectBot(request);
        if (botResult.isBot && botResult.shouldChallenge) {
          return new Response(JSON.stringify({ error: 'Bot detected' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Edge security: geo restrictions (Cloudflare provides cf-ipcountry header)
      if (config.geoRestriction) {
        const geoResult = checkGeoRestriction(request, config.geoRestriction);
        if (!geoResult.allowed) {
          return new Response(JSON.stringify({ error: config.geoRestriction.blockMessage ?? 'Access restricted in your region' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Static assets (Cloudflare Pages) — after the security checks above.
      if (env?.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) return assetResponse;
      }

      // Fall through to PledgeStack edge handler
      const response = await handler(request);

      const finalHeaders = new Headers(response.headers);
      // Apply CSP only when the app configured one. `config.csp` is a directive
      // map (e.g. { 'script-src': "'self'" }); build the header from it directly.
      // The previous code called edgeCspHeaders({}) — ignoring config.csp and
      // emitting a per-request nonce that appears in no <script> tag, which
      // caused the browser to block every inline script in the SSR HTML.
      if (config.csp && Object.keys(config.csp).length > 0) {
        const cspValue = Object.entries(config.csp)
          .map(([directive, value]) => `${directive} ${value}`.trim())
          .join('; ');
        if (!finalHeaders.has('Content-Security-Policy')) {
          finalHeaders.set('Content-Security-Policy', cspValue);
        }
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: finalHeaders,
      });
    },

    /** Get the edge bundle config for PledgePack */
    getEdgeConfig(): EdgeBundleConfig {
      return createEdgeConfig('cloudflare');
    },
  };
}
