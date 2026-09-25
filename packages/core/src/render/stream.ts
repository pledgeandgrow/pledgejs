import { renderToPipeableStream, renderToString } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, ResolvedRoute, PledgeConfig, Viewport, AnyGenericModule, RenderSecurity } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest, splitDocumentMarkup, pledgeAssetUrl } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, HeadMetadata, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { renderHeadTags } from './head-tags';

export interface StreamSSRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  /** Search params for the current request (Next.js 15 style page prop) */
  searchParams?: Record<string, string>;
  /** Per-request security context — CSP nonce stamped on React-emitted scripts */
  security?: RenderSecurity;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class StreamErrorBoundary extends Component<{ fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode }, ErrorBoundaryState> {
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

/**
 * Default error fallback used when a route segment has no error.tsx — keeps
 * a render crash from propagating through every layout and killing the
 * whole stream.
 */
function StreamDefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return createElement(
    'div',
    { role: 'alert', style: { padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '0.5rem' } },
    createElement('h2', { style: { margin: '0 0 0.5rem', fontSize: '1rem' } }, 'Something went wrong'),
    createElement('p', { style: { margin: 0, color: '#6b7280' } }, error.message || 'An unexpected error occurred.'),
    createElement('button', { onClick: reset, style: { marginTop: '0.5rem' } }, 'Try again'),
  );
}

/**
 * Renders a route match to a streaming HTML response.
 * Uses renderToPipeableStream for Suspense boundary streaming.
 * Sends the shell HTML immediately, then streams deferred content as it resolves.
 *
 * Delegates to the active renderer adapter if initialized (framework-agnostic).
 * Falls back to the built-in React renderer if no adapter is registered.
 */
export async function renderSSRStream(ctx: StreamSSRContext): Promise<string> {
  // Try to use the renderer adapter (framework-agnostic path)
  try {
    const { getRenderer, isRendererInitialized } = await import('./renderer-manager');
    if (isRendererInitialized()) {
      const renderer = getRenderer();
      return renderer.renderToStream({
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

  // This path buffers the full response into a string before returning, so
  // there is no partial flush to protect: resolve the metadata up front and
  // emit the real <title>/<meta> tags directly. The previous placeholder +
  // client-side injector approach produced a guaranteed flash of placeholder
  // metadata (and only makes sense for a truly progressive stream, which this
  // buffered path is not — see renderRSCStream for the streaming path).
  const metadata = await Promise.resolve(resolveMetadataPromise(pageModule, match.params));
  const headHtml = await resolveHead(match.route, modules);
  const viewport = await resolveViewport(pageModule);

  const headTags = headHtml ?? renderHeadTags(metadata, match.route);

  // Pass params and searchParams as props (Next.js 15 style)
  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  // Wrap with error boundary — route's error.tsx when present, else the
  // built-in default so a page crash can't kill the whole stream.
  {
    const errorModule = match.route.errorFilePath
      ? (modules.get(match.route.errorFilePath) as ErrorModule | undefined)
      : undefined;
    element = createElement(
      StreamErrorBoundary,
      { fallback: errorModule?.default ?? StreamDefaultErrorFallback },
      element,
    );
  }

  // Wrap with Suspense boundary for streaming
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
          layoutContent = createElement(StreamErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
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

  return new Promise((resolve, reject) => {
    let html = '';
    let shellReady = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      fn();
    };

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      // React stamps this nonce on its own emitted inline scripts ($RT
      // timing + suspense-boundary scripts) — required by the strict CSP.
      nonce: ctx.security?.cspNonce,
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
          settle(() => resolve(wrapStreamHtml(html, match.route, headTags, viewport)));
        });
        stream.on('error', (err) => {
          settle(() => reject(err));
        });
      },
      onShellError(error) {
        settle(() => reject(error));
      },
      onError(error) {
        if (!shellReady) {
          settle(() => reject(error));
        }
      },
    });

    // Fallback: if the shell never becomes ready within 5s, fall back to
    // renderToString so the request cannot hang indefinitely. Cleared on
    // settlement to avoid a dangling timer keeping the event loop alive.
    const fallbackTimer = setTimeout(() => {
      if (!shellReady) {
        try {
          const fallbackHtml = renderToString(createElement(() => element as ReactNode));
          settle(() => resolve(wrapStreamHtml(fallbackHtml, match.route, headTags, viewport)));
        } catch (err) {
          settle(() => reject(err));
        }
      }
    }, 5000);
  });
}

/**
 * Returns metadata as a Promise (or resolved value if sync).
 */
function resolveMetadataPromise(pageModule: PageModule, params: Record<string, string>): Promise<HeadMetadata> | HeadMetadata {
  if (pageModule.generateMetadata) {
    try {
      return pageModule.generateMetadata(params);
    } catch {
      // Fall through to static metadata
    }
  }
  if (pageModule.metadata) {
    return pageModule.metadata as HeadMetadata;
  }
  return {};
}

async function resolveHead(
  route: ResolvedRoute,
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
): Promise<string | undefined> {
  if (route.headFilePath) {
    const headModule = modules.get(route.headFilePath) as HeadModule | undefined;
    if (headModule) {
      try {
        const headElement = createElement(headModule.default, {});
        const headContent = renderToString(headElement);
        return headContent;
      } catch {
        // Fall through
      }
    }
  }
  return undefined;
}

function wrapStreamHtml(content: string, _route: ResolvedRoute, headTags: string, viewport?: Viewport, metadataInjector?: string): string {
  const viewportTags = renderViewportTags(viewport);
  const manifest: PledgeManifest = { pledges: [] };
  const manifestScript = `<script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;

  // A root layout that renders a full <html> document owns head/body — hoist
  // its head children into the real head, mount only its body children.
  const doc = splitDocumentMarkup(content);
  const headInner = doc ? `${headTags}\n  ${doc.head}` : headTags;
  const bodyInner = doc ? doc.body : content;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headInner}
  <link rel="stylesheet" href="${pledgeAssetUrl('/__pledge__/client.css')}" />
</head>
<body>
  <div id="__pledge_root__">${bodyInner}</div>
  ${manifestScript}
  ${metadataInjector ?? ''}
  <script type="module" src="${pledgeAssetUrl('/__pledge__/client.js')}"></script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function resolveViewport(pageModule: PageModule): Promise<Viewport | undefined> {
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

function renderViewportTags(viewport: Viewport | undefined): string {
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
