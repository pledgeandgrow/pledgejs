import { renderToPipeableStream, renderToString } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, ResolvedRoute, PledgeConfig, Viewport, AnyGenericModule } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, HeadMetadata, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { createStreamingMetadata } from './streaming-metadata';

export interface StreamSSRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  /** Search params for the current request (Next.js 15 style page prop) */
  searchParams?: Record<string, string>;
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

  // #222: Streaming metadata — don't block TTFB on async generateMetadata()
  const metadataPromise = resolveMetadataPromise(pageModule, match.params);
  const streamingMeta = createStreamingMetadata(metadataPromise, match.route);
  const headHtml = await resolveHead(match.route, modules);
  const viewport = await resolveViewport(pageModule);

  // Use placeholder head tags for the initial shell
  const headTags = headHtml ?? streamingMeta.placeholder;

  // Pass params and searchParams as props (Next.js 15 style)
  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  // Wrap with error boundary
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(StreamErrorBoundary, { fallback: errorModule.default }, element);
    }
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
          // #222: Wait for metadata injector before finalizing HTML
          streamingMeta.injector.then((injectorScript) => {
            const wrapped = wrapStreamHtml(html, match.route, headTags, viewport, injectorScript);
            resolve(wrapped);
          }).catch(() => {
            const wrapped = wrapStreamHtml(html, match.route, headTags, viewport);
            resolve(wrapped);
          });
        });
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        if (!shellReady) {
          reject(error);
        }
      },
    });

    // Fallback: if streaming doesn't work, use renderToString
    setTimeout(() => {
      if (!shellReady) {
        try {
          const fallbackHtml = renderToString(createElement(() => element as ReactNode));
          streamingMeta.injector.then((injectorScript) => {
            resolve(wrapStreamHtml(fallbackHtml, match.route, headTags, viewport, injectorScript));
          }).catch(() => {
            resolve(wrapStreamHtml(fallbackHtml, match.route, headTags, viewport));
          });
        } catch (err) {
          reject(err);
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
  ${metadataInjector ?? ''}
  <script type="module" src="/__pledge__/client.js"></script>
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
