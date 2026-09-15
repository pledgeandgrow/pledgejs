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
    const addon = require('../../native/rust-ws-compression.node') as NativeWsCompression;
    if (typeof addon.wsCompress === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

/**
 * Maximum decompressed payload size (16 MiB). A malicious peer could send a
 * tiny compressed "zip bomb" that decompresses to gigabytes and OOMs the
 * server. We reject decompressed output larger than this. The primary
 * defense against WS memory exhaustion is the frame-size limit enforced at
 * the WebSocket layer; this cap is a backstop for the compression path.
 */
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

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
 * Rejects decompressed output larger than `MAX_DECOMPRESSED_BYTES` to bound
 * memory use against compressed "zip bombs". The primary defense against WS
 * memory exhaustion is the frame-size limit at the WebSocket layer; this cap
 * is a backstop for the compression path.
 *
 * @param data Compressed payload
 */
export function wsDecompress(data: Buffer): Buffer {
  const addon = loadNative();
  if (addon) {
    const out = addon.wsDecompress(data);
    if (out.length > MAX_DECOMPRESSED_BYTES) {
      throw new Error(`Decompressed WebSocket payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes`);
    }
    return out;
  }
  const out = inflateSync(data);
  if (out.length > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`Decompressed WebSocket payload exceeds ${MAX_DECOMPRESSED_BYTES} bytes`);
  }
  return out;
}

/**
 * Whether native WebSocket compression is available.
 */
export function isNativeWsCompressionAvailable(): boolean {
  return loadNative() !== null;
}
