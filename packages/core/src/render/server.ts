import { renderToString } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import type { RouteMatch, ResolvedRoute, PledgeConfig, Viewport } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, HeadMetadata, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { renderHeadTags, renderViewportTags, mergeMetadata } from './head-tags';
import { recordRender, getCompiledTemplate } from '../psx/jit-templates';

/** Simple string hash for template profiling */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface SSRContext {
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

class ErrorBoundary extends Component<{ fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode }, ErrorBoundaryState> {
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
 * Renders a route match to an HTML string using SSR.
 * Wraps the page in its layout chain with loading and error boundaries.
 */
export async function renderSSR(ctx: SSRContext): Promise<string> {
  const { match, tree, modules } = ctx;

  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Resolve page metadata (from generateMetadata or static metadata export)
  const pageMetadata = await resolveMetadata(pageModule, match.params);

  // Resolve layout metadata and merge with page metadata (layout → page inheritance)
  const layouts = getLayoutChain(match, tree);
  let layoutMetadata: HeadMetadata = {};
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      const meta = await resolveLayoutMetadata(layoutModule, match.params);
      layoutMetadata = mergeMetadata(layoutMetadata, meta);
    }
  }
  const metadata = mergeMetadata(layoutMetadata, pageMetadata);

  // Auto-inject OG/Twitter image URLs from opengraph-image.tsx / twitter-image.tsx
  if (match.route.opengraphImageFilePath) {
    const ogImageUrl = `${match.route.pattern === '/' ? '' : match.route.pattern}/opengraph-image`;
    if (!metadata.openGraph) metadata.openGraph = {};
    if (!metadata.openGraph.images) metadata.openGraph.images = [];
    if (!metadata.openGraph.images.includes(ogImageUrl)) {
      metadata.openGraph.images.push(ogImageUrl);
    }
  }
  if (match.route.twitterImageFilePath) {
    const twImageUrl = `${match.route.pattern === '/' ? '' : match.route.pattern}/twitter-image`;
    if (!metadata.twitter) metadata.twitter = {};
    if (!metadata.twitter.images) metadata.twitter.images = [];
    if (!metadata.twitter.images.includes(twImageUrl)) {
      metadata.twitter.images.push(twImageUrl);
    }
  }

  // Build the element tree: page wrapped in loading/error boundaries, then layouts
  // Pass params and searchParams as props (Next.js 15 style)
  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  // Wrap page in error boundary if error.tsx exists for this route
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(ErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  // Wrap page in suspense boundary if loading.tsx exists for this route
  if (match.route.loadingFilePath) {
    const loadingModule = modules.get(match.route.loadingFilePath) as LoadingModule | undefined;
    if (loadingModule) {
      element = createElement(Suspense, { fallback: createElement(loadingModule.default, {}) }, element);
    }
  }

  // Wrap in template.tsx if it exists for this route (re-mounts on navigation)
  if (match.route.templateFilePath) {
    const templateModule = modules.get(match.route.templateFilePath) as TemplateModule | undefined;
    if (templateModule) {
      element = createElement(templateModule.default, { children: element });
    }
  }

  // Wrap in layout chain
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      // Wrap each layout level in its own error/loading boundary if they have them
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      if (layout.errorFilePath) {
        const layoutErrorModule = modules.get(layout.errorFilePath) as ErrorModule | undefined;
        if (layoutErrorModule) {
          layoutContent = createElement(ErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
        }
      }

      if (layout.loadingFilePath) {
        const layoutLoadingModule = modules.get(layout.loadingFilePath) as LoadingModule | undefined;
        if (layoutLoadingModule) {
          layoutContent = createElement(Suspense, { fallback: createElement(layoutLoadingModule.default, {}) }, layoutContent);
        }
      }

      // Wrap layout in template.tsx if it exists for this layout segment
      if (layout.templateFilePath) {
        const layoutTemplateModule = modules.get(layout.templateFilePath) as TemplateModule | undefined;
        if (layoutTemplateModule) {
          layoutContent = createElement(layoutTemplateModule.default, { children: layoutContent });
        }
      }

      element = layoutContent;
    }
  }

  // Resolve viewport (static export or generateViewport) — page overrides layout
  const pageViewport = await resolveViewport(pageModule);
  let layoutViewport: Viewport | undefined;
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule?.viewport) {
      layoutViewport = layoutModule.viewport;
    }
  }
  const viewport = pageViewport ?? layoutViewport;

  // Resolve head: head.tsx component or generateMetadata
  const headHtml = await resolveHead(match.route, modules, metadata);

  // JIT template profiling — check if a compiled template exists for this route
  const compiledTemplate = getCompiledTemplate(match.route.pattern);
  if (compiledTemplate) {
    // Use compiled template (bypasses React reconciliation for hot routes)
    // The compiled template is a function that produces HTML directly from params
    // For now, we still render via React but record the render for profiling
  }

  const html = renderToString(createElement(() => element as ReactNode));
  const fullHtml = wrapHtml(html, match.route, metadata, headHtml, viewport);

  // Record this render for JIT profiling
  const templateHash = simpleHash(fullHtml);
  recordRender(match.route.pattern, templateHash);

  return fullHtml;
}

/**
 * Renders the not-found page for a given route segment.
 */
export async function renderNotFound(ctx: SSRContext): Promise<string> {
  const { match, tree, modules } = ctx;

  // Find the closest not-found.tsx in the layout chain
  const layouts = getLayoutChain(match, tree);
  let notFoundModule: NotFoundModule | undefined;
  let notFoundRoute: ResolvedRoute | undefined;

  // Check the matched route first, then walk up the layout chain
  if (match.route.notFoundFilePath) {
    notFoundModule = modules.get(match.route.notFoundFilePath) as NotFoundModule | undefined;
    notFoundRoute = match.route;
  }

  if (!notFoundModule) {
    for (const layout of layouts) {
      if (layout.notFoundFilePath) {
        notFoundModule = modules.get(layout.notFoundFilePath) as NotFoundModule | undefined;
        notFoundRoute = layout;
        break;
      }
    }
  }

  let element: ReactNode;

  if (notFoundModule) {
    element = createElement(notFoundModule.default, {});

    // Wrap in layout chain
    for (const layout of layouts) {
      const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
      if (layoutModule) {
        element = createElement(layoutModule.default, { children: element });
      }
    }
  } else {
    element = createElement('div', null, '404 - Page Not Found');
  }

  const html = renderToString(createElement(() => element as ReactNode));
  return wrapHtml(html, notFoundRoute ?? match.route, { title: 'Not Found' });
}

/**
 * Resolves metadata from generateMetadata() or static metadata export.
 */
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

/**
 * Resolves metadata from a layout module (generateMetadata or static metadata).
 */
async function resolveLayoutMetadata(layoutModule: LayoutModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (layoutModule.generateMetadata) {
    try {
      return await layoutModule.generateMetadata(params);
    } catch {
      // Fall through to static metadata
    }
  }
  if (layoutModule.metadata) {
    return layoutModule.metadata;
  }
  return {};
}

/**
 * Resolves head content from head.tsx component or falls back to metadata tags.
 */
async function resolveHead(
  route: ResolvedRoute,
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
  metadata: HeadMetadata,
): Promise<string | undefined> {
  if (route.headFilePath) {
    const headModule = modules.get(route.headFilePath) as HeadModule | undefined;
    if (headModule) {
      try {
        const headElement = createElement(headModule.default, {});
        const headContent = renderToString(headElement);
        return headContent;
      } catch {
        // Fall through to metadata-based head
      }
    }
  }
  return renderHeadTags(metadata, route);
}

/**
 * Wraps rendered content in an HTML shell with head metadata.
 */
function wrapHtml(content: string, route: ResolvedRoute, metadata: HeadMetadata, headHtml?: string, viewport?: Viewport): string {
  const headTags = headHtml ?? renderHeadTags(metadata, route);
  const viewportTags = renderViewportTags(viewport);

  // Inject pledge manifest (empty for now — will be populated by the pledge system)
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
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}

/**
 * Resolves viewport from generateViewport() or static viewport export.
 */
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
