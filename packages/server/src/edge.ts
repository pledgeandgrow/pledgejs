import type { PledgeConfig } from 'pledgestack-shared';
import { inlineScriptHashes } from 'pledgestack-shared';
import { createRequestHandler } from './handler';
import { loadInstrumentation } from './instrumentation';
import { applySecurityHeaders } from './security-headers';

export interface EdgeServerOptions {
  config: PledgeConfig;
}

/**
 * Creates an edge-compatible request handler for PledgeStack.
 * Works with Cloudflare Workers, Vercel Edge, Deno Deploy, etc.
 *
 * Applies security headers to all responses (same as Node.js server).
 */
export function createEdgeHandler(options: EdgeServerOptions) {
  const { config } = options;
  const { handler } = createRequestHandler({ config, isDev: false });

  loadInstrumentation(config, null, false).catch((err) => {
    console.error('[pledgestack] Instrumentation failed:', err);
  });

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Read the request body for methods that can carry one. Enforce a max
    // size to prevent memory exhaustion (default 1MB).
    const MAX_BODY_SIZE = parseInt(process.env.PLEDGE_MAX_BODY_SIZE ?? '1048576', 10);
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const text = await request.text();
      if (text.length > MAX_BODY_SIZE) {
        return new Response('Request body too large', { status: 413 });
      }
      body = text;
    }

    try {
      const result = await handler({ url, method, headers, body });

      // Apply security headers to edge responses. On edge platforms
      // request.url is the real URL — don't honor a client-supplied
      // x-forwarded-proto claim.
      const isHttps = url.protocol === 'https:';
      // No per-request nonce on ISR/prerendered responses — hash the frozen
      // inline scripts for CSP instead of falling back to 'unsafe-inline'.
      const edgeContentType = result.headers?.['Content-Type']
        ?? result.headers?.['content-type'];
      const scriptHashes = !result.cspNonce
        && typeof result.body === 'string'
        && typeof edgeContentType === 'string'
        && edgeContentType.includes('text/html')
          ? await inlineScriptHashes(result.body)
          : undefined;
      const finalHeaders = new Headers(applySecurityHeaders({ ...result.headers }, config, isHttps, {
        cspNonce: result.cspNonce,
        scriptHashes,
        reportOnly: config.cspReportOnly === true,
        reportUri: '/__pledge__/csp-report',
      }));
      // Append each Set-Cookie individually (a Headers object preserves multiple).
      if (result.cookies) {
        for (const cookie of result.cookies) finalHeaders.append('Set-Cookie', cookie);
      }

      // Handle base64-encoded binary content (OG images, downloads) — the
      // Node server decodes these but the edge handler previously didn't,
      // returning corrupted/empty bodies for binary responses.
      let responseBody: BodyInit | null = null;
      if (typeof result.body === 'string') {
        if (result.isBase64) {
          // Decode base64 to binary for edge Response
          const binary = atob(result.body);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          responseBody = bytes;
        } else {
          responseBody = result.body;
        }
      } else if (result.body) {
        responseBody = result.body;
      }

      return new Response(responseBody, {
        status: result.status,
        headers: finalHeaders,
      });
    } catch (err) {
      console.error('[pledgestack] Edge handler error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}
