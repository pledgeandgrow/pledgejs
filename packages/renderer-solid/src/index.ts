/**
 * Solid renderer adapter for PledgeStack.
 *
 * Implements the RendererAdapter interface using Solid.js's server-side rendering
 * APIs (renderToString from solid-js/web).
 *
 * Solid uses .tsx files with JSX, but compiled with Solid's babel preset
 * (not React's). The adapter dynamically imports solid-js/web to avoid
 * a hard dependency.
 */

import type {
  RendererAdapter,
  RenderContext,
  Framework,
  HeadMetadata,
  ClientScriptOptions,
} from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest, getLayoutChain as sharedGetLayoutChain, escapeHtml } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';

// --- Module type helpers ---

interface SolidPageModule {
  default: (props: { params: Record<string, string>; searchParams: Record<string, string> }) => unknown; // Solid component
  metadata?: Record<string, unknown>;
  viewport?: import('pledgestack-shared').Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<import('pledgestack-shared').Viewport> | import('pledgestack-shared').Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

interface SolidLayoutModule {
  default: (props: { children: unknown }) => unknown;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: import('pledgestack-shared').Viewport;
}

function asPage(mod: unknown): SolidPageModule | undefined {
  const m = mod as SolidPageModule;
  return m && typeof m.default === 'function' ? m : undefined;
}
function asLayout(mod: unknown): SolidLayoutModule | undefined {
  const m = mod as SolidLayoutModule;
  return m && typeof m.default === 'function' ? m : undefined;
}

// --- Helpers ---

function renderHeadTags(metadata: HeadMetadata, route: import('pledgestack-shared').ResolvedRoute): string {
  const tags: string[] = [];
  const title = metadata.title ?? route.metadata?.title ?? 'PledgeStack App';
  tags.push(`<title>${escapeHtml(title)}</title>`);
  if (metadata.description) tags.push(`<meta name="description" content="${escapeHtml(metadata.description)}" />`);
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) tags.push(`<meta property="og:title" content="${escapeHtml(og.title)}" />`);
    if (og.description) tags.push(`<meta property="og:description" content="${escapeHtml(og.description)}" />`);
    if (og.images) for (const img of og.images) tags.push(`<meta property="og:image" content="${escapeHtml(img)}" />`);
  }
  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card) tags.push(`<meta name="twitter:card" content="${escapeHtml(tw.card)}" />`);
    if (tw.title) tags.push(`<meta name="twitter:title" content="${escapeHtml(tw.title)}" />`);
  }
  return tags.join('\n  ');
}

function renderViewportTags(viewport: import('pledgestack-shared').Viewport | undefined): string {
  if (!viewport) return '';
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${viewport.width}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (parts.length > 0) return `<meta name="viewport" content="${parts.join(', ')}" />`;
  return '';
}

async function resolveMetadata(pageModule: SolidPageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (pageModule.generateMetadata) {
    try { return await pageModule.generateMetadata(params); } catch { /* fall through */ }
  }
  if (pageModule.metadata) return pageModule.metadata as HeadMetadata;
  return {};
}

async function resolveViewport(pageModule: SolidPageModule): Promise<import('pledgestack-shared').Viewport | undefined> {
  if (pageModule.generateViewport) {
    try { return await pageModule.generateViewport(); } catch { /* fall through */ }
  }
  return pageModule.viewport;
}

// --- Solid SSR ---

async function getSolidServerRenderer(): Promise<{
  renderToString: (fn: () => unknown) => string;
  renderToStringAsync: (fn: () => unknown) => Promise<string>;
} | null> {
  try {
    const mod = await import('solid-js/web');
    if (typeof mod.renderToString === 'function') {
      return mod as { renderToString: (fn: () => unknown) => string; renderToStringAsync: (fn: () => unknown) => Promise<string> };
    }
  } catch {
    // solid-js/web not available
  }
  return null;
}

// --- HTML shell ---

function wrapHtml(
  content: string,
  route: import('pledgestack-shared').ResolvedRoute,
  metadata: HeadMetadata,
  headHtml?: string,
  viewport?: import('pledgestack-shared').Viewport,
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
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}

// --- Adapter ---

export class SolidRendererAdapter implements RendererAdapter {
  readonly framework: Framework = 'solid';
  readonly fileExtension = 'tsx';
  readonly handledExtensions = ['tsx', 'ts', 'jsx', 'js'] as const;

  async renderToString(ctx: RenderContext): Promise<string> {
    const { match, modules, tree } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const renderer = await getSolidServerRenderer();
    if (!renderer) {
      throw new Error('solid-js/web is not available. Install solid-js: npm install solid-js');
    }

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);

    // Solid components are functions that return JSX
    const props = { params: match.params, searchParams: ctx.searchParams ?? {} };

    // Get layout chain — wrap page in layouts (inside-out)
    const layouts = sharedGetLayoutChain(match, tree);

    // Build the render function — Solid layouts receive children as a prop
    const renderFn = (): unknown => {
      let content: unknown = pageModule.default(props);

      // Wrap in layouts (innermost first, so outermost layout is last)
      for (let i = layouts.length - 1; i >= 0; i--) {
        const layoutModule = asLayout(modules.get(layouts[i].filePath));
        if (layoutModule) {
          const layoutProps = { params: match.params, searchParams: ctx.searchParams ?? {}, children: content };
          content = layoutModule.default(layoutProps);
        }
      }

      return content;
    };

    // Use async render for Suspense support
    const html = await renderer.renderToStringAsync(renderFn);
    return wrapHtml(html, match.route, metadata, undefined, viewport);
  }

  async renderToStream(ctx: RenderContext): Promise<string> {
    // Solid's renderToStringAsync handles async components
    return this.renderToString(ctx);
  }

  async renderToReadableStream(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    const html = await this.renderToString(ctx);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(html));
        controller.close();
      },
    });
  }

  async renderNotFound(ctx: RenderContext): Promise<string> {
    const { match, modules } = ctx;
    const notFoundModule = modules.get(match.route.notFoundFilePath ?? '') as SolidPageModule | undefined;

    let html: string;
    if (notFoundModule && typeof notFoundModule.default === 'function') {
      const renderer = await getSolidServerRenderer();
      if (renderer) {
        html = renderer.renderToString(() => notFoundModule.default({ params: {}, searchParams: {} }));
      } else {
        html = '404 - Page Not Found';
      }
    } else {
      html = '<div>404 - Page Not Found</div>';
    }

    return wrapHtml(html, match.route, { title: 'Not Found' });
  }

  // RSC is React-only — Solid doesn't implement these

  async prerenderStaticShell(ctx: RenderContext): Promise<string> {
    return this.renderToString({ ...ctx, match: { ...ctx.match, params: {} } });
  }

  async renderDynamicHoles(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    return this.renderToReadableStream(ctx);
  }

  generateClientScript(options: ClientScriptOptions): string {
    const { isDev, pledgepackPort } = options;
    const solidWebImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/solid-js/web.js`
      : 'solid-js/web';

    return `// PledgeStack Solid client hydration (auto-generated)
import { hydrate } from '${solidWebImport}';

const root = document.getElementById('__pledge_root__');
if (root) {
  // Solid hydration — the SSR content is already in the DOM
  try {
    const { routes } = await import('/__pledge_router');
    const pageRoute = routes[window.location.pathname];
    if (pageRoute && pageRoute.component) {
      // Solid's hydrate takes the component factory and the DOM root
      hydrate(() => pageRoute.component({ params: {}, searchParams: {} }), root);
    }
  } catch (e) {
    console.error('[pledgestack] Solid hydration error:', e);
  }
}
`;
  }

  // No RSC client script for Solid
}

// --- Auto-register ---

getRendererRegistry().register(new SolidRendererAdapter());
