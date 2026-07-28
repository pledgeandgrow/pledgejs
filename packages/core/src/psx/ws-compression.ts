/**
 * Native WebSocket message compression.
 *
 * Uses the rust-ws-compression NAPI addon (flate2 with SIMD acceleration)
 * for per-message compression (permessage-deflate). When the native addon
 * is not compiled, falls back to Node's zlib.
 */

import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);

interface NativeWsCompression {
  wsCompress: (data: Buffer, level?: number) => Buffer;
  wsDecompress: (data: Buffer) => Buffer;
  isNativeWsCompressionAvailable: () => boolean;
}

let nativeAddon: NativeWsCompression | null = null;
let loadAttempted = false;

function loadNative(): NativeWsCompression | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../native/rust-ws-compression.node') as NativeWsCompression;
    if (typeof addon.wsCompress === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

/**
 * Compresses a WebSocket message using permessage-deflate (zlib).
 *
 * @param data Message payload
 * @param level Compression level 1-9 (default: 6)
 */
export function wsCompress(data: Buffer, level?: number): Buffer {
  const addon = loadNative();
  if (addon) {
    return addon.wsCompress(data, level);
  }
  return deflateSync(data, { level: level ?? 6 });
}

/**
 * Decompresses a WebSocket message.
 *
 * @param data Compressed payload
 */
export function wsDecompress(data: Buffer): Buffer {
  const addon = loadNative();
  if (addon) {
    return addon.wsDecompress(data);
  }
  return inflateSync(data);
}

/**
 * Whether native WebSocket compression is available.
 */
export function isNativeWsCompressionAvailable(): boolean {
  return loadNative() !== null;
}
