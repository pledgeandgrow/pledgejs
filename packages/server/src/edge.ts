import type { PledgeConfig } from 'pledgestack-shared';
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

    // Read the request body for methods that can carry one. Without this, every
    // edge adapter delivered POST/PUT/PATCH with an empty body — server actions
    // saw no args and API routes received a bodyless request.
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await request.text();
    }

    const result = await handler({ url, method, headers, body });

    // Apply security headers to edge responses
    const isHttps = url.protocol === 'https:' || headers['x-forwarded-proto'] === 'https';
    const finalHeaders = applySecurityHeaders({ ...result.headers }, config, isHttps);

    return new Response(result.body, {
      status: result.status,
      headers: finalHeaders,
    });
  };
}
