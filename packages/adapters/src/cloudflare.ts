import { createEdgeHandler } from 'pledgestack-server';
import type { PledgeConfig } from 'pledgestack-shared';
import { createEdgeConfig, type EdgeBundleConfig } from './index';
import { checkEdgeRateLimit, detectBot, checkGeoRestriction, edgeCspHeaders } from './edge-security';
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

export interface CloudflareEnv {
  [key: string]: string | { fetch: (request: Request) => Promise<Response> } | undefined;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  /** Cloudflare KV binding for edge cache */
  CACHE?: unknown;
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

      // Try static assets first (Cloudflare Pages)
      if (env?.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) return assetResponse;
      }

      // Edge security: rate limiting
      if (config.rateLimit) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const rateLimitConfig = typeof config.rateLimit === 'object' ? config.rateLimit : {};
        const rateResult = checkEdgeRateLimit(ip, rateLimitConfig.maxTokens ?? 100, rateLimitConfig.refillRate ?? 10);
        if (!rateResult.allowed) {
          return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rateResult.retryAfterMs / 1000)) },
          });
        }
      }

      // Edge security: bot detection
      if (config.botDetection) {
        const botResult = detectBot({
          userAgent: request.headers.get('user-agent') ?? '',
          method: request.method,
          path: new URL(request.url).pathname,
        });
        if (botResult.isBot && botResult.shouldChallenge) {
          return new Response(JSON.stringify({ error: 'Bot detected' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Edge security: geo restrictions (Cloudflare provides cf-ipcountry header)
      if (config.i18n?.locales) {
        const country = request.headers.get('cf-ipcountry') ?? '';
        const geoResult = checkGeoRestriction(country, []);
        if (geoResult.blocked) {
          return new Response(JSON.stringify({ error: 'Access restricted in your region' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Fall through to PledgeStack edge handler
      const response = await handler(request);

      // Apply CSP headers
      const csp = edgeCspHeaders();
      const finalHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(csp)) {
        if (!finalHeaders.has(key)) finalHeaders.set(key, value);
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
