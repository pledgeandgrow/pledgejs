/**
 * Native compression for HTTP responses.
 *
 * Uses the rust-compression NAPI addon (flate2 with SIMD acceleration)
 * for gzip and deflate. When the native addon is not compiled, falls
 * back to Node's zlib.
 */

import { createRequire } from 'node:module';
import { gzipSync, gunzipSync, deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);

interface NativeCompression {
  gzipCompress: (data: Buffer, level?: number) => Buffer;
  deflateCompress: (data: Buffer, level?: number) => Buffer;
  gzipDecompress: (data: Buffer) => Buffer;
  isNativeCompressionAvailable: () => boolean;
}

let nativeAddon: NativeCompression | null = null;
let loadAttempted = false;

function loadNative(): NativeCompression | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../native/rust-compression.node') as NativeCompression;
    if (typeof addon.gzipCompress === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

/**
 * Compresses data using gzip.
 * @param data Input buffer
 * @param level Compression level 1-9 (default: 6)
 */
export function gzipCompress(data: Buffer, level?: number): Buffer {
  const addon = loadNative();
  if (addon) {
    return addon.gzipCompress(data, level);
  }
  return gzipSync(data, { level: level ?? 6 });
}

/**
 * Compresses data using deflate.
 * @param data Input buffer
 * @param level Compression level 1-9 (default: 6)
 */
export function deflateCompress(data: Buffer, level?: number): Buffer {
  const addon = loadNative();
  if (addon) {
    return addon.deflateCompress(data, level);
  }
  return deflateSync(data, { level: level ?? 6 });
}

/**
 * Decompresses gzip data.
 */
export function gzipDecompress(data: Buffer): Buffer {
  const addon = loadNative();
  if (addon) {
    return addon.gzipDecompress(data);
  }
  return gunzipSync(data);
}

/**
 * Whether native compression is available.
 */
export function isNativeCompressionAvailable(): boolean {
  return loadNative() !== null;
}

/**
 * Compresses a response body based on Accept-Encoding header.
 * Returns the compressed body and the encoding to set in Content-Encoding.
 *
 * @param body Response body
 * @param acceptEncoding Accept-Encoding header value
 * @returns { body: Buffer; encoding: string | null }
 */
export function compressResponse(
  body: Buffer | string,
  acceptEncoding: string,
): { body: Buffer; encoding: string | null } {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;

  if (!acceptEncoding) return { body: buf, encoding: null };

  const encodings = acceptEncoding.toLowerCase().split(',').map((e) => e.trim().split(';')[0]);

  // Prefer gzip
  if (encodings.includes('gzip')) {
    return { body: gzipCompress(buf), encoding: 'gzip' };
  }

  if (encodings.includes('deflate')) {
    return { body: deflateCompress(buf), encoding: 'deflate' };
  }

  return { body: buf, encoding: null };
}
