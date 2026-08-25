import { createEdgeHandler } from 'pledgestack-server';
import type { PledgeConfig } from 'pledgestack-shared';
import { createEdgeConfig, type EdgeBundleConfig } from './index';

export { createEdgeConfig, type EdgeBundleConfig };

/**
 * Netlify adapter for PledgeStack.
 *
 * PledgePack generates a bundle for Netlify Functions. This adapter provides
 * the Netlify Function handler that converts Netlify events to Request/Response.
 *
 * Usage — PledgePack generates this as the Netlify entry:
 * ```typescript
 * import { createNetlifyHandler } from 'pledgestack-adapters/netlify';
 *
 * export default createNetlifyHandler({ config });
 * ```
 *
 * netlify.toml:
 * ```toml
 * [build]
 * command = "pledgestack build"
 * publish = ".pledge/static"
 *
 * [[redirects]]
 * from = "/*"
 * to = "/.netlify/functions/pledge"
 * status = 200
 * ```
 */

export interface NetlifyEvent {
  httpMethod: string;
  path: string;
  queryStringParameters?: Record<string, string>;
  headers: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface NetlifyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
  /** Multi-value headers — used to emit multiple Set-Cookie headers. */
  multiValueHeaders?: Record<string, string[]>;
}

export function createNetlifyHandler(options: { config: PledgeConfig }) {
  const handler = createEdgeHandler({ config: options.config });

  return async function netlifyHandler(event: NetlifyEvent): Promise<NetlifyResult> {
    // Derive the real host from the request headers. Hardcoding 'netlify.app'
    // made every same-origin POST fail CSRF validation (handler validates
    // against req.url.origin) and pointed middleware redirects at the wrong
    // host on any real Netlify site.
    const host = event.headers['host'] ?? event.headers['Host'] ?? event.headers['x-forwarded-host'] ?? 'localhost';
    const proto = event.headers['x-forwarded-proto'] ?? 'https';
    const url = new URL(event.path, `${proto}://${host}`);

    if (event.queryStringParameters) {
      for (const [key, value] of Object.entries(event.queryStringParameters)) {
        url.searchParams.set(key, value);
      }
    }

    // Decode base64-encoded request bodies (file uploads, binary content).
    const hasBody = event.body != null && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD';
    const body = hasBody
      ? (event.isBase64Encoded ? Buffer.from(event.body as string, 'base64') : (event.body as string))
      : undefined;

    const request = new Request(url.toString(), {
      method: event.httpMethod,
      headers: event.headers,
      body,
    });

    const response = await handler(request);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return; // via multiValueHeaders below
      headers[key] = value;
    });

    // Emit multiple Set-Cookie headers via multiValueHeaders (a single flat
    // header record would comma-join them into one broken cookie).
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];

    // Base64-encode binary responses so Netlify doesn't corrupt them as UTF-8.
    const contentType = headers['content-type'];
    const isText = !contentType
      || /^text\/|application\/(json|xml|javascript)|image\/svg|\+json|\+xml|x-www-form-urlencoded/i.test(contentType);
    let responseBody: string;
    let isBase64Encoded = false;
    if (isText) {
      responseBody = await response.text();
    } else {
      responseBody = Buffer.from(await response.arrayBuffer()).toString('base64');
      isBase64Encoded = true;
    }

    return {
      statusCode: response.status,
      headers,
      body: responseBody,
      ...(cookies.length > 0 ? { multiValueHeaders: { 'Set-Cookie': cookies } } : {}),
      ...(isBase64Encoded ? { isBase64Encoded: true } : {}),
    };
  };
}

/**
 * Generate netlify.toml configuration for PledgeStack.
 */
export function generateNetlifyConfig(options?: {
  buildCommand?: string;
  publishDir?: string;
  functionsDir?: string;
}): string {
  const buildCommand = options?.buildCommand ?? 'pledgestack build';
  const publishDir = options?.publishDir ?? '.pledge/static';
  const functionsDir = options?.functionsDir ?? '.pledge/functions';

  return `[build]
  command = "${buildCommand}"
  publish = "${publishDir}"
  functions = "${functionsDir}"

[[redirects]]
  from = "/*"
  to = "/.netlify/functions/pledge"
  status = 200

[build.environment]
  NODE_VERSION = "20"`;
}

export function getNetlifyEdgeConfig(): EdgeBundleConfig {
  return createEdgeConfig('netlify');
}
