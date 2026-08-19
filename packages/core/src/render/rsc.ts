import { renderToPipeableStream } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, PledgeConfig, AnyGenericModule } from 'pledgestack-shared';
import type { PageModule, LayoutModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';

export interface RSCPayload {
  /** The serialized RSC tree as a string */
  tree: string;
  /** Module map for client-side resolution: moduleId -> chunkPath */
  moduleMap: Record<string, string>;
  /** Client component references that need to be loaded on the client */
  clientReferences: ClientReference[];
}

export interface ClientReference {
  /** Module ID in the client bundle */
  moduleId: string;
  /** Export name (e.g. 'default') */
  exportName: string;
  /** Chunk path for lazy loading */
  chunkPath: string;
}

export interface RSCContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule>;
  /** Client reference manifest mapping server modules to client chunks */
  clientManifest?: Record<string, string>;
  /** Search params for the current request (Next.js 15 style page prop) */
  searchParams?: Record<string, string>;
}

/**
 * Renders an RSC payload to a full HTML document with streaming.
 * Used for the initial server render with RSC support.
 *
 * Returns a ReadableStream that progressively sends HTML chunks
 * instead of buffering everything into a single string.
 *
 * Delegates to the active renderer adapter if initialized (framework-agnostic).
 * The React adapter uses real react-server-dom-webpack/server for flight payloads.
 * Falls back to the built-in React streaming SSR if no adapter is registered.
 */
export async function renderRSCToHTMLStream(ctx: RSCContext): Promise<ReadableStream<Uint8Array>> {
  // Try to use the renderer adapter (framework-agnostic path)
  try {
    const { getRenderer, isRendererInitialized } = await import('./renderer-manager');
    if (isRendererInitialized()) {
      const renderer = getRenderer();
      if (renderer.renderRSCStream) {
        return renderer.renderRSCStream({
          match: ctx.match,
          tree: ctx.tree,
          modules: ctx.modules as unknown as Map<string, AnyGenericModule>,
          searchParams: ctx.searchParams,
          rsc: ctx.config.rsc,
          clientManifest: ctx.clientManifest,
        });
      }
      return renderer.renderToReadableStream({
        match: ctx.match,
        tree: ctx.tree,
        modules: ctx.modules as unknown as Map<string, AnyGenericModule>,
        searchParams: ctx.searchParams,
      });
    }
  } catch {
    // Renderer not available — fall through to built-in React renderer
  }

  // Built-in React renderer (backward compatibility)
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Pass params and searchParams as props (Next.js 15 style)
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

  const encoder = new TextEncoder();
  const shellBefore = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${match.route.metadata?.title ?? 'PledgeStack App'}</title>\n  <link rel="stylesheet" href="/__pledge__/client.css" />\n</head>\n<body>\n  <div id="__pledge_root__">`;

  const clientRefs = JSON.stringify(extractClientReferences(ctx));
  const serializedManifest = JSON.stringify(ctx.clientManifest ?? {});

  const shellAfter = `</div>\n  <script id="__pledge_rsc_data__" type="application/json">${clientRefs}</script>\n  <script id="__pledge_manifest__" type="application/json">${serializedManifest}</script>\n  <script type="module" src="/__pledge__/client.js"></script>\n  <script type="module" src="/__pledge__/rsc-client.js"></script>\n</body>\n</html>`;

  return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
    let shellReady = false;
    let resolved = false;
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

    const { pipe } = renderToPipeableStream(createElement(() => element), {
      bootstrapModules: getBootstrapModules(ctx),
      onShellReady() {
        shellReady = true;
        pipe(writable);
      },
      onAllReady() {
        if (resolved) return;
        resolved = true;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(shellBefore));
            const content = Buffer.concat(chunks).toString('utf-8');
            controller.enqueue(encoder.encode(content));
            controller.enqueue(encoder.encode(shellAfter));
            controller.close();
          },
        });
        resolve(stream);
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
 * Backward-compatible wrapper that buffers the streaming RSC render into a string.
 * Prefer renderRSCToHTMLStream for true streaming.
 *
 * Delegates to the active renderer adapter's renderRSC if available (React only).
 */
export async function renderRSCToHTML(ctx: RSCContext): Promise<string> {
  // Try to use the renderer adapter's renderRSC (React only — produces real flight payload)
  try {
    const { getRenderer, isRendererInitialized } = await import('./renderer-manager');
    if (isRendererInitialized()) {
      const renderer = getRenderer();
      if (renderer.renderRSC) {
        return renderer.renderRSC({
          match: ctx.match,
          tree: ctx.tree,
          modules: ctx.modules as unknown as Map<string, AnyGenericModule>,
          searchParams: ctx.searchParams,
          rsc: ctx.config.rsc,
          clientManifest: ctx.clientManifest,
        });
      }
    }
  } catch {
    // Renderer not available — fall through to built-in
  }

  // Built-in: buffer the streaming render
  const stream = await renderRSCToHTMLStream(ctx);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

/**
 * Gets the bootstrap module paths for client hydration.
 */
function getBootstrapModules(ctx: RSCContext): string[] {
  const mods: string[] = ['/__pledge__/client.js'];
  if (ctx.config.rsc) {
    mods.push('/__pledge__/rsc-client.js');
  }
  return mods;
}

/**
 * Extracts client component references from the module map.
 */
function extractClientReferences(ctx: RSCContext): ClientReference[] {
  const refs: ClientReference[] = [];
  if (ctx.clientManifest) {
    for (const [moduleId, chunkPath] of Object.entries(ctx.clientManifest)) {
      refs.push({ moduleId, exportName: 'default', chunkPath });
    }
  }
  return refs;
}

/**
 * Deserializes an RSC payload on the client side.
 * Reconstructs the React tree from the serialized stream data.
 */
export async function hydrateRSC(payload: RSCPayload): Promise<ReactNode> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload.tree));
      controller.close();
    },
  });

  try {
    const mod = await import('react-server-dom-webpack/client') as { createFromReadableStream?: (s: ReadableStream<Uint8Array>) => Promise<ReactNode> };
    if (mod.createFromReadableStream) {
      return (mod as { createFromReadableStream: (s: ReadableStream<Uint8Array>) => Promise<ReactNode> }).createFromReadableStream(stream);
    }
  } catch {
    // Module not available in this environment
  }

  throw new Error('react-server-dom-webpack/client is not available. Ensure the client bundle includes RSC support.');
}
