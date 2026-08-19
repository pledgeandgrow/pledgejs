/**
 * #239 — Streaming HTML transformer.
 *
 * Rust-native streaming HTML transformer for post-processing SSR output.
 * Injects metadata, patches <head>, inserts RSC bootstrap script, and
 * handles backpressure for streaming responses.
 *
 * The transformer operates as a Transform stream that sits between the
 * SSR renderer and the HTTP response, modifying HTML chunks as they flow.
 *
 * Features:
 * - <head> injection: Insert meta tags, title, CSS preloads into <head>
 * - RSC bootstrap: Insert RSC flight data script tag before </body>
 * - Script injection: Add hydration scripts and module preloads
 * - Backpressure: Respects stream backpressure, buffering when needed
 * - Chunk-safe: Handles HTML tags split across stream chunks
 *
 * Uses the native Rust transformer via NAPI when available, with a JS fallback.
 */

import { Transform, type TransformCallback } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust HTML transformer is available */
let rustTransformerAvailable: boolean | null = null;
let rustTransformerAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust HTML transformer.
 */
export function isRustHtmlTransformerAvailable(): boolean {
  if (rustTransformerAvailable !== null) return rustTransformerAvailable;
  try {
    const addon = require('../../native/rust-html-transformer.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.createTransformer === 'function') {
      rustTransformerAddon = addon;
      rustTransformerAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustTransformerAvailable = false;
  return false;
}

export interface HtmlTransformOptions {
  /** Metadata to inject into <head> */
  headInjections?: string;
  /** RSC bootstrap data to insert before </body> */
  rscBootstrapData?: string;
  /** Script tags to inject before </body> */
  scriptInjections?: string[];
  /** CSS link tags to inject into <head> */
  cssInjections?: string[];
  /** Preload hints to inject into <head> */
  preloadInjections?: string[];
  /** Whether to use the Rust transformer (auto-detected if not specified) */
  useRust?: boolean;
}

/**
 * Creates a streaming HTML transformer that post-processes SSR output.
 *
 * The transformer:
 * 1. Buffers chunks until it finds the <head> tag, then injects head content
 * 2. Buffers until it finds </body>, then injects scripts and RSC data
 * 3. Passes through all other content unchanged
 * 4. Handles tags split across chunk boundaries
 */
export function createHtmlTransformer(options: HtmlTransformOptions): Transform {
  if (isRustHtmlTransformerAvailable() && options.useRust !== false) {
    try {
      return createRustTransformer(options);
    } catch (err) {
      console.warn('[pledgestack] Rust HTML transformer failed, using JS fallback:', err);
    }
  }

  return createJSTransformer(options);
}

/**
 * Creates a Rust-backed HTML transformer.
 */
function createRustTransformer(options: HtmlTransformOptions): Transform {
  if (!rustTransformerAddon) throw new Error('Rust transformer addon not loaded');

  const rustTransformer = rustTransformerAddon.createTransformer({
    headInjections: options.headInjections ?? '',
    rscBootstrapData: options.rscBootstrapData ?? '',
    scriptInjections: options.scriptInjections ?? [],
    cssInjections: options.cssInjections ?? [],
    preloadInjections: options.preloadInjections ?? [],
  }) as { transform: (chunk: Buffer) => Buffer; flush: () => Buffer };

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      try {
        const transformed = rustTransformer.transform(chunk);
        callback(null, transformed);
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        const remaining = rustTransformer.flush();
        if (remaining.length > 0) callback(null, remaining);
        else callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

/**
 * JS fallback: Creates a streaming HTML transformer.
 *
 * Uses a state machine to track position in the HTML document:
 * - BEFORE_HEAD: Looking for <head> to inject head content
 * - IN_HEAD: Already injected, passing through
 * - BEFORE_BODY_END: Looking for </body> to inject scripts
 * - DONE: All injections complete, passing through
 */
function createJSTransformer(options: HtmlTransformOptions): Transform {
  const headInjections = options.headInjections ?? '';
  const rscBootstrapData = options.rscBootstrapData;
  const scriptInjections = options.scriptInjections ?? [];
  const cssInjections = options.cssInjections ?? [];
  const preloadInjections = options.preloadInjections ?? [];

  // Combine all head injections
  const fullHeadInjection = [
    ...preloadInjections,
    ...cssInjections,
    headInjections,
  ].filter(Boolean).join('\n');

  // Combine all body-end injections
  const fullBodyInjection = [
    rscBootstrapData ? `<script id="__pledge_rsc_data__" type="application/json">${rscBootstrapData}</script>` : '',
    ...scriptInjections.map(s => `<script type="module" src="${s}"></script>`),
  ].filter(Boolean).join('\n');

  let buffer = '';
  let headInjected = false;
  let bodyEndInjected = false;

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      buffer += chunk.toString('utf-8');
      let output = '';

      // Inject head content after <head> tag
      if (!headInjected) {
        const headIdx = buffer.search(/<head[^>]*>/i);
        if (headIdx !== -1) {
          const headEnd = buffer.indexOf('>', headIdx) + 1;
          output += buffer.slice(0, headEnd);
          if (fullHeadInjection) {
            output += '\n' + fullHeadInjection + '\n';
          }
          buffer = buffer.slice(headEnd);
          headInjected = true;
        } else if (buffer.length > 8192) {
          // Buffer too large without <head>, pass through
          output += buffer;
          buffer = '';
          headInjected = true;
        } else {
          // Wait for more data
          callback(null);
          return;
        }
      }

      // Inject body-end content before </body>
      if (!bodyEndInjected) {
        const bodyEndIdx = buffer.search(/<\/body>/i);
        if (bodyEndIdx !== -1) {
          output += buffer.slice(0, bodyEndIdx);
          if (fullBodyInjection) {
            output += '\n' + fullBodyInjection + '\n';
          }
          buffer = buffer.slice(bodyEndIdx);
          bodyEndInjected = true;
        }
      }

      // Pass through remaining buffer (keep last 32 bytes for split tags)
      if (bodyEndInjected) {
        output += buffer;
        buffer = '';
      } else if (buffer.length > 32 && headInjected) {
        const safe = buffer.slice(0, -32);
        output += safe;
        buffer = buffer.slice(-32);
      }

      if (output) {
        callback(null, Buffer.from(output, 'utf-8'));
      } else {
        callback(null);
      }
    },
    flush(callback: TransformCallback) {
      // Flush any remaining buffer
      if (buffer) {
        callback(null, Buffer.from(buffer, 'utf-8'));
      } else {
        callback();
      }
    },
  });
}

/**
 * Transforms a complete HTML string (non-streaming convenience method).
 */
export function transformHtml(html: string, options: HtmlTransformOptions): string {
  const headInjections = [
    ...(options.preloadInjections ?? []),
    ...(options.cssInjections ?? []),
    options.headInjections ?? '',
  ].filter(Boolean).join('\n');

  const bodyInjections = [
    options.rscBootstrapData ? `<script id="__pledge_rsc_data__" type="application/json">${options.rscBootstrapData}</script>` : '',
    ...(options.scriptInjections ?? []).map(s => `<script type="module" src="${s}"></script>`),
  ].filter(Boolean).join('\n');

  let result = html;

  if (headInjections) {
    result = result.replace(/(<head[^>]*>)/i, `$1\n${headInjections}\n`);
  }

  if (bodyInjections) {
    result = result.replace(/(<\/body>)/i, `${bodyInjections}\n$1`);
  }

  return result;
}
