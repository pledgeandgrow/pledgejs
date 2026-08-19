/**
 * Vue renderer adapter for PledgeStack.
 *
 * Implements the RendererAdapter interface using Vue 3's server-side rendering
 * APIs (renderToString from vue/server-renderer).
 *
 * Vue uses .vue single-file components. The adapter dynamically imports
 * vue/server-renderer to avoid a hard dependency on Vue.
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

interface VuePageModule {
  default: unknown; // Vue component definition
  metadata?: Record<string, unknown>;
  viewport?: import('pledgestack-shared').Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<import('pledgestack-shared').Viewport> | import('pledgestack-shared').Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

interface VueLayoutModule {
  default: unknown;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: import('pledgestack-shared').Viewport;
}

function asPage(mod: unknown): VuePageModule | undefined {
  const m = mod as VuePageModule;
  return m && typeof m.default !== 'undefined' ? m : undefined;
}
function asLayout(mod: unknown): VueLayoutModule | undefined {
  const m = mod as VueLayoutModule;
  return m && typeof m.default !== 'undefined' ? m : undefined;
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

async function resolveMetadata(pageModule: VuePageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (pageModule.generateMetadata) {
    try { return await pageModule.generateMetadata(params); } catch { /* fall through */ }
  }
  if (pageModule.metadata) return pageModule.metadata as HeadMetadata;
  return {};
}

async function resolveViewport(pageModule: VuePageModule): Promise<import('pledgestack-shared').Viewport | undefined> {
  if (pageModule.generateViewport) {
    try { return await pageModule.generateViewport(); } catch { /* fall through */ }
  }
  return pageModule.viewport;
}

// --- Vue SSR ---

async function getVueServerRenderer(): Promise<{ renderToString: (app: unknown) => Promise<string> } | null> {
  try {
    const mod = await import('vue/server-renderer');
    if (typeof mod.renderToString === 'function') {
      return mod as { renderToString: (app: unknown) => Promise<string> };
    }
  } catch {
    // vue/server-renderer not available
  }
  return null;
}

async function createVueApp(component: unknown, props: Record<string, unknown>): Promise<unknown> {
  const vue = await import('vue');
  // `component` is a dynamically-loaded .vue SFC's default export — its real
  // shape is only known once the user's module loads, so it can't be typed
  // as Vue's `Component` here without a hard type dependency on Vue.
  return vue.createApp(component as any, props);
}

// --- Layout chain (uses shared implementation from pledgestack-shared) ---

function getLayoutChain(match: import('pledgestack-shared').RouteMatch, tree: unknown): import('pledgestack-shared').ResolvedRoute[] {
  return sharedGetLayoutChain(match, tree);
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

export class VueRendererAdapter implements RendererAdapter {
  readonly framework: Framework = 'vue';
  readonly fileExtension = 'vue';
  readonly handledExtensions = ['vue', 'ts', 'js'] as const;

  async renderToString(ctx: RenderContext): Promise<string> {
    const { match, modules, tree } = ctx;
    const pageModule = asPage(modules.get(match.route.filePath));
    if (!pageModule) throw new Error(`Page module not found: ${match.route.filePath}`);

    const renderer = await getVueServerRenderer();
    if (!renderer) {
      throw new Error('vue/server-renderer is not available. Install vue: npm install vue');
    }

    const metadata = await resolveMetadata(pageModule, match.params);
    const viewport = await resolveViewport(pageModule);

    // Build Vue app with props
    const props = { params: match.params, searchParams: ctx.searchParams ?? {} };

    // Get layout chain and wrap page in layouts (inside-out)
    const layouts = getLayoutChain(match, tree);
    let app = await createVueApp(pageModule.default, props);

    // Wrap in layouts — Vue layouts receive children via slots
    for (let i = layouts.length - 1; i >= 0; i--) {
      const layoutModule = asLayout(modules.get(layouts[i].filePath));
      if (layoutModule) {
        const vue = await import('vue');
        // Create a wrapper app that renders the layout with the previous app as children
        app = vue.createApp({
          render() {
            return vue.h(layoutModule.default as any, { params: match.params, searchParams: ctx.searchParams ?? {} }, {
              default: () => vue.h(pageModule.default as any, props),
            });
          },
        });
      }
    }

    // Render
    const html = await renderer.renderToString(app);
    return wrapHtml(html, match.route, metadata, undefined, viewport);
  }

  async renderToStream(ctx: RenderContext): Promise<string> {
    // Vue's renderToString already handles async components
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
    const notFoundModule = modules.get(match.route.notFoundFilePath ?? '') as VuePageModule | undefined;

    let html: string;
    if (notFoundModule) {
      const renderer = await getVueServerRenderer();
      if (renderer) {
        const app = await createVueApp(notFoundModule.default, {});
        html = await renderer.renderToString(app);
      } else {
        html = '404 - Page Not Found';
      }
    } else {
      html = '<div>404 - Page Not Found</div>';
    }

    return wrapHtml(html, match.route, { title: 'Not Found' });
  }

  // RSC is React-only — Vue doesn't implement these
  // renderRSC and renderRSCStream are not defined (optional interface methods)

  async prerenderStaticShell(ctx: RenderContext): Promise<string> {
    // Vue doesn't have Suspense in the same way React does
    // For PPR, we render with empty params
    return this.renderToString({ ...ctx, match: { ...ctx.match, params: {} } });
  }

  async renderDynamicHoles(ctx: RenderContext): Promise<ReadableStream<Uint8Array>> {
    return this.renderToReadableStream(ctx);
  }

  generateClientScript(options: ClientScriptOptions): string {
    const { isDev, pledgepackPort } = options;
    const vueImport = isDev && pledgepackPort
      ? `http://localhost:${pledgepackPort}/node_modules/.vite/vue.js`
      : 'vue';

    return `// PledgeStack Vue client hydration (auto-generated)
import { createSSRApp } from '${vueImport}';

const root = document.getElementById('__pledge_root__');
if (root) {
  // Vue 3 hydrates existing SSR-rendered DOM when an app created with
  // createSSRApp() is mounted onto it (there is no separate hydrate()
  // export in Vue's public API — mount() IS the hydration path for
  // createSSRApp-created apps).
  try {
    const { routes } = await import('/__pledge_router');
    const pageRoute = routes[window.location.pathname];
    if (pageRoute && pageRoute.component) {
      const app = createSSRApp(pageRoute.component);
      app.mount(root);
    }
  } catch (e) {
    console.error('[pledgestack] Vue hydration error:', e);
  }
}
`;
  }

  // No RSC client script for Vue
}

// --- Auto-register ---

getRendererRegistry().register(new VueRendererAdapter());
