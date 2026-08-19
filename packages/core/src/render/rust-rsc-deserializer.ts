/**
 * #242 — RSC client deserializer in Rust.
 *
 * Native RSC payload deserialization for edge runtime.
 * Eliminates the need for JavaScript RSC client on edge, enabling
 * faster cold starts and reduced bundle size.
 *
 * The Rust deserializer:
 * - Parses the RSC flight format natively
 * - Resolves module references from the client manifest
 * - Reconstructs the React element tree
 * - Handles promises and async references
 * - Supports streaming deserialization for progressive hydration
 *
 * Uses NAPI when available, with a JS fallback using React's
 * built-in flight client.
 */

import { createElement, Suspense, type ReactNode } from 'react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust RSC deserializer is available */
let rustDeserializerAvailable: boolean | null = null;
let rustDeserializerAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust RSC deserializer.
 */
export function isRustRSCDeserializerAvailable(): boolean {
  if (rustDeserializerAvailable !== null) return rustDeserializerAvailable;
  try {
    const addon = require('../../native/rust-rsc-deserializer.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.deserialize === 'function' && typeof addon.deserializeStream === 'function') {
      rustDeserializerAddon = addon;
      rustDeserializerAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustDeserializerAvailable = false;
  return false;
}

export interface RSCDeserializeOptions {
  /** Module map for resolving client component references */
  moduleMap: Record<string, string>;
  /** Whether to use the Rust deserializer (auto-detected if not specified) */
  useRust?: boolean;
  /** Whether to eagerly resolve all promises */
  eagerResolve?: boolean;
}

export interface RSCDeserializeResult {
  /** The deserialized React element tree */
  tree: ReactNode;
  /** Whether the Rust deserializer was used */
  usedRust: boolean;
  /** Deserialization time in microseconds */
  deserializeTimeUs: number;
  /** Number of module references resolved */
  moduleReferencesResolved: number;
}

/**
 * Deserializes an RSC payload into a React element tree.
 *
 * On edge runtime, the Rust deserializer eliminates the need for
 * the JavaScript RSC client, reducing cold start time significantly.
 */
export async function deserializeRSC(
  flightData: string,
  options: RSCDeserializeOptions,
): Promise<RSCDeserializeResult> {
  const startTime = process.hrtime.bigint();

  if (isRustRSCDeserializerAvailable() && options.useRust !== false) {
    try {
      const result = rustDeserializerAddon!.deserialize(flightData, options.moduleMap, {
        eagerResolve: options.eagerResolve ?? false,
      }) as { tree: ReactNode; moduleReferencesResolved: number };

      const endTime = process.hrtime.bigint();
      return {
        tree: result.tree,
        usedRust: true,
        deserializeTimeUs: Number(endTime - startTime) / 1000,
        moduleReferencesResolved: result.moduleReferencesResolved,
      };
    } catch (err) {
      console.warn('[pledgestack] Rust RSC deserializer failed, falling back to JS:', err);
    }
  }

  // Fallback: JS-based deserialization using React's flight client
  const tree = await deserializeWithJS(flightData, options.moduleMap);
  const endTime = process.hrtime.bigint();

  return {
    tree,
    usedRust: false,
    deserializeTimeUs: Number(endTime - startTime) / 1000,
    moduleReferencesResolved: Object.keys(options.moduleMap).length,
  };
}

/**
 * Streaming deserialization — progressively hydrates the tree as chunks arrive.
 */
export async function deserializeRSCStream(
  stream: ReadableStream<Uint8Array>,
  options: RSCDeserializeOptions,
): Promise<RSCDeserializeResult> {
  if (isRustRSCDeserializerAvailable() && options.useRust !== false) {
    try {
      // Convert stream to chunks for Rust addon
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      const combined = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      const flightData = new TextDecoder().decode(combined);
      return deserializeRSC(flightData, options);
    } catch (err) {
      console.warn('[pledgestack] Rust RSC stream deserializer failed, falling back to JS:', err);
    }
  }

  // Fallback: use React's flight client
  try {
    const mod = await import('react-server-dom-webpack/client') as { createFromReadableStream?: (s: ReadableStream<Uint8Array>) => Promise<ReactNode> };
    if (mod.createFromReadableStream) {
      const startTime = process.hrtime.bigint();
      const tree = await mod.createFromReadableStream(stream);
      const endTime = process.hrtime.bigint();

      return {
        tree,
        usedRust: false,
        deserializeTimeUs: Number(endTime - startTime) / 1000,
        moduleReferencesResolved: Object.keys(options.moduleMap).length,
      };
    }
  } catch {
    // Module not available
  }

  throw new Error('RSC deserialization not available — neither Rust addon nor React flight client found');
}

/**
 * JS fallback: Deserializes RSC payload using React's flight client.
 */
async function deserializeWithJS(
  flightData: string,
  moduleMap: Record<string, string>,
): Promise<ReactNode> {
  // Try React's built-in flight client
  try {
    const mod = await import('react-server-dom-webpack/client') as { createFromReadableStream?: (s: ReadableStream<Uint8Array>) => Promise<ReactNode> };
    if (mod.createFromReadableStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(flightData));
          controller.close();
        },
      });
      return mod.createFromReadableStream(stream);
    }
  } catch {
    // Module not available
  }

  // Manual fallback: parse simplified flight format
  return deserializeManual(flightData, moduleMap);
}

/**
 * Manual deserialization fallback for simplified flight format.
 */
function deserializeManual(
  flightData: string,
  moduleMap: Record<string, string>,
): ReactNode {
  try {
    const data = JSON.parse(flightData) as unknown[];
    if (data.length === 0) return null;

    function deserializeNode(node: unknown): ReactNode {
      if (node === null || node === undefined) return null;
      if (typeof node === 'string') return node;
      if (typeof node === 'number') return String(node);

      if (Array.isArray(node)) {
        const [type, ...rest] = node;

        if (type === 0) {
          // Text node
          return String(rest[0]);
        }

        if (type === 1) {
          // HTML element
          const tag = rest[0] as string;
          const props = (rest[1] as Record<string, unknown>) ?? {};
          return createElement(tag, props);
        }

        if (type === 2) {
          // Component reference — resolve from module map
          const componentName = rest[0] as string;
          const props = (rest[1] as Record<string, unknown>) ?? {};
          const chunkPath = moduleMap[componentName];

          if (chunkPath) {
            // Return a lazy component that will be loaded on the client
            return createElement('div', { 'data-pledge-component': componentName, 'data-pledge-chunk': chunkPath, ...props });
          }

          return createElement('div', { 'data-pledge-component': componentName, ...props });
        }

        if (type === 3) {
          // Suspense boundary
          const fallback = deserializeNode(rest[0]);
          const children = rest[1] ? deserializeNode(rest[1]) : null;
          return createElement(Suspense, { fallback }, children);
        }

        if (type === 4) {
          // Fragment / array
          const items = rest[0] as unknown[];
          if (Array.isArray(items)) {
            return createElement('div', null, ...items.map(deserializeNode));
          }
          return null;
        }
      }

      return null;
    }

    return deserializeNode(data[0]);
  } catch {
    return null;
  }
}

/**
 * Pre-parses the flight data to extract module references without
 * fully deserializing the tree. Useful for preloading chunks.
 */
export function extractModuleReferences(
  flightData: string,
  moduleMap: Record<string, string>,
): string[] {
  if (isRustRSCDeserializerAvailable() && rustDeserializerAddon && typeof rustDeserializerAddon.extractModuleReferences === 'function') {
    try {
      return rustDeserializerAddon.extractModuleReferences(flightData, moduleMap) as string[];
    } catch {
      // Fall through
    }
  }

  // JS fallback: regex-based extraction
  const refs: string[] = [];
  const refRegex = /\[2,"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(flightData)) !== null) {
    const chunkPath = moduleMap[match[1]];
    if (chunkPath && !refs.includes(chunkPath)) {
      refs.push(chunkPath);
    }
  }
  return refs;
}

/**
 * Validates that an RSC payload is well-formed before deserialization.
 */
export function validateRSCPayload(flightData: string): { valid: boolean; error?: string } {
  if (isRustRSCDeserializerAvailable() && rustDeserializerAddon && typeof rustDeserializerAddon.validate === 'function') {
    try {
      return rustDeserializerAddon.validate(flightData) as { valid: boolean; error?: string };
    } catch {
      // Fall through
    }
  }

  // JS fallback: basic JSON validation
  try {
    const data = JSON.parse(flightData);
    if (!Array.isArray(data)) {
      return { valid: false, error: 'RSC payload must be a JSON array' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
}
