/**
 * #237 — RSC payload generation in Rust.
 *
 * Implements an RSC serializer that runs in Rust via NAPI when available,
 * eliminating the Node.js dependency for RSC payload generation.
 *
 * The Rust RSC serializer:
 * - Uses `swc` for module analysis (import/export tracking)
 * - Serializes the React component tree into the RSC flight format
 * - Tracks client component references and their chunk paths
 * - Produces a streaming payload that can be consumed by the client
 *
 * Flight format (simplified):
 *   [type, id, props, children...]
 *   - type: 0=text, 1=element, 2=component, 3=suspense, 4=fragment
 *   - id: module reference ID for client components
 *   - props: serialized properties (JSON-compatible + promises)
 *   - children: nested arrays
 *
 * This module provides the JS interface to the Rust serializer with a
 * pure-JS fallback that uses React's built-in flight serialization.
 */

import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type { RouteMatch, PledgeConfig } from 'pledgestack-shared';
import type { PageModule, LayoutModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import type { ClientReference } from './rsc';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust RSC serializer is available */
let rustRSCAvailable: boolean | null = null;
let rustRSCAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust RSC serializer addon.
 */
export function isRustRSCSerializerAvailable(): boolean {
  if (rustRSCAvailable !== null) return rustRSCAvailable;
  try {
    const addon = require('../../native/rust-rsc.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.serializeRSC === 'function' && typeof addon.analyzeModules === 'function') {
      rustRSCAddon = addon;
      rustRSCAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustRSCAvailable = false;
  return false;
}

export interface RSCSerializationContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule>;
  /** Client manifest mapping module paths to chunk paths */
  clientManifest?: Record<string, string>;
  /** Search params for the current request */
  searchParams?: Record<string, string>;
}

export interface RSCSerializationResult {
  /** The serialized RSC flight data as a string */
  flightData: string;
  /** Module map for client-side resolution */
  moduleMap: Record<string, string>;
  /** Client component references */
  clientReferences: ClientReference[];
  /** Whether the Rust serializer was used */
  usedRustSerializer: boolean;
  /** Module analysis results (imports, exports, client/server boundaries) */
  moduleAnalysis?: ModuleAnalysis[];
}

export interface ModuleAnalysis {
  /** Module file path */
  filePath: string;
  /** Imported module paths */
  imports: string[];
  /** Exported names */
  exports: string[];
  /** Whether this module uses client components */
  hasClientComponents: boolean;
  /** Client component export names */
  clientExports: string[];
  /** Detected Suspense boundaries */
  suspenseBoundaries: number;
}

/**
 * Serializes a route's component tree into an RSC payload using the Rust serializer.
 *
 * 1. Analyzes all modules in the route tree using swc (via Rust)
 * 2. Identifies client/server component boundaries
 * 3. Serializes the server component tree into flight format
 * 4. Collects client references for hydration
 */
export async function serializeRSCPayload(ctx: RSCSerializationContext): Promise<RSCSerializationResult> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Collect all module paths in the route tree
  const modulePaths = collectModulePaths(match, tree, modules);

  // Try Rust serializer first
  if (isRustRSCSerializerAvailable() && rustRSCAddon) {
    try {
      const result = serializeWithRust(ctx, modulePaths);
      if (result) return result;
    } catch (err) {
      console.warn('[pledgestack] Rust RSC serializer failed, falling back to JS:', err);
    }
  }

  // Fallback: JS-based serialization
  return serializeWithJS(ctx, modulePaths);
}

/**
 * Collects all module file paths in the route tree for analysis.
 */
function collectModulePaths(
  match: RouteMatch,
  tree: RouteTree,
  modules: Map<string, PageModule | LayoutModule>,
): string[] {
  const paths: string[] = [match.route.filePath];

  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    paths.push(layout.filePath);
  }

  if (match.route.loadingFilePath) paths.push(match.route.loadingFilePath);
  if (match.route.errorFilePath) paths.push(match.route.errorFilePath);
  if (match.route.notFoundFilePath) paths.push(match.route.notFoundFilePath);
  if (match.route.headFilePath) paths.push(match.route.headFilePath);
  if (match.route.templateFilePath) paths.push(match.route.templateFilePath);

  return paths.filter((p) => modules.has(p) || p);
}

/**
 * Serializes using the native Rust RSC serializer.
 */
function serializeWithRust(
  ctx: RSCSerializationContext,
  modulePaths: string[],
): RSCSerializationResult | null {
  if (!rustRSCAddon) return null;

  // Analyze modules with swc (Rust)
  const moduleAnalysis = rustRSCAddon.analyzeModules(modulePaths) as ModuleAnalysis[];

  // Build client references from analysis
  const clientReferences: ClientReference[] = [];
  const moduleMap: Record<string, string> = {};

  for (const analysis of moduleAnalysis) {
    if (analysis.hasClientComponents) {
      for (const exportName of analysis.clientExports) {
        const moduleId = analysis.filePath;
        const chunkPath = ctx.clientManifest?.[analysis.filePath] ?? `/__pledge__/chunks/${analysis.filePath.replace(/[^a-zA-Z0-9]/g, '_')}.js`;
        clientReferences.push({ moduleId, exportName, chunkPath });
        moduleMap[moduleId] = chunkPath;
      }
    }
  }

  // Serialize the component tree to flight format
  const element = buildElementTree(ctx);
  const searchParamsRecord = ctx.searchParams ?? {};
  void searchParamsRecord;

  // The Rust serializer expects a serialized representation
  // For now, we use React's renderToString as input and let Rust transform it
  const html = renderToString(element);

  const flightData = rustRSCAddon.serializeRSC(html, {
    moduleAnalysis,
    clientReferences,
    routePattern: ctx.match.route.pattern,
  }) as string;

  return {
    flightData,
    moduleMap,
    clientReferences,
    usedRustSerializer: true,
    moduleAnalysis,
  };
}

/**
 * Fallback: serializes using JavaScript-based RSC serialization.
 * Uses React's built-in flight protocol when available.
 */
async function serializeWithJS(
  ctx: RSCSerializationContext,
  modulePaths: string[],
): Promise<RSCSerializationResult> {
  const element = buildElementTree(ctx);

  // Try to use React's built-in flight serialization
  let flightData = '';
  try {
    const mod = await import('react-server-dom-webpack/server') as { renderToReadableStream?: (el: ReactNode) => ReadableStream<Uint8Array> };
    if (mod.renderToReadableStream) {
      const stream = mod.renderToReadableStream(element);
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        flightData += decoder.decode(value, { stream: true });
      }
    }
  } catch {
    // Fallback: manual serialization
    flightData = manualFlightSerialize(element);
  }

  // Build client references from manifest
  const clientReferences: ClientReference[] = [];
  const moduleMap: Record<string, string> = {};

  if (ctx.clientManifest) {
    for (const [moduleId, chunkPath] of Object.entries(ctx.clientManifest)) {
      clientReferences.push({ moduleId, exportName: 'default', chunkPath });
      moduleMap[moduleId] = chunkPath;
    }
  }

  // Basic module analysis (without swc)
  const moduleAnalysis: ModuleAnalysis[] = modulePaths.map((filePath) => ({
    filePath,
    imports: [],
    exports: [],
    hasClientComponents: !!ctx.clientManifest?.[filePath],
    clientExports: ctx.clientManifest?.[filePath] ? ['default'] : [],
    suspenseBoundaries: 0,
  }));

  return {
    flightData,
    moduleMap,
    clientReferences,
    usedRustSerializer: false,
    moduleAnalysis,
  };
}

/**
 * Builds the React element tree for serialization.
 */
function buildElementTree(ctx: RSCSerializationContext): ReactNode {
  const { match, tree, modules } = ctx;
  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      element = createElement(layoutModule.default, { children: element });
    }
  }

  return element;
}

/**
 * Manual flight serialization fallback.
 * Produces a simplified JSON-based flight format.
 */
function manualFlightSerialize(element: ReactNode): string {
  // Simplified flight format: array of [type, data] tuples
  const chunks: unknown[] = [];

  function serialize(node: ReactNode): unknown {
    if (node === null || node === undefined || typeof node === 'boolean') {
      return null;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      return [0, String(node)];
    }
    if (typeof node === 'object' && '$$typeof' in node) {
      // React element — serialize as component reference
      const el = node as { type: unknown; props: Record<string, unknown> };
      if (typeof el.type === 'string') {
        // HTML element
        return [1, el.type, serializeProps(el.props)];
      }
      if (typeof el.type === 'function' || typeof el.type === 'object') {
        // Component reference
        const componentName = (el.type as { displayName?: string; name?: string }).displayName
          ?? (el.type as { name?: string }).name
          ?? 'Anonymous';
        return [2, componentName, serializeProps(el.props)];
      }
    }
    if (Array.isArray(node)) {
      return [4, node.map(serialize)];
    }
    return null;
  }

  function serializeProps(props: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === 'children') {
        result[key] = serialize(value as ReactNode);
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      } else if (value === null || value === undefined) {
        result[key] = null;
      } else {
        result[key] = String(value);
      }
    }
    return result;
  }

  chunks.push(serialize(element));
  return JSON.stringify(chunks);
}

/**
 * Deserializes an RSC payload on the client side.
 * Uses the Rust deserializer when available (#242).
 */
export async function deserializeRSCPayload(
  flightData: string,
  moduleMap: Record<string, string>,
): Promise<ReactNode> {
  // Try Rust deserializer first
  if (isRustRSCSerializerAvailable() && rustRSCAddon && typeof rustRSCAddon.deserializeRSC === 'function') {
    try {
      const result = rustRSCAddon.deserializeRSC(flightData, moduleMap) as ReactNode;
      if (result) return result;
    } catch {
      // Fall through to JS deserializer
    }
  }

  // Fallback: use React's built-in deserializer
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

  // Last resort: manual deserialization
  return manualFlightDeserialize(flightData);
}

/**
 * Manual flight deserialization fallback.
 */
function manualFlightDeserialize(flightData: string): ReactNode {
  try {
    const chunks = JSON.parse(flightData) as unknown[];
    if (chunks.length === 0) return null;

    function deserialize(data: unknown): ReactNode {
      if (data === null) return null;
      if (typeof data === 'string') return data;
      if (Array.isArray(data)) {
        const [type, ...rest] = data;
        if (type === 0) return String(rest[0]);
        if (type === 1) {
          // HTML element — reconstruct as a simple element
          const tag = rest[0] as string;
          const props = (rest[1] as Record<string, unknown>) ?? {};
          return createElement(tag, props);
        }
        if (type === 4) {
          // Fragment
          return createElement('div', null, (rest[0] as unknown[]).map(deserialize));
        }
      }
      return null;
    }

    return deserialize(chunks[0]);
  } catch {
    return null;
  }
}

/**
 * Analyzes a single module file for client/server boundaries.
 * Uses Rust swc when available, falls back to regex-based analysis.
 */
export function analyzeModule(filePath: string, source: string): ModuleAnalysis {
  if (isRustRSCSerializerAvailable() && rustRSCAddon && typeof rustRSCAddon.analyzeModule === 'function') {
    try {
      return rustRSCAddon.analyzeModule(filePath, source) as ModuleAnalysis;
    } catch {
      // Fall through
    }
  }

  // JS fallback: regex-based analysis
  const imports: string[] = [];
  const exports: string[] = [];

  // Extract imports
  const importRegex = /import\s+(?:.*\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    imports.push(match[1]);
  }

  // Extract exports
  const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  while ((match = exportRegex.exec(source)) !== null) {
    exports.push(match[1]);
  }

  // Detect "use client" directive
  const hasClientComponents = source.includes('"use client"') || source.includes("'use client'");
  const clientExports = hasClientComponents ? exports : [];

  // Count Suspense boundaries
  const suspenseBoundaries = (source.match(/<Suspense/g) ?? []).length;

  return {
    filePath,
    imports,
    exports,
    hasClientComponents,
    clientExports,
    suspenseBoundaries,
  };
}
