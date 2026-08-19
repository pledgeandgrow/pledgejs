/**
 * Embedded KV store — persistent key-value storage for ISR/fetch cache.
 *
 * Uses the rust-kv-store NAPI addon for native speed and crash-safe
 * disk persistence. Eliminates the need for Redis or external cache
 * services for ISR.
 *
 * When the native addon is not compiled, falls back to a JS Map with
 * optional JSON file persistence.
 */

import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

interface NativeKvStore {
  kvOpen: (path: string) => Promise<void>;
  kvGet: (key: string) => Promise<Buffer | null>;
  kvSet: (key: string, value: Buffer) => Promise<void>;
  kvDelete: (key: string) => Promise<void>;
  kvClear: () => Promise<void>;
  kvKeys: () => Promise<string[]>;
  kvSize: () => Promise<number>;
  kvFlush: () => Promise<void>;
}

let nativeAddon: NativeKvStore | null = null;
let loadAttempted = false;

function loadNative(): NativeKvStore | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../../native/rust-kv-store.node') as NativeKvStore;
    if (typeof addon.kvOpen === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

// JS fallback state
const jsStore = new Map<string, Buffer>();
let jsStorePath: string | null = null;

/** Fallback: load from disk */
async function jsLoad(): Promise<void> {
  if (!jsStorePath) return;
  try {
    const data = await readFile(jsStorePath);
    const map = JSON.parse(data.toString('utf-8')) as Record<string, number[]>;
    for (const [key, value] of Object.entries(map)) {
      jsStore.set(key, Buffer.from(value));
    }
  } catch {
    // File doesn't exist yet
  }
}

/** Fallback: flush to disk */
async function jsFlush(): Promise<void> {
  if (!jsStorePath) return;
  const obj: Record<string, number[]> = {};
  for (const [key, value] of jsStore) {
    obj[key] = Array.from(value);
  }
  await writeFile(jsStorePath, JSON.stringify(obj), 'utf-8');
}

/**
 * Opens the KV store at the given path.
 */
export async function kvOpen(path: string): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.kvOpen(path);
  }
  jsStorePath = path;
  jsStore.clear();
  await jsLoad();
}

/**
 * Gets a value by key.
 */
export async function kvGet(key: string): Promise<Buffer | null> {
  const addon = loadNative();
  if (addon) {
    return addon.kvGet(key);
  }
  return jsStore.get(key) ?? null;
}

/**
 * Sets a key-value pair.
 */
export async function kvSet(key: string, value: Buffer): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.kvSet(key, value);
  }
  jsStore.set(key, value);
  await jsFlush();
}

/**
 * Deletes a key.
 */
export async function kvDelete(key: string): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.kvDelete(key);
  }
  jsStore.delete(key);
  await jsFlush();
}

/**
 * Clears all keys.
 */
export async function kvClear(): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.kvClear();
  }
  jsStore.clear();
  await jsFlush();
}

/**
 * Returns all keys.
 */
export async function kvKeys(): Promise<string[]> {
  const addon = loadNative();
  if (addon) {
    return addon.kvKeys();
  }
  return [...jsStore.keys()];
}

/**
 * Returns the number of keys.
 */
export async function kvSize(): Promise<number> {
  const addon = loadNative();
  if (addon) {
    return addon.kvSize();
  }
  return jsStore.size;
}

/**
 * Flushes pending writes to disk.
 */
export async function kvFlush(): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.kvFlush();
  }
  await jsFlush();
}

/**
 * Whether the native KV store is available.
 */
export function isNativeKvStoreAvailable(): boolean {
  return loadNative() !== null;
}
