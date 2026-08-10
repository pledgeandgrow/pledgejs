/**
 * Svelte renderer adapter for PledgeStack.
 *
 * Implements the RendererAdapter interface using Svelte 5's server-side rendering
 * APIs (render from svelte/server).
 *
 * Svelte components are compiled at build time. The adapter expects the
 * compiled server-side component (with a .render() method) to be the
 * default export.
 */

import type {
  RendererAdapter,
  RenderContext,
  Framework,
  HeadMetadata,
  ClientScriptOptions,
} from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest, getLayoutChain as sharedGetLayoutChain } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';

// --- Module type helpers ---

/**
 * Svelte compiled server component interface.
 * Svelte 5 server components export a `render` function.
 */
interface SvelteServerComponent {
  render: (props: Record<string, unknown>) => { html: string; head: string; css: string };
}

interface SveltePageModule {
  default: SvelteServerComponent;
  metadata?: Record<string, unknown>;
  viewport?: import('pledgestack-shared').Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<import('pledgestack-shared').Viewport> | import('pledgestack-shared').Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

interface SvelteLayoutModule {
  default: SvelteServerComponent;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: import('pledgestack-shared').Viewport;
}

type AnySvelteModule = SveltePageModule | SvelteLayoutModule | { default: unknown };

function asPage(mod: unknown): SveltePageModule | undefined {
  const m = mod as SveltePageModule;
  return m && typeof m.default?.render === 'function' ? m : undefined;
}
function asLayout(mod: unknown): SvelteLayoutModule | undefined {
  const m = mod as SvelteLayoutModule;
  return m && typeof m.default?.render === 'function' ? m : undefined;
}

// --- Helpers ---

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

async function resolveMetadata(pageModule: SveltePageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (pageModule.generateMetadata) {
    try { return await pageModule.generateMetadata(params); } catch { /* fall through */ }
  }
  if (pageModule.metadata) return pageModule.metadata as HeadMetadata;
  return {};
}

async function resolveViewport(pageModule: SveltePageModule): Promise<import('pledgestack-shared').Viewport | undefined> {
  if (pageModule.generateViewport) {
    try { return await pageModule.generateViewport(); } catch { /* fall through */ }
  }
  return pageModule.viewport;
}

// --- HTML shell ---

function wrapHtml(
  content: string,
  route: import('pledgestack-shared').ResolvedRoute,
  metadata: HeadMetadata,
  headHtml?: string,
  viewport?: import('pledgestack-shared').Viewport,
  css?: string,
): string {
  const headTags = headHtml ?? renderHeadTags(metadata, route);
  const viewportTags = renderViewportTags(viewport);
  const manifest: PledgeManifest = { pledges: [] };
  const manifestScript = `<script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;
  const styleTag = css ? `<style>${css}</style>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  ${styleTag}
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

export class SvelteRendererAdapter implements RendererAdapter {
  readonly framework: Framework = 'svelte';
  readonly fileExtension = 'svelte';
  readonly handledExtensions = ['svelte', 'ts', 'js'] as const;

  async renderToString(ctx: RenderContext): Promise<string> {
    const { match, modules, tree } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);

    // Svelte server components have a .render() method
    const props = { params: match.params, searchParams: ctx.searchParams ?? {} };
    let result = pageModule.default.render(props);

    // Get layout chain — wrap page in layouts (inside-out)
    const layouts = sharedGetLayoutChain(match, tree);
    let html = result.html;
    let css = result.css;

    // Svelte layouts render children via {@render children()} in the template.
    // For SSR, we render each layout and inject the page HTML as children.
    // Since Svelte compiled components produce HTML strings, we compose them
    // by rendering the layout with the page HTML as the children prop.
    for (let i = layouts.length - 1; i >= 0; i--) {
      const layoutModule = asLayout(modules.get(layouts[i].filePath));
      if (layoutModule) {
        const layoutResult = layoutModule.default.render({
          params: match.params,
          searchParams: ctx.searchParams ?? {},
          children: html,
        });
        html = layoutResult.html;
        css = (layoutResult.css || '') + css;
      }
    }

    // Svelte render returns { html, head, css }
    const headHtml = result.head || renderHeadTags(metadata, match.route);
    return wrapHtml(html, match.route, metadata, headHtml, viewport, css);
  }

  async renderToStream(ctx: RenderContext): Promise<string> {
    // Svelte's render() is synchronous — no streaming needed
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
    const notFoundModule = modules.get(match.route.notFoundFilePath ?? '') as SveltePageModule | undefined;

    let html: string;
    if (notFoundModule && typeof notFoundModule.default?.render === 'function') {
      const result = notFoundModule.default.render({});
      html = result.html;
    } else {
      html = '<div>404 - Page Not Found</div>';
    }

    return wrapHtml(html, match.route, { title: 'Not Found' });
  }

  // RSC is React-only — Svelte doesn't implement these

  async prerenderStaticShell(ctx: RenderContext): Promise<string> {
    return this.renderToString({ ...ctx, match: { ...ctx.match, params: {} } });
  }

  async renderDynamicHoles(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    return this.renderToReadableStream(ctx);
  }

  generateClientScript(options: ClientScriptOptions): string {
    const { isDev, pledgepackPort } = options;
    const svelteImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/svelte.js`
      : 'svelte';
    const svelteClientImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/svelte/client.js`
      : 'svelte/client';

    return `// PledgeStack Svelte client hydration (auto-generated)
import { hydrate } from '${svelteClientImport}';

const root = document.getElementById('__pledge_root__');
if (root) {
  // Svelte hydration — the SSR content is already in the DOM
  try {
    const { routes } = await import('/__pledge_router');
    const pageRoute = routes[window.location.pathname];
    if (pageRoute && pageRoute.component) {
      // Svelte 5 hydrate takes the compiled client component and target element
      // The compiled client component is loaded from the router module
      const Component = pageRoute.component;
      hydrate(Component, { target: root, props: { params: {}, searchParams: {} } });
    }
  } catch (e) {
    console.error('[pledgestack] Svelte hydration error:', e);
  }
}
`;
  }

  // No RSC client script for Svelte
}

// --- Auto-register ---

getRendererRegistry().register(new SvelteRendererAdapter());
