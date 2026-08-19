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
}

function isV2Event(event: APIGatewayEvent): event is APIGatewayEventV2 {
  return 'rawPath' in event;
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

    const path = stage === '$default' ? rawPath : `/${stage}${rawPath}`;
    const url = new URL(path, `https://${domain}`);
    if (queryString) url.search = queryString;

    const hasBody = event.body != null && method !== 'GET' && method !== 'HEAD';
    const body = hasBody
      ? (event.isBase64Encoded ? Buffer.from(event.body as string, 'base64') : (event.body as string))
      : undefined;

    const request = new Request(url.toString(), {
      method,
      headers: event.headers,
      body,
    });

    const response = await handler(request);
    const responseBody = await response.text();

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      statusCode: response.status,
      headers,
      body: responseBody,
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
