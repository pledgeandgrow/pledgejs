import { createEdgeHandler } from 'pledgestack-server';
import type { PledgeConfig } from 'pledgestack-shared';
import { createEdgeConfig, type EdgeBundleConfig } from './index';

export { createEdgeConfig, type EdgeBundleConfig };

/**
 * AWS Lambda adapter for PledgeStack.
 *
 * PledgePack generates a Node.js bundle for Lambda. This adapter provides
 * the Lambda handler that converts API Gateway events to Request/Response.
 *
 * Usage — PledgePack generates this as the Lambda entry:
 * ```typescript
 * import { createLambdaHandler } from 'pledgestack-adapters/lambda';
 *
 * export const handler = createLambdaHandler({ config });
 * ```
 */

/** REST API / API Gateway proxy integration payload (format version 1.0). */
export interface APIGatewayEventV1 {
  version?: '1.0';
  httpMethod: string;
  path: string;
  queryStringParameters?: Record<string, string> | null;
  headers: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    domainName?: string;
    stage?: string;
  };
}

/**
 * HTTP API payload (format version 2.0) — this is what `generateSAMTemplate`'s
 * `HttpApi` event source actually sends by default, so it's the shape that
 * matters most, but v1 (REST API) is also supported below for users who wire
 * their own API Gateway REST API in front of this handler.
 */
export interface APIGatewayEventV2 {
  version: '2.0';
  rawPath: string;
  rawQueryString: string;
  /** HTTP API v2 delivers request cookies here, NOT in `headers`. */
  cookies?: string[];
  headers: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    domainName?: string;
    stage?: string;
    http: {
      method: string;
    };
  };
}

export type APIGatewayEvent = APIGatewayEventV1 | APIGatewayEventV2;

export interface APIGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
  /** HTTP API v2 multi-cookie field — one entry per Set-Cookie header. */
  cookies?: string[];
  /** REST API (v1) multi-value headers — carries repeated Set-Cookie headers. */
  multiValueHeaders?: Record<string, string[]>;
}

function isV2Event(event: APIGatewayEvent): event is APIGatewayEventV2 {
  return 'rawPath' in event;
}

/** Content types that are text and can be returned as a plain string. */
function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('application/json') ||
    ct.includes('application/xml') ||
    ct.includes('application/javascript') ||
    ct.includes('image/svg') ||
    ct.includes('+json') ||
    ct.includes('+xml') ||
    ct.includes('x-www-form-urlencoded')
  );
}

/** Encode a Response body for API Gateway, base64-encoding binary content. */
async function encodeLambdaBody(
  response: Response,
  contentType: string | undefined,
): Promise<{ body: string; isBase64Encoded: boolean }> {
  if (isTextContentType(contentType)) {
    return { body: await response.text(), isBase64Encoded: false };
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return { body: buf.toString('base64'), isBase64Encoded: true };
}

export function createLambdaHandler(options: { config: PledgeConfig }) {
  const handler = createEdgeHandler({ config: options.config });

  return async function lambdaHandler(event: APIGatewayEvent): Promise<APIGatewayResult> {
    let method: string;
    let rawPath: string;
    let queryString: string;
    let domain: string;
    let stage: string;

    if (isV2Event(event)) {
      method = event.requestContext.http.method;
      rawPath = event.rawPath;
      queryString = event.rawQueryString ?? '';
      domain = event.requestContext.domainName ?? 'localhost';
      stage = event.requestContext.stage ?? 'production';
    } else {
      method = event.httpMethod;
      rawPath = event.path;
      queryString = new URLSearchParams(event.queryStringParameters ?? {}).toString();
      domain = event.requestContext?.domainName ?? 'localhost';
      stage = event.requestContext?.stage ?? 'production';
    }

    // Use the app-relative path for routing. The stage name is an API Gateway
    // concern, not an app route — prepending it produced `/prod/about` (which
    // never matches the app's `/about` route). For HTTP API v2 `rawPath`
    // already contains the stage on a named stage, so strip it when present
    // rather than prepend it again (the old code double-prefixed to
    // `/prod/prod/about` and 404'd).
    let path = rawPath;
    if (stage && stage !== '$default') {
      if (path === `/${stage}`) path = '/';
      else if (path.startsWith(`/${stage}/`)) path = path.slice(stage.length + 1);
    }
    // Concatenate instead of new URL(path, base): a path like "//evil.example/x"
    // is protocol-relative and would REPLACE the host.
    const url = new URL(`https://${domain}${path.startsWith('/') ? '' : '/'}${path}`);
    if (queryString) url.search = queryString;

    const hasBody = event.body != null && method !== 'GET' && method !== 'HEAD';
    const body = hasBody
      ? (event.isBase64Encoded ? Buffer.from(event.body as string, 'base64') : (event.body as string))
      : undefined;

    const requestHeaders = new Headers(event.headers);
    // HTTP API v2 strips the Cookie header and lists the cookies separately;
    // without this the app never sees session/CSRF cookies.
    if (isV2Event(event) && event.cookies && event.cookies.length > 0 && !requestHeaders.has('cookie')) {
      requestHeaders.set('cookie', event.cookies.join('; '));
    }

    const request = new Request(url.toString(), {
      method,
      headers: requestHeaders,
      body,
    });

    const response = await handler(request);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return; // handled via `cookies` below
      headers[key] = value;
    });

    // Multiple Set-Cookie headers must be carried in the HTTP API v2 `cookies`
    // array; forEach/entries would otherwise comma-join them into one broken
    // header. (getSetCookie returns each cookie separately.)
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];

    // Binary responses (e.g. OG images) must be base64-encoded and flagged, or
    // API Gateway mangles them by treating the bytes as UTF-8 text.
    const { body: responseBody, isBase64Encoded } = await encodeLambdaBody(response, headers['content-type']);

    return {
      statusCode: response.status,
      headers,
      body: responseBody,
      // v2 takes a `cookies` array; v1 (REST API) ignores it and needs
      // multiValueHeaders, otherwise every Set-Cookie is silently dropped.
      ...(cookies.length > 0
        ? isV2Event(event) ? { cookies } : { multiValueHeaders: { 'Set-Cookie': cookies } }
        : {}),
      ...(isBase64Encoded ? { isBase64Encoded: true } : {}),
    };
  };
}

/**
 * Generate SAM template for PledgeStack on Lambda.
 */
export function generateSAMTemplate(options?: {
  functionName?: string;
  runtime?: string;
  memorySize?: number;
  timeout?: number;
}): Record<string, unknown> {
  return {
    Resources: {
      PledgeFunction: {
        Type: 'AWS::Serverless::Function',
        Properties: {
          FunctionName: options?.functionName ?? 'pledgestack',
          Runtime: options?.runtime ?? 'nodejs20.x',
          MemorySize: options?.memorySize ?? 512,
          Timeout: options?.timeout ?? 10,
          Handler: 'index.handler',
          CodeUri: '.pledge/lambda/',
          Events: {
            Proxy: {
              Type: 'HttpApi',
              Properties: {
                Path: '/{proxy+}',
                Method: 'ANY',
              },
            },
          },
        },
      },
    },
  };
}

export function getLambdaEdgeConfig(): EdgeBundleConfig {
  return createEdgeConfig('lambda', { excludeNodeBuiltins: false });
}
