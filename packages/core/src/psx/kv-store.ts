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
import { readFile, writeFile, rename } from 'node:fs/promises';

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

/** Cap on in-memory JS fallback entries to bound memory in the absence of
 * the native store. Without a cap, a long-running process accumulating ISR
 * / fetch-cache entries grows without bound. */
const JS_STORE_MAX_ENTRIES = 5000;
/** Max value size kept in the JS fallback (4 MiB). Larger values are still
 * stored but skipped from the JSON snapshot to avoid serializing huge
 * buffers on every flush. */
const JS_VALUE_SNAPSHOT_MAX = 4 * 1024 * 1024;

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

// Serialize concurrent flushes so a later write can't finish before an earlier
// one and leave stale bytes, and so temp-file writes don't race.
let flushChain: Promise<void> = Promise.resolve();

// Debounce disk writes: many rapid kvSet/kvDelete calls (e.g. an ISR rebuild
// touching many keys) previously hit the filesystem once per call. Coalescing
// them into a single flush reduces I/O and avoids interleaved temp-file
// renames. The timer itself tracks the pending state.
const FLUSH_DEBOUNCE_MS = 50;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Fallback: flush to disk atomically (temp file + rename). */
async function jsFlush(): Promise<void> {
  if (!jsStorePath) return;
  const path = jsStorePath;
  const run = async () => {
    const obj: Record<string, number[]> = {};
    for (const [key, value] of jsStore) {
      // Skip oversized values from the snapshot to keep serialization bounded.
      if (value.length > JS_VALUE_SNAPSHOT_MAX) continue;
      obj[key] = Array.from(value);
    }
    // Write to a temp file then atomically rename over the target. A crash
    // mid-write leaves the previous complete file intact rather than a
    // half-written, corrupt store (the docstring promises crash-safety).
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(obj), 'utf-8');
    await rename(tmp, path);
  };
  flushChain = flushChain.then(run, run);
  return flushChain;
}

/**
 * Schedules a debounced flush. Multiple rapid mutations coalesce into a
 * single disk write after `FLUSH_DEBOUNCE_MS` of quiescence.
 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void jsFlush();
  }, FLUSH_DEBOUNCE_MS);
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
  if (!jsStore.has(key) && jsStore.size >= JS_STORE_MAX_ENTRIES) {
    const oldest = jsStore.keys().next().value;
    if (oldest !== undefined) jsStore.delete(oldest);
  }
  jsStore.set(key, value);
  scheduleFlush();
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
  scheduleFlush();
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
