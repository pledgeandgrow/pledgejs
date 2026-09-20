/**
 * Request ID propagation — auto-generates X-Request-Id headers and
 * propagates them to all logs, traces, and downstream fetch calls.
 *
 * Pairs with the OpenTelemetry tracing module (#88) to provide
 * end-to-end request correlation.
 */

import { randomUUID } from 'node:crypto';

/** Header name for request ID */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** AsyncLocalStorage for request-scoped request ID */
import { AsyncLocalStorage } from 'node:async_hooks';

const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Get the current request ID from the async context.
 */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * Generate a new request ID.
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Extract request ID from incoming headers, or generate a new one.
 */
export function resolveRequestId(headers: Record<string, string>): string {
  // Check for incoming request ID (from upstream proxy/gateway)
  // Client-supplied ids end up in logs and response headers — accept only a
  // safe token so a crafted value can't inject log lines or header content.
  const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
  const incoming = headers[REQUEST_ID_HEADER.toLowerCase()] ?? headers[REQUEST_ID_HEADER];
  if (incoming && typeof incoming === 'string' && SAFE_ID.test(incoming)) {
    return incoming;
  }

  return generateRequestId();
}

/**
 * Run a function with a request-scoped request ID.
 * The ID is available via getRequestId() within the callback.
 */
export function withRequestId<T>(
  requestId: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return requestIdStorage.run(requestId, fn);
}

/**
 * Middleware to add request ID propagation.
 * Generates or extracts a request ID and adds it to response headers.
 */
export function requestIdMiddleware() {
  return {
    name: 'pledgestack-request-id',
    onRequest(req: { headers: Record<string, string> }): { requestId: string } {
      const requestId = resolveRequestId(req.headers);
      return { requestId };
    },
    onResponse(
      requestId: string,
      headers: Record<string, string>,
    ): Record<string, string> {
      return {
        ...headers,
        [REQUEST_ID_HEADER]: requestId,
      };
    },
  };
}

/**
 * Wrap a fetch call to propagate the current request ID.
 * Adds X-Request-Id header to outgoing requests if a request ID is in context.
 */
export function fetchWithRequestId(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const requestId = getRequestId();
  if (requestId) {
    const headers = new Headers(init.headers);
    if (!headers.has(REQUEST_ID_HEADER)) {
      headers.set(REQUEST_ID_HEADER, requestId);
    }
    init.headers = headers;
  }
  return globalThis.fetch(url, init);
}
