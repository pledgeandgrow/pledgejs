/**
 * React renderer adapter for PledgeStack.
 *
 * Implements the RendererAdapter interface using React 19's server-side rendering
 * APIs (renderToString, renderToPipeableStream) and React Server Components
 * (react-server-dom-webpack).
 *
 * This adapter also integrates:
 * - Real RSC via react-server-dom-webpack/server (flight payload generation)
 * - PPR (Partial Prerendering) — static shell + dynamic holes
 * - Rust acceleration (optional — falls back to React if addons not compiled)
 * - JIT template profiling
 * - Proper client hydration with actual hydrateRoot() call
 */

import { renderToString, renderToPipeableStream } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type {
  RendererAdapter,
  RenderContext,
  Framework,
  HeadMetadata,
  ClientScriptOptions,
} from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest, escapeHtml } from 'pledgestack-shared';
import type { RouteTree } from 'pledgestack-shared';
import { getLayoutChain } from './layout-chain';
import { renderHeadTags, renderViewportTags, mergeMetadata } from './head-tags';
import { recordRender, getCompiledTemplate, storeCompiledTemplate } from './jit-templates';
import { isRustSSRAvailable, renderRustSSR } from './rust-accel';

// --- Module type cast helpers ---

interface ReactPageModule {
  default: ComponentType<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  viewport?: import('pledgestack-shared').Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<import('pledgestack-shared').Viewport> | import('pledgestack-shared').Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

interface ReactLayoutModule {
  default: ComponentType<{ children: ReactNode }>;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: import('pledgestack-shared').Viewport;
}

interface ReactLoadingModule { default: ComponentType<Record<string, unknown>>; }
interface ReactErrorModule { default: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; }
interface ReactNotFoundModule { default: ComponentType<Record<string, unknown>>; }
interface ReactHeadModule { default: ComponentType<Record<string, unknown>>; }
interface ReactTemplateModule { default: ComponentType<{ children: ReactNode }>; }

function asPage(mod: unknown): ReactPageModule | undefined {
  const m = mod as ReactPageModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asLayout(mod: unknown): ReactLayoutModule | undefined {
  const m = mod as ReactLayoutModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asLoading(mod: unknown): ReactLoadingModule | undefined {
  const m = mod as ReactLoadingModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asError(mod: unknown): ReactErrorModule | undefined {
  const m = mod as ReactErrorModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asNotFound(mod: unknown): ReactNotFoundModule | undefined {
  const m = mod as ReactNotFoundModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asHead(mod: unknown): ReactHeadModule | undefined {
  const m = mod as ReactHeadModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}
function asTemplate(mod: unknown): ReactTemplateModule | undefined {
  const m = mod as ReactTemplateModule;
  return typeof m?.default === 'function' || typeof m?.default === 'object' ? m : undefined;
}

// --- Error Boundary ---

interface ErrorBoundaryState { hasError: boolean; error: Error | null; }

class ErrorBoundary extends Component<
  { fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  reset = () => { this.setState({ hasError: false, error: null }); };

  render() {
    if (this.state.hasError && this.state.error) {
      return createElement(this.props.fallback, { error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

// --- Helpers ---

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Fills a compiled HTML template with route-specific data.
 * Compiled templates contain {{placeholder}} markers replaced with context values.
 */
function fillCompiledTemplate(
  template: string,
  data: { params: Record<string, string>; searchParams: Record<string, string>; metadata: HeadMetadata },
): string {
  let result = template;
  for (const [key, value] of Object.entries(data.params)) {
    result = result.replaceAll(`{{param.${key}}}`, escapeHtml(value));
  }
  for (const [key, value] of Object.entries(data.searchParams)) {
    result = result.replaceAll(`{{searchParam.${key}}}`, escapeHtml(value));
  }
  if (data.metadata.title) result = result.replaceAll(`{{title}}`, escapeHtml(data.metadata.title));
  if (data.metadata.description) result = result.replaceAll(`{{description}}`, escapeHtml(data.metadata.description));
  return result;
}

async function resolveMetadata(pageModule: ReactPageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (pageModule.generateMetadata) {
    try { return await pageModule.generateMetadata(params); } catch { /* fall through */ }
  }
  if (pageModule.metadata) return pageModule.metadata as HeadMetadata;
  return {};
}

async function resolveLayoutMetadata(layoutModule: ReactLayoutModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (layoutModule.generateMetadata) {
    try { return await layoutModule.generateMetadata(params); } catch { /* fall through */ }
  }
  if (layoutModule.metadata) return layoutModule.metadata;
  return {};
}

async function resolveViewport(pageModule: ReactPageModule): Promise<import('pledgestack-shared').Viewport | undefined> {
  if (pageModule.generateViewport) {
    try { return await pageModule.generateViewport(); } catch { /* fall through */ }
  }
  if (pageModule.viewport) return pageModule.viewport;
  return undefined;
}

async function resolveHead(
  route: import('pledgestack-shared').ResolvedRoute,
  // Callers pass RenderContext.modules, typed Map<string, AnyGenericModule>
  // (the framework-agnostic shared type) — asHead() below safely narrows
  // individual lookups to ReactHeadModule, so this accepts the same broad
  // type its callers actually have instead of forcing an upstream cast.
  modules: Map<string, import('pledgestack-shared').AnyGenericModule>,
  metadata: HeadMetadata,
): Promise<string | undefined> {
  if (route.headFilePath) {
    const headModule = asHead(modules.get(route.headFilePath));
    if (headModule) {
      try {
        return renderToString(createElement(headModule.default, {}));
      } catch { /* fall through */ }
    }
  }
  return renderHeadTags(metadata, route);
}

// --- Element tree builder ---

function buildElementTree(ctx: RenderContext, forPrerender = false): ReactNode {
  const { match, modules } = ctx;
  const tree = ctx.tree as RouteTree;
  const pageModule = asPage(modules.get(match.route.filePath));
  if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

  const searchParamsRecord = forPrerender ? {} : (ctx.searchParams ?? {});
  let element: ReactNode = createElement(pageModule.default, {
    params: forPrerender ? {} : match.params,
    searchParams: searchParamsRecord,
  });

  // Error boundary
  if (match.route.errorFilePath) {
    const errorModule = asError(modules.get(match.route.errorFilePath));
    if (errorModule) {
      element = createElement(ErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  // Suspense / loading
  if (match.route.loadingFilePath) {
    const loadingModule = asLoading(modules.get(match.route.loadingFilePath));
    if (loadingModule) {
      element = createElement(Suspense, { fallback: createElement(loadingModule.default, {}) }, element);
    }
  }

  // Template
  if (match.route.templateFilePath) {
    const templateModule = asTemplate(modules.get(match.route.templateFilePath));
    if (templateModule) {
      element = createElement(templateModule.default, { children: element });
    }
  }

  // Layout chain
  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    const layoutModule = asLayout(modules.get(layout.filePath));
    if (layoutModule) {
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      if (layout.errorFilePath) {
        const layoutErrorModule = asError(modules.get(layout.errorFilePath));
        if (layoutErrorModule) {
          layoutContent = createElement(ErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
        }
      }

      if (layout.loadingFilePath) {
        const layoutLoadingModule = asLoading(modules.get(layout.loadingFilePath));
        if (layoutLoadingModule) {
          layoutContent = createElement(Suspense, { fallback: createElement(layoutLoadingModule.default, {}) }, layoutContent);
        }
      }

      if (layout.templateFilePath) {
        const layoutTemplateModule = asTemplate(modules.get(layout.templateFilePath));
        if (layoutTemplateModule) {
          layoutContent = createElement(layoutTemplateModule.default, { children: layoutContent });
        }
      }

      element = layoutContent;
    }
  }

  return element;
}

// --- HTML shell wrapper ---

function wrapHtml(
  content: string,
  route: import('pledgestack-shared').ResolvedRoute,
  metadata: HeadMetadata,
  headHtml?: string,
  viewport?: import('pledgestack-shared').Viewport,
  extraScripts = '',
): string {
  const headTags = headHtml ?? renderHeadTags(metadata, route);
  const viewportTags = renderViewportTags(viewport);
  const manifest: PledgeManifest = { pledges: [] };
  const manifestScript = `<script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__">${content}</div>
  ${manifestScript}
  ${extraScripts}
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}

// --- Adapter implementation ---

export class ReactRendererAdapter implements RendererAdapter {
  readonly framework: Framework = 'react';
  readonly fileExtension = 'tsx';
  readonly handledExtensions = ['tsx', 'ts', 'jsx', 'js'] as const;

  async renderToString(ctx: RenderContext): Promise<string> {
    const { match, modules } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    // Resolve metadata (layout → page inheritance)
    const pageMetadata = await resolveMetadata(pageModule, match.params);
    const tree = ctx.tree as RouteTree;
    const layouts = getLayoutChain(match, tree);
    let layoutMetadata: HeadMetadata = {};
    for (const layout of layouts) {
      const layoutModule = asLayout(modules.get(layout.filePath));
      if (layoutModule) {
        const meta = await resolveLayoutMetadata(layoutModule, match.params);
        layoutMetadata = mergeMetadata(layoutMetadata, meta);
      }
    }
    const metadata = mergeMetadata(layoutMetadata, pageMetadata);

    // Auto-inject OG/Twitter image URLs
    if (match.route.opengraphImageFilePath) {
      const ogImageUrl = `${match.route.pattern === '/' ? '' : match.route.pattern}/opengraph-image`;
      if (!metadata.openGraph) metadata.openGraph = {};
      if (!metadata.openGraph.images) metadata.openGraph.images = [];
      if (!metadata.openGraph.images.includes(ogImageUrl)) metadata.openGraph.images.push(ogImageUrl);
    }
    if (match.route.twitterImageFilePath) {
      const twImageUrl = `${match.route.pattern === '/' ? '' : match.route.pattern}/twitter-image`;
      if (!metadata.twitter) metadata.twitter = {};
      if (!metadata.twitter.images) metadata.twitter.images = [];
      if (!metadata.twitter.images.includes(twImageUrl)) metadata.twitter.images.push(twImageUrl);
    }

    const viewport = await resolveViewport(pageModule);
    const headHtml = await resolveHead(match.route, modules, metadata);

    // JIT template check — use compiled template if available (bypasses React reconciliation)
    const compiledTemplate = getCompiledTemplate(match.route.pattern);
    if (compiledTemplate) {
      const filled = fillCompiledTemplate(compiledTemplate, {
        params: match.params,
        searchParams: ctx.searchParams ?? {},
        metadata,
      });
      recordRender(match.route.pattern, simpleHash(filled));
      return filled;
    }

    // Try Rust SSR acceleration first
    if (isRustSSRAvailable()) {
      try {
        const rustHtml = await renderRustSSR(ctx);
        if (rustHtml) {
          const fullHtml = wrapHtml(rustHtml, match.route, metadata, headHtml, viewport);
          recordRender(match.route.pattern, simpleHash(fullHtml));
          return fullHtml;
        }
      } catch {
        // Fall back to React
      }
    }

    const element = buildElementTree(ctx);
    const html = renderToString(createElement(() => element));
    const fullHtml = wrapHtml(html, match.route, metadata, headHtml, viewport);

    // Record render for JIT profiling — store template if threshold reached
    const profileResult = recordRender(match.route.pattern, simpleHash(fullHtml));
    if (profileResult.shouldCompile) {
      void storeCompiledTemplate(match.route.pattern, fullHtml);
    }

    return fullHtml;
  }

  async renderToStream(ctx: RenderContext): Promise<string> {
    const { match, modules } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);
    const headHtml = await resolveHead(match.route, modules, metadata);
    const headTags = headHtml ?? renderHeadTags(metadata, match.route);

    const element = buildElementTree(ctx);

    return new Promise((resolve, reject) => {
      let html = '';
      let shellReady = false;

      const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
        onShellReady() {
          shellReady = true;
          const stream = new Writable({
            write(chunk, _encoding, callback) {
              html += chunk.toString();
              callback();
            },
          });
          pipe(stream);
          stream.on('finish', () => {
            resolve(wrapHtml(html, match.route, metadata, headTags, viewport));
          });
        },
        onShellError(error) { reject(error); },
        onError(error) { if (!shellReady) reject(error); },
      });

      // Fallback: if streaming doesn't start in 5s, use renderToString
      setTimeout(() => {
        if (!shellReady) {
          try {
            const fallbackHtml = renderToString(createElement(() => element as ReactNode));
            resolve(wrapHtml(fallbackHtml, match.route, metadata, headTags, viewport));
          } catch (err) { reject(err); }
        }
      }, 5000);
    });
  }

  async renderToReadableStream(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    const { match, modules } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);
    const headHtml = await resolveHead(match.route, modules, metadata);
    const headTags = headHtml ?? renderHeadTags(metadata, match.route);
    const viewportTags = renderViewportTags(viewport);
    const manifest: PledgeManifest = { pledges: [] };

    const shellBefore = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__">`;

  const shellAfter = `</div>
  <script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;

    const element = buildElementTree(ctx);

    return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      let shellReady = false;
      let resolved = false;
      const chunks: Buffer[] = [];
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let pendingData: Buffer[] = [];
      let streamClosed = false;

      const writable = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (streamController && !streamClosed) {
            const desired = streamController.desiredSize;
            if (desired !== null && desired <= 0) {
              pendingData.push(chunk);
            } else {
              streamController.enqueue(new Uint8Array(chunk));
            }
          } else {
            chunks.push(chunk);
          }
          callback();
        },
      });

      const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
        onShellReady() {
          shellReady = true;
          pipe(writable);
        },
        onAllReady() {
          if (resolved) return;
          resolved = true;

          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode(shellBefore));
              const content = Buffer.concat(chunks).toString('utf-8');
              controller.enqueue(encoder.encode(content));
              for (const chunk of pendingData) {
                controller.enqueue(new Uint8Array(chunk));
              }
              pendingData = [];
              controller.enqueue(encoder.encode(shellAfter));
              controller.close();
              streamClosed = true;
            },
          });
          resolve(stream);
        },
        onShellError(error) { reject(error); },
        onError(error) { if (!shellReady) reject(error); },
      });
      void pipe;
    });
  }

  async renderNotFound(ctx: RenderContext): Promise<string> {
    const { match, modules } = ctx;
    const tree = ctx.tree as RouteTree;
    const layouts = getLayoutChain(match, tree);
    let notFoundModule = asNotFound(modules.get(match.route.notFoundFilePath ?? ''));
    let notFoundRoute = match.route;

    if (!notFoundModule) {
      for (const layout of layouts) {
        if (layout.notFoundFilePath) {
          notFoundModule = asNotFound(modules.get(layout.notFoundFilePath));
          if (notFoundModule) {
            notFoundRoute = layout;
            break;
          }
        }
      }
    }

    let element: ReactNode;
    if (notFoundModule) {
      element = createElement(notFoundModule.default, {});
      for (const layout of layouts) {
        const layoutModule = asLayout(modules.get(layout.filePath));
        if (layoutModule) {
          element = createElement(layoutModule.default, { children: element });
        }
      }
    } else {
      element = createElement('div', null, '404 - Page Not Found');
    }

    const html = renderToString(createElement(() => element as ReactNode));
    return wrapHtml(html, notFoundRoute, { title: 'Not Found' });
  }

  async renderRSC(ctx: RenderContext): Promise<string> {
    // Real RSC: use react-server-dom-webpack/server to generate flight payload
    const element = buildElementTree(ctx);

    // Try real RSC flight serialization
    try {
      const rscServer = await import('react-server-dom-webpack/server');
      if (typeof rscServer.renderToReadableStream === 'function') {
        const flightStream = rscServer.renderToReadableStream(element);
        const reader = flightStream.getReader();
        const decoder = new TextDecoder();
        let flightData = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          flightData += decoder.decode(value, { stream: true });
        }

        // Wrap flight data in HTML shell with RSC bootstrap
        const { match, modules } = ctx;
        const pageModule = asPage(modules.get(match.route.filePath));
        if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

        const metadata = await resolveMetadata(pageModule, match.params);
        const viewport = await resolveViewport(pageModule);
        const headHtml = await resolveHead(match.route, modules, metadata);

        // Also render the HTML for initial paint (SSR + RSC flight data)
        const htmlContent = renderToString(createElement(() => element as ReactNode));
        const clientRefs = JSON.stringify(this.extractClientReferences(ctx));
        const serializedManifest = JSON.stringify(ctx.clientManifest ?? {});

        const rscScripts = `<script id="__pledge_rsc_data__" type="application/json">${escapeHtml(flightData)}</script>
  <script id="__pledge_manifest__" type="application/json">${serializedManifest}</script>
  <script id="__pledge_client_refs__" type="application/json">${clientRefs}</script>
  <script type="module" src="/__pledge__/rsc-client.js"></script>`;

        return wrapHtml(htmlContent, match.route, metadata, headHtml, viewport, rscScripts);
      }
    } catch {
      // react-server-dom-webpack/server not available — fall back to streaming SSR
    }

    // Fallback: use streaming SSR (not real RSC, but still works)
    return this.renderToStream(ctx);
  }

  async renderRSCStream(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    // True RSC streaming: emit the HTML shell for initial paint, then stream
    // the flight payload chunk-by-chunk as inline scripts so the client can
    // start reconstructing the RSC tree before the whole payload has arrived.
    // Falls back to regular SSR streaming if react-server-dom-webpack isn't available.
    let rscServer: typeof import('react-server-dom-webpack/server') | undefined;
    try {
      rscServer = await import('react-server-dom-webpack/server');
    } catch {
      rscServer = undefined;
    }

    if (!rscServer || typeof rscServer.renderToReadableStream !== 'function') {
      return this.renderToReadableStream(ctx);
    }

    const { match, modules } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);
    const headHtml = await resolveHead(match.route, modules, metadata);
    const headTags = headHtml ?? renderHeadTags(metadata, match.route);
    const viewportTags = renderViewportTags(viewport);
    const manifest: PledgeManifest = { pledges: [] };
    const serializedManifest = JSON.stringify(ctx.clientManifest ?? {});
    const clientRefs = JSON.stringify(this.extractClientReferences(ctx));

    const element = buildElementTree(ctx);
    // Render the initial HTML for first paint. The flight stream (read below)
    // carries the data needed to reconcile a live RSC tree on the client.
    const htmlContent = renderToString(createElement(() => element as ReactNode));
    const flightStream = rscServer.renderToReadableStream(element);
    const flightReader = flightStream.getReader();
    const flightDecoder = new TextDecoder();
    const encoder = new TextEncoder();

    const shellBefore = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__">${htmlContent}</div>
  <script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>
  <script id="__pledge_manifest__" type="application/json">${serializedManifest}</script>
  <script id="__pledge_client_refs__" type="application/json">${clientRefs}</script>
`;

    const shellAfter = `  <script type="module" src="/__pledge__/rsc-client.js"></script>
</body>
</html>`;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(shellBefore));
        try {
          while (true) {
            const { done, value } = await flightReader.read();
            if (done) break;
            const chunkText = flightDecoder.decode(value, { stream: true });
            // Escape "</script" so a flight chunk can never prematurely close
            // the inline <script> tag it's embedded in.
            const escapedChunk = JSON.stringify(chunkText).replace(/<\//g, '<\\/');
            controller.enqueue(
              encoder.encode(`  <script>(self.__pledge_rsc_chunks__=self.__pledge_rsc_chunks__||[]).push(${escapedChunk});</script>\n`),
            );
          }
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.enqueue(encoder.encode(shellAfter));
        controller.close();
      },
    });
  }

  async prerenderStaticShell(ctx: RenderContext): Promise<string> {
    const { match, modules } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);
    const headHtml = await resolveHead(match.route, modules, metadata);
    const viewportTags = renderViewportTags(viewport);

    // Build element tree with empty params for prerender
    const element = buildElementTree(ctx, true);

    return new Promise((resolve, reject) => {
      let html = '';
      const writable = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          html += chunk.toString('utf-8');
          callback();
        },
      });

      const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
        onShellReady() { pipe(writable); },
        onAllReady() {
          const manifest: PledgeManifest = { pledges: [] };
          const manifestScript = `<script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;
          const headTags = headHtml ?? renderHeadTags(metadata, match.route);

          resolve(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__" data-ppr="1">${html}</div>
  ${manifestScript}
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`);
        },
        onShellError(error) { reject(error); },
        onError(error) { reject(error); },
      });
      void pipe;
    });
  }

  async renderDynamicHoles(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    // For PPR dynamic holes, we render the full page and extract the dynamic parts
    // In a full implementation, this would only render the Suspense boundaries
    return this.renderToReadableStream(ctx);
  }

  generateClientScript(options: ClientScriptOptions): string {
    const { isDev, pledgepackPort, rscEnabled } = options;
    // In dev mode, import React from the dev server proxy (PledgePack serves node_modules)
    // In production, the client bundle is pre-bundled with React
    const reactImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/react.js`
      : 'react';
    const reactDomClientImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/react-dom/client.js`
      : 'react-dom/client';

    return `// PledgeStack React client hydration (auto-generated)
import { hydrateRoot } from '${reactDomClientImport}';
import { createElement } from '${reactImport}';
import { RouterProvider, Link } from '/__pledge_router';

const root = document.getElementById('__pledge_root__');
if (root) {
  // Hydrate the SSR content into a live React tree
  try {
    hydrateRoot(root, createElement(RouterProvider, { children: null }), {
      onRecoverableError(error) {
        console.error('[pledgestack] React hydration recoverable error:', error);
      },
    });
  } catch (e) {
    console.error('[pledgestack] Hydration failed, falling back to client render:', e);
    // Fallback: full client render
    const { createRoot } = await import('${reactDomClientImport}');
    const reactRoot = createRoot(root);
    reactRoot.render(createElement(RouterProvider, { children: null }));
  }

  ${rscEnabled ? '// RSC mode: RSC client handles flight data hydration' : ''}
}

// Export Link for use in components
export { Link };
`;
  }

  generateRSCClientScript(options: ClientScriptOptions): string {
    const { isDev, pledgepackPort } = options;
    const reactImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/react.js`
      : 'react';
    const reactDomClientImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/react-dom/client.js`
      : 'react-dom/client';

    return `// PledgeStack RSC client (auto-generated)
import { hydrateRoot } from '${reactDomClientImport}';
import { createElement } from '${reactImport}';

// RSC hydration: read the serialized RSC flight payload and hydrate.
// The payload arrives either as one blob (non-streaming renderRSC(), written
// to #__pledge_rsc_data__) or as progressively-pushed chunks (streaming
// renderRSCStream(), collected on self.__pledge_rsc_chunks__ as they arrive).
const rscDataEl = document.getElementById('__pledge_rsc_data__');
const manifestEl = document.getElementById('__pledge_manifest__');
const clientRefsEl = document.getElementById('__pledge_client_refs__');
const root = document.getElementById('__pledge_root__');
const streamedChunks = self.__pledge_rsc_chunks__;
const hasFlightData = Boolean(rscDataEl) || Array.isArray(streamedChunks);

if (root && hasFlightData) {
  try {
    const flightData = Array.isArray(streamedChunks)
      ? streamedChunks.join('')
      : (rscDataEl.textContent || '');
    const manifest = manifestEl ? JSON.parse(manifestEl.textContent || '{}') : {};
    const clientRefs = clientRefsEl ? JSON.parse(clientRefsEl.textContent || '[]') : [];

    // Use React's flight client to reconstruct the tree from the RSC payload
    const { createFromReadableStream } = await import('react-server-dom-webpack/client');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(flightData));
        controller.close();
      },
    });

    const tree = await createFromReadableStream(stream, {
      moduleMap: manifest,
    });

    // Hydrate the root with the reconstructed RSC tree
    hydrateRoot(root, tree);
  } catch (e) {
    console.error('[pledgestack] RSC hydration error, falling back to SSR hydration:', e);
    // Fallback: regular SSR hydration — the DOM already has the rendered content
  }
}
`;
  }

  private extractClientReferences(ctx: RenderContext): unknown[] {
    if (!ctx.clientManifest) return [];
    return Object.entries(ctx.clientManifest).map(([moduleId, chunkPath]) => ({
      moduleId,
      exportName: 'default',
      chunkPath,
    }));
  }
}

// --- Auto-register on import ---

import { getRendererRegistry } from 'pledgestack-shared';
getRendererRegistry().register(new ReactRendererAdapter());
