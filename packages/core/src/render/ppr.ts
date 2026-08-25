/**
 * Partial Prerendering (PPR) — static shell + streaming dynamic content.
 *
 * At build time, the static shell (layouts + non-dynamic parts of the page)
 * is prerendered to HTML. At request time, the dynamic holes are streamed
 * into the prerendered shell using React Suspense boundaries.
 *
 * This combines the speed of SSG with the flexibility of SSR:
 * - Static shell is served from cache immediately (TTFB ~0ms)
 * - Dynamic content streams in as it resolves (via Suspense)
 * - Works with any route that has a mix of static and dynamic content
 */

import { renderToPipeableStream } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, ResolvedRoute, PledgeConfig } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, HeadMetadata, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';

export interface PPRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  /** Prerendered static shell HTML (from build step) */
  staticShell?: string;
  /** Request-time query parameters, passed to the page as `searchParams`. */
  searchParams?: Record<string, string>;
  /** Whether this is the build-time prerender or request-time fill */
  isPrerender: boolean;
}

/**
 * Prerenders the static shell of a page at build time.
 * The shell includes everything that doesn't depend on request-specific data
 * (cookies, headers, searchParams, dynamic params).
 *
 * Dynamic content is wrapped in Suspense boundaries with placeholder fallbacks.
 * The resulting HTML is stored and served immediately at request time.
 */
export async function prerenderStaticShell(ctx: PPRContext): Promise<string> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  const metadata = await resolveMetadata(pageModule, match.params);
  const viewport = await resolveViewport(pageModule);

  // Build element tree with Suspense around dynamic content
  // During prerender, dynamic sections will show their loading fallback
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: {},
  });

  // Wrap page in error boundary
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(PPRErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  // Wrap in Suspense for dynamic content streaming
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

  const headHtml = await resolveHead(match.route, modules, metadata);
  const viewportTags = renderViewportTags(viewport);

  return new Promise((resolve, reject) => {
    let html = '';
    const writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        html += chunk.toString('utf-8');
        callback();
      },
    });

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      onShellReady() {
        pipe(writable);
      },
      onAllReady() {
        const wrapped = wrapPPRHtml(html, match.route, metadata, headHtml, viewportTags);
        resolve(wrapped);
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
 * Renders the request-time content for a PPR route and streams it inside the
 * prerendered shell's document envelope (reusing its <head> and closing
 * scripts when a `staticShell` is supplied). Returns a ReadableStream.
 *
 * Note: this streams a freshly-rendered tree into the shell envelope rather
 * than resuming a postponed React tree — true hole-level resume needs React's
 * experimental prerender/resume APIs. The prerendered shell's head/metadata is
 * reused; the body content is re-rendered at request time.
 */
export async function renderDynamicHoles(ctx: PPRContext): Promise<ReadableStream<Uint8Array>> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Build the full element tree — at request time, dynamic content resolves.
  // searchParams come from the request context; `match.pathname` never carries
  // a query string (the matcher strips it), so the previous `split('?')[1]`
  // was always undefined and dropped every query param.
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: ctx.searchParams ?? {},
  });

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

  // Reuse the prerendered static shell's document envelope when one was built,
  // so the prerendered <head> (metadata, stylesheet links) and closing scripts
  // are actually served and the dynamic content streams into the root. When no
  // shell is available, fall back to a minimal envelope. (Previously the shell
  // was ignored entirely and this hardcoded minimal wrapper was always used.)
  let shellBefore = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
  <div id="__pledge_root__">`;

  let shellAfter = `</div>
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;

  if (ctx.staticShell) {
    const marker = ctx.staticShell.indexOf('id="__pledge_root__"');
    if (marker !== -1) {
      const openEnd = ctx.staticShell.indexOf('>', marker) + 1;
      const closeIdx = ctx.staticShell.lastIndexOf('</div>');
      if (openEnd > 0 && closeIdx > openEnd) {
        shellBefore = ctx.staticShell.slice(0, openEnd);
        shellAfter = ctx.staticShell.slice(closeIdx);
      }
    }
  }

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

// --- Error Boundary (same pattern as other render modules) ---

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PPRErrorBoundary extends Component<
  { fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      return createElement(this.props.fallback, { error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

// --- Shared helpers ---

async function resolveMetadata(pageModule: PageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (pageModule.generateMetadata) {
    try {
      return await pageModule.generateMetadata(params);
    } catch {
      // Fall through to static metadata
    }
  }
  if (pageModule.metadata) {
    return pageModule.metadata as HeadMetadata;
  }
  return {};
}

async function resolveViewport(pageModule: PageModule): Promise<import('pledgestack-shared').Viewport | undefined> {
  if (pageModule.generateViewport) {
    try {
      return await pageModule.generateViewport();
    } catch {
      // Fall through to static viewport
    }
  }
  if (pageModule.viewport) {
    return pageModule.viewport;
  }
  return undefined;
}

async function resolveHead(
  route: ResolvedRoute,
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
  _metadata: HeadMetadata,
): Promise<string | undefined> {
  if (route.headFilePath) {
    const headModule = modules.get(route.headFilePath) as HeadModule | undefined;
    if (headModule) {
      try {
        const { renderToString } = await import('react-dom/server');
        const headElement = createElement(headModule.default, {});
        return renderToString(headElement);
      } catch {
        // Fall through
      }
    }
  }
  return undefined;
}

function renderViewportTags(viewport: import('pledgestack-shared').Viewport | undefined): string {
  if (!viewport) return '';
  const tags: string[] = [];
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${viewport.width}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (viewport.maximumScale !== undefined) parts.push(`maximum-scale=${viewport.maximumScale}`);
  if (viewport.userScalable !== undefined) parts.push(`user-scalable=${viewport.userScalable ? 'yes' : 'no'}`);
  if (viewport.viewportFit) parts.push(`viewport-fit=${viewport.viewportFit}`);
  if (parts.length > 0) tags.push(`<meta name="viewport" content="${parts.join(', ')}" />`);
  if (viewport.themeColor) tags.push(`<meta name="theme-color" content="${escapeHtml(viewport.themeColor)}" />`);
  if (viewport.colorScheme) tags.push(`<meta name="color-scheme" content="${escapeHtml(viewport.colorScheme)}" />`);
  return tags.join('\n  ');
}

function wrapPPRHtml(
  content: string,
  route: ResolvedRoute,
  metadata: HeadMetadata,
  headHtml: string | undefined,
  viewportTags: string,
): string {
  const headTags = headHtml ?? renderHeadTags(metadata, route);
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
  <div id="__pledge_root__" data-ppr="1">${content}</div>
  ${manifestScript}
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}

function renderHeadTags(metadata: HeadMetadata, route: ResolvedRoute): string {
  const tags: string[] = [];
  const title = metadata.title ?? route.metadata?.title ?? 'PledgeStack App';
  tags.push(`<title>${escapeHtml(title)}</title>`);
  if (metadata.description) {
    tags.push(`<meta name="description" content="${escapeHtml(metadata.description)}" />`);
  }
  return tags.join('\n  ');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
