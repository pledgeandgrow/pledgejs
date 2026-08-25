import type { PledgeResponse } from 'pledgestack-shared';

export type ResponseContentType =
  | 'application/json'
  | 'text/html'
  | 'text/plain'
  | 'text/csv'
  | 'application/xml'
  | 'application/octet-stream'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/svg+xml'
  | 'application/pdf';

interface TypedResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

const CONTENT_TYPE_MAP: Record<string, ResponseContentType> = {
  json: 'application/json',
  html: 'text/html',
  text: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  binary: 'application/octet-stream',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

const BODY_TYPE_EXPECTATIONS: Record<ResponseContentType, 'string' | 'object' | 'binary'> = {
  'application/json': 'string',
  'text/html': 'string',
  'text/plain': 'string',
  'text/csv': 'string',
  'application/xml': 'string',
  'application/octet-stream': 'binary',
  'image/png': 'binary',
  'image/jpeg': 'binary',
  'image/webp': 'binary',
  'image/svg+xml': 'string',
  'application/pdf': 'binary',
};

/**
 * Type-safe JSON response helper.
 * Ensures Content-Type is application/json and body is serialized correctly.
 */
export function json<T>(data: T, init?: TypedResponseInit): PledgeResponse {
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...init?.headers,
    },
    body: JSON.stringify(data),
  };
}

/**
 * Type-safe HTML response helper.
 * Ensures Content-Type is text/html.
 */
export function html(body: string, init?: TypedResponseInit): PledgeResponse {
  assertBodyType('text/html', body);
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...init?.headers,
    },
    body,
  };
}

/**
 * Type-safe plain text response helper.
 */
export function text(body: string, init?: TypedResponseInit): PledgeResponse {
  assertBodyType('text/plain', body);
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...init?.headers,
    },
    body,
  };
}

/**
 * Type-safe CSV response helper.
 */
export function csv(body: string, init?: TypedResponseInit): PledgeResponse {
  assertBodyType('text/csv', body);
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': init?.headers?.['Content-Disposition'] ?? 'attachment; filename="export.csv"',
      ...init?.headers,
    },
    body,
  };
}

/**
 * Type-safe XML response helper.
 */
export function xml(body: string, init?: TypedResponseInit): PledgeResponse {
  assertBodyType('application/xml', body);
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      ...init?.headers,
    },
    body,
  };
}

/**
 * Binary response helper for file downloads, images, etc.
 */
export function binary(body: string | ArrayBuffer | Uint8Array, contentType: ResponseContentType = 'application/octet-stream', init?: TypedResponseInit): PledgeResponse {
  // Binary bytes must be preserved, not stringified. The previous code turned an
  // ArrayBuffer into a comma-separated list of decimal byte values, and a
  // Uint8Array into mangled UTF-8 — corrupting every PNG/PDF/binary response.
  // Bytes are base64-encoded and flagged with isBase64 (PledgeResponse.body is
  // string | stream, so raw bytes are carried as base64).
  let responseBody: string;
  let isBase64 = false;
  if (typeof body === 'string') {
    responseBody = body;
  } else {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    responseBody = Buffer.from(bytes).toString('base64');
    isBase64 = true;
  }
  return {
    status: init?.status ?? 200,
    headers: {
      'Content-Type': contentType,
      ...init?.headers,
    },
    body: responseBody,
    ...(isBase64 ? { isBase64: true } : {}),
  };
}

/**
 * No-content response (204).
 */
export function noContent(init?: TypedResponseInit): PledgeResponse {
  return {
    status: 204,
    headers: init?.headers ?? {},
    body: '',
  };
}

/**
 * Redirect response.
 */
export function redirect(destination: string, permanent = false, init?: TypedResponseInit): PledgeResponse {
  return {
    status: permanent ? 301 : 302,
    headers: {
      Location: destination,
      ...init?.headers,
    },
    body: '',
  };
}

/**
 * Error response helper — ensures consistent error format.
 */
export function errorResponse(status: number, message: string, details?: Record<string, unknown>): PledgeResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: message, ...(details ? { details } : {}) }),
  };
}

/**
 * Validate that a response has correct Content-Type for its body.
 * Prevents MIME confusion attacks by ensuring body type matches declared content type.
 */
export function validateResponseContentType(response: PledgeResponse): { valid: boolean; reason?: string } {
  const contentType = response.headers['Content-Type']?.split(';')[0]?.trim();
  if (!contentType) {
    return { valid: false, reason: 'Missing Content-Type header' };
  }

  const expected = BODY_TYPE_EXPECTATIONS[contentType as ResponseContentType];
  if (!expected) {
    return { valid: true };
  }

  if (expected === 'string' && typeof response.body !== 'string') {
    return { valid: false, reason: `Content-Type "${contentType}" requires string body, got ${typeof response.body}` };
  }

  return { valid: true };
}

/**
 * Assert that body type matches expected content type.
 */
function assertBodyType(contentType: ResponseContentType, body: unknown): void {
  const expected = BODY_TYPE_EXPECTATIONS[contentType];
  if (expected === 'string' && typeof body !== 'string') {
    throw new TypeError(`Response body for ${contentType} must be a string, got ${typeof body}`);
  }
}

/**
 * Resolve a content type string from a shorthand.
 */
export function resolveContentType(type: string): ResponseContentType {
  return CONTENT_TYPE_MAP[type] ?? (type as ResponseContentType);
}
