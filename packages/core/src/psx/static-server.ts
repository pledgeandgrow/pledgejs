/**
 * Zero-copy static file serving via memory-mapped I/O.
 *
 * Uses the rust-static-server NAPI addon for native mmap-based file reading.
 * When the native addon is not compiled, falls back to Node's fs.readFile.
 */

import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);

interface NativeStaticServer {
  readFileMmap: (path: string) => Promise<Buffer>;
  getFileMeta: (path: string) => Promise<FileMeta>;
  fileExists: (path: string) => boolean;
}

interface FileMeta {
  size: number;
  modifiedMs: number;
  isFile: boolean;
}

let nativeAddon: NativeStaticServer | null = null;
let loadAttempted = false;

function loadNative(): NativeStaticServer | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../native/rust-static-server.node') as NativeStaticServer;
    if (typeof addon.readFileMmap === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

export type { FileMeta };

/**
 * Reads a file using native mmap when available.
 * Falls back to fs.readFile.
 */
export async function readFileFast(path: string): Promise<Buffer> {
  const addon = loadNative();
  if (addon) {
    return addon.readFileMmap(path);
  }
  return readFile(path);
}

/**
 * Gets file metadata without reading the file.
 */
export async function getFileMeta(path: string): Promise<FileMeta> {
  const addon = loadNative();
  if (addon) {
    return addon.getFileMeta(path);
  }
  const s = await stat(path);
  return {
    size: s.size,
    modifiedMs: s.mtimeMs,
    isFile: s.isFile(),
  };
}

/**
 * Checks if a file exists.
 */
export function fileExists(path: string): boolean {
  const addon = loadNative();
  if (addon) {
    return addon.fileExists(path);
  }
  // Synchronous check fallback
  try {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Whether the native static server is available.
 */
export function isNativeStaticServerAvailable(): boolean {
  return loadNative() !== null;
}
