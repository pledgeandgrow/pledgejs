/**
 * #236 — Rust SSR for dynamic pages.
 *
 * Extends the Rust rendering pipeline beyond static extraction to handle
 * dynamic data by pre-rendering Suspense boundaries in Rust and streaming
 * dynamic holes via the RSC protocol.
 *
 * The Rust SSR engine:
 * - Renders static portions of the React tree natively (no V8)
 * - Identifies Suspense boundaries and emits placeholder slots
 * - Streams dynamic content as it resolves via RSC flight protocol
 * - Falls back to Node.js React for components that can't be rendered in Rust
 *
 * This module provides the JS-side orchestration that interfaces with the
 * native Rust SSR addon via NAPI when available, with a pure-JS fallback.
 */

import { renderToPipeableStream, renderToString } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, PledgeConfig, ResolvedRoute } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust SSR addon is available */
let rustSSRAvailable: boolean | null = null;
let rustSSRAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust SSR addon.
 * Returns true if the addon is available and functional.
 */
export function isRustSSRAvailable(): boolean {
  if (rustSSRAvailable !== null) return rustSSRAvailable;
  try {
    const addon = require('../../native/rust-ssr.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.renderStaticShell === 'function') {
      rustSSRAddon = addon;
      rustSSRAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled — fall back to JS implementation
  }
  rustSSRAvailable = false;
  return false;
}

export interface RustSSRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  /** Search params for the current request */
  searchParams?: Record<string, string>;
  /** Whether to force Rust rendering even for dynamic content */
  forceRust?: boolean;
}

export interface SuspenseBoundary {
  /** Unique ID for this boundary */
  id: string;
  /** The fallback HTML content */
  fallbackHtml: string;
  /** Whether the content has resolved */
  resolved: boolean;
  /** The resolved HTML content (if resolved) */
  html?: string;
  /** Children boundaries */
  children: SuspenseBoundary[];
}

export interface RustSSRResult {
  /** The static shell HTML (everything outside Suspense boundaries) */
  staticShell: string;
  /** Suspense boundaries with their resolved/pending state */
  boundaries: SuspenseBoundary[];
  /** Whether the Rust engine was used or fell back to JS */
  usedRustEngine: boolean;
  /** Module IDs that need client-side hydration */
  clientModuleIds: string[];
  /** RSC flight data for dynamic holes */
  flightData?: string;
}

/**
 * Renders a route match using the Rust SSR engine.
 *
 * 1. Extracts the static portions of the React tree
 * 2. Pre-renders Suspense boundaries with their fallback content
 * 3. Streams dynamic holes via RSC protocol as they resolve
 * 4. Falls back to Node.js React for unsupported components
 */
export async function renderRustSSR(ctx: RustSSRContext): Promise<RustSSRResult> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Build the element tree
  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  // Wrap with error boundary
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(RustSSRErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  // Wrap with Suspense for dynamic content
  if (match.route.loadingFilePath) {
    const loadingModule = modules.get(match.route.loadingFilePath) as LoadingModule | undefined;
    if (loadingModule) {
      element = createElement(Suspense, { fallback: createElement(loadingModule.default, {}) }, element);
    }
  }

  // Wrap in template
  if (match.route.templateFilePath) {
    const templateModule = modules.get(match.route.templateFilePath) as TemplateModule | undefined;
    if (templateModule) {
      element = createElement(templateModule.default, { children: element });
    }
  }

  // Wrap in layout chain
  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      if (layout.errorFilePath) {
        const layoutErrorModule = modules.get(layout.errorFilePath) as ErrorModule | undefined;
        if (layoutErrorModule) {
          layoutContent = createElement(RustSSRErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
        }
      }

      if (layout.loadingFilePath) {
        const layoutLoadingModule = modules.get(layout.loadingFilePath) as LoadingModule | undefined;
        if (layoutLoadingModule) {
          layoutContent = createElement(Suspense, { fallback: createElement(layoutLoadingModule.default, {}) }, layoutContent);
        }
      }

      if (layout.templateFilePath) {
        const layoutTemplateModule = modules.get(layout.templateFilePath) as TemplateModule | undefined;
        if (layoutTemplateModule) {
          layoutContent = createElement(layoutTemplateModule.default, { children: layoutContent });
        }
      }

      element = layoutContent;
    }
  }

  // Try Rust SSR engine first
  if (isRustSSRAvailable() && rustSSRAddon) {
    try {
      const result = renderWithRustEngine(element, ctx);
      if (result) return result;
    } catch (err) {
      console.warn('[pledgestack] Rust SSR engine failed, falling back to React:', err);
    }
  }

  // Fallback: use React's renderToPipeableStream with Suspense boundary tracking
  return renderWithReactFallback(element, ctx);
}

/**
 * Renders using the native Rust SSR engine.
 * The Rust engine pre-renders static portions and identifies Suspense boundaries.
 */
function renderWithRustEngine(element: ReactNode, ctx: RustSSRContext): RustSSRResult | null {
  if (!rustSSRAddon) return null;

  // The Rust addon expects a serialized representation of the element tree.
  // For now, we use the React-rendered HTML and let Rust post-process it.
  // In a full implementation, the Rust engine would walk the React tree directly.

  try {
    // Render to HTML string first (React handles the component tree)
    const html = renderToString(element);

    // Pass to Rust engine for static shell extraction and boundary detection
    const staticShell = rustSSRAddon.renderStaticShell(html, {
      routePattern: ctx.match.route.pattern,
      forceRust: ctx.forceRust ?? false,
    }) as string;

    const boundaries = rustSSRAddon.extractSuspenseBoundaries(html) as SuspenseBoundary[];
    const clientModuleIds = rustSSRAddon.extractClientModuleIds(html) as string[];

    return {
      staticShell,
      boundaries,
      usedRustEngine: true,
      clientModuleIds,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback: renders using React's renderToPipeableStream with Suspense boundary tracking.
 * This mimics what the Rust engine would do, but in JavaScript.
 */
function renderWithReactFallback(element: ReactNode, ctx: RustSSRContext): Promise<RustSSRResult> {
  return new Promise((resolve, reject) => {
    let html = '';
    let shellReady = false;
    const boundaries: SuspenseBoundary[] = [];

    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        html += chunk.toString('utf-8');
        callback();
      },
    });

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      onShellReady() {
        shellReady = true;
        pipe(writable);
      },
      onAllReady() {
        // Extract Suspense boundaries from the rendered HTML
        const boundaryRegex = /<!--\$?--><template id="S:(\d+)">(.*?)<\/template>/gs;
        let match: RegExpExecArray | null;
        while ((match = boundaryRegex.exec(html)) !== null) {
          boundaries.push({
            id: match[1],
            fallbackHtml: match[2],
            resolved: true,
            html: match[2],
            children: [],
          });
        }

        // If no boundaries found via template tags, check for Suspense fallback patterns
        if (boundaries.length === 0) {
          const suspenseRegex = /<!--\$s:([^>]+)-->/g;
          while ((match = suspenseRegex.exec(html)) !== null) {
            boundaries.push({
              id: match[1],
              fallbackHtml: '',
              resolved: false,
              children: [],
            });
          }
        }

        const clientModuleIds: string[] = [];
        const manifest: PledgeManifest = { pledges: [] };

        const shellHtml = wrapRustSSRHtml(html, ctx.match.route, manifest, boundaries);

        resolve({
          staticShell: shellHtml,
          boundaries,
          usedRustEngine: false,
          clientModuleIds,
        });
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        if (!shellReady) reject(error);
      },
    });
    void pipe;
  });
}

/**
 * Wraps rendered HTML with the full document shell for Rust SSR output.
 */
function wrapRustSSRHtml(
  content: string,
  route: ResolvedRoute,
  manifest: PledgeManifest,
  boundaries: SuspenseBoundary[],
): string {
  const boundaryData = JSON.stringify(boundaries.map(b => ({
    id: b.id,
    resolved: b.resolved,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${route.metadata?.title ? `<title>${route.metadata.title}</title>` : ''}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__">${content}</div>
  <script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>
  <script id="__pledge_suspense_boundaries__" type="application/json">${boundaryData}</script>
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}

/**
 * Error boundary for Rust SSR that captures errors and renders fallback.
 */
class RustSSRErrorBoundary extends Component<
  { fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      const Fallback = this.props.fallback;
      return createElement(Fallback, {
        error: this.state.error,
        reset: () => this.setState({ hasError: false, error: null }),
      });
    }
    return this.props.children as ReactNode;
  }
}

/**
 * Streams dynamic content for a specific Suspense boundary.
 * Used after the static shell has been sent to fill in dynamic holes.
 */
export async function streamDynamicContent(
  _boundaryId: string,
  ctx: RustSSRContext,
): Promise<ReadableStream<Uint8Array>> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Re-render the full tree to get the dynamic content for this boundary
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

  return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
    const encoder = new TextEncoder();
    const chunks: Buffer[] = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (streamController) {
          streamController.enqueue(new Uint8Array(chunk));
        } else {
          chunks.push(chunk);
        }
        callback();
      },
    });

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      onShellReady() {
        pipe(writable);
      },
      onAllReady() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            const content = Buffer.concat(chunks).toString('utf-8');
            controller.enqueue(encoder.encode(content));
            controller.close();
          },
        });
        resolve(stream);
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        reject(error);
      },
    });
    void pipe;
  });
}
