/**
 * #243 — PPR (Partial Prerendering) via Rust SSR.
 *
 * Pre-renders the static shell of every page at build time using the Rust
 * SSR engine. The static shell is served instantly from edge cache, and
 * dynamic holes are filled via RSC streaming on the client.
 *
 * This extends the existing PPR implementation (packages/core/src/render/ppr.ts)
 * to use the Rust SSR engine (#236), Rust HTML template engine (#238),
 * and Rust RSC serializer (#237) for build-time prerendering.
 *
 * Build-time flow:
 * 1. For each route, render the component tree with empty params/searchParams
 * 2. The Rust SSR engine identifies static vs dynamic parts
 * 3. Static parts are rendered to HTML and cached
 * 4. Dynamic parts (Suspense boundaries) are marked as holes
 * 5. The static shell + hole metadata is stored for request-time filling
 *
 * Request-time flow:
 * 1. Serve the cached static shell immediately (TTFB ~0ms)
 * 2. Stream dynamic content into holes via RSC protocol
 * 3. Client hydrates the full page
 */

import { renderToPipeableStream } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, PledgeConfig, ResolvedRoute } from 'pledgestack-shared';
import { type PledgeManifest, pledgeAssetUrl } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { renderHtmlShell, type PreloadHint } from './rust-html';
import { isRustSSRAvailable, renderRustSSR, type RustSSRResult } from './rust-ssr';

export interface RustPPRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  /** Whether this is the build-time prerender */
  isPrerender: boolean;
  /** Pre-rendered static shell (for request-time filling) */
  staticShell?: string;
  /** Request-time query parameters, passed to the page as `searchParams`. */
  searchParams?: Record<string, string>;
  /** Preload hints for critical resources */
  preloadHints?: PreloadHint[];
}

export interface RustPPRResult {
  /** The static shell HTML with placeholder holes */
  html: string;
  /** Dynamic holes that need to be filled at request time */
  holes: DynamicHole[];
  /** Whether the Rust SSR engine was used */
  usedRustEngine: boolean;
  /** Build-time render metrics */
  renderTimeMs: number;
  /** Static shell size in bytes */
  shellSizeBytes: number;
  /** Estimated dynamic content size in bytes */
  dynamicContentSizeBytes: number;
}

export interface DynamicHole {
  /** Unique hole ID */
  id: string;
  /** Suspense boundary ID */
  suspenseId: string;
  /** Fallback HTML shown until dynamic content loads */
  fallbackHtml: string;
  /** Whether this hole has been filled */
  filled: boolean;
  /** The filled HTML content (if filled) */
  html?: string;
}

/**
 * Prerenders the static shell of a page at build time using the Rust SSR engine.
 *
 * The static shell includes everything that doesn't depend on request-specific
 * data (cookies, headers, searchParams, dynamic params).
 */
export async function prerenderRustStaticShell(ctx: RustPPRContext): Promise<RustPPRResult> {
  const startTime = Date.now();

  const { match, tree, modules } = ctx;
  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Build element tree with empty params for prerender
  let element: ReactNode = createElement(pageModule.default, {
    params: {},
    searchParams: {},
  });

  // Wrap with error boundary and Suspense
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(PPRErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  if (match.route.loadingFilePath) {
    const loadingModule = modules.get(match.route.loadingFilePath) as LoadingModule | undefined;
    if (loadingModule) {
      element = createElement(Suspense, { fallback: createElement(loadingModule.default, {}) }, element);
    }
  }

  if (match.route.templateFilePath) {
    const templateModule = modules.get(match.route.templateFilePath) as TemplateModule | undefined;
    if (templateModule) {
      element = createElement(templateModule.default, { children: element });
    }
  }

  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      if (layout.errorFilePath) {
        const layoutErrorModule = modules.get(layout.errorFilePath) as ErrorModule | undefined;
        if (layoutErrorModule) {
          layoutContent = createElement(PPRErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
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
  if (isRustSSRAvailable()) {
    try {
      const rustResult = await renderRustSSR({
        config: ctx.config,
        match,
        tree,
        modules: modules as Map<string, PageModule | LayoutModule>,
        forceRust: true,
      });

      const holes = extractHolesFromRustResult(rustResult);
      const html = wrapPPRHtml(rustResult.staticShell, match.route, holes, ctx.preloadHints);

      return {
        html,
        holes,
        usedRustEngine: true,
        renderTimeMs: Date.now() - startTime,
        shellSizeBytes: Buffer.byteLength(rustResult.staticShell, 'utf-8'),
        dynamicContentSizeBytes: holes.reduce((sum, h) => sum + Buffer.byteLength(h.fallbackHtml, 'utf-8'), 0),
      };
    } catch (err) {
      console.warn('[pledgestack] Rust PPR prerender failed, falling back to React:', err);
    }
  }

  // Fallback: React-based prerender
  return prerenderWithReact(element, ctx, startTime);
}

/**
 * Fallback: Prerenders using React's renderToPipeableStream.
 */
function prerenderWithReact(
  element: ReactNode,
  ctx: RustPPRContext,
  startTime: number,
): Promise<RustPPRResult> {
  return new Promise((resolve, reject) => {
    let html = '';
    const holes: DynamicHole[] = [];
    let holeIdCounter = 0;

    const writable = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        html += chunk.toString('utf-8');
        callback();
      },
    });

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      onShellReady() {
        pipe(writable);
      },
      onAllReady() {
        // Extract Suspense boundaries as holes
        const holeRegex = /<template id="S:(\d+)">(.*?)<\/template>/gs;
        let match: RegExpExecArray | null;
        while ((match = holeRegex.exec(html)) !== null) {
          holes.push({
            id: `hole_${holeIdCounter++}`,
            suspenseId: match[1],
            fallbackHtml: match[2],
            filled: false,
          });
        }

        const wrappedHtml = wrapPPRHtml(html, ctx.match.route, holes, ctx.preloadHints);

        resolve({
          html: wrappedHtml,
          holes,
          usedRustEngine: false,
          renderTimeMs: Date.now() - startTime,
          shellSizeBytes: Buffer.byteLength(html, 'utf-8'),
          dynamicContentSizeBytes: holes.reduce((sum, h) => sum + Buffer.byteLength(h.fallbackHtml, 'utf-8'), 0),
        });
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

/**
 * Extracts dynamic holes from a Rust SSR result.
 */
function extractHolesFromRustResult(result: RustSSRResult): DynamicHole[] {
  return result.boundaries.map((b, i) => ({
    id: `hole_${i}`,
    suspenseId: b.id,
    fallbackHtml: b.fallbackHtml,
    filled: b.resolved,
    html: b.html,
  }));
}

/**
 * Wraps prerendered HTML with PPR-specific shell.
 */
function wrapPPRHtml(
  content: string,
  route: ResolvedRoute,
  holes: DynamicHole[],
  preloadHints?: PreloadHint[],
): string {
  const holeData = JSON.stringify(holes.map(h => ({
    id: h.id,
    suspenseId: h.suspenseId,
    filled: h.filled,
  })));

  const manifest: PledgeManifest = { pledges: [] };

  const result = renderHtmlShell({
    content,
    route,
    manifest,
    cssFiles: [pledgeAssetUrl('/__pledge__/client.css')],
    jsModules: [pledgeAssetUrl('/__pledge__/client.js')],
    preloadHints,
    suspenseBoundaryData: holeData,
  });

  return result.html;
}

/**
 * Error boundary for PPR prerendering.
 */
class PPRErrorBoundary extends Component<
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
 * Fills dynamic holes in a prerendered shell at request time.
 * Returns a ReadableStream that sends the static shell first, then
 * streams dynamic content as it resolves.
 */
export async function fillRustPPRHoles(
  ctx: RustPPRContext,
  _holes: DynamicHole[],
): Promise<ReadableStream<Uint8Array>> {
  const { match, tree, modules } = ctx;
  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Build full element tree with real params for dynamic rendering.
  // searchParams come from the request context — `match.pathname` never carries
  // a query string, so the old `split('?')[1]` was always empty.
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
      write(chunk: Buffer, _encoding: string, callback: () => void) {
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
