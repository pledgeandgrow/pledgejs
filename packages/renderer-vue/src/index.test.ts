import { describe, it, expect } from 'vitest';
import { h } from 'vue';
import type { RenderContext, ResolvedRoute, RouteTree, AnyGenericModule } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';
import { VueRendererAdapter } from './index';

function route(pattern: string, filePath: string, extra: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { pattern, filePath, mode: 'ssr', runtime: 'node', isLayout: false, isErrorBoundary: false, isLoading: false, isNotFound: false, ...extra } as ResolvedRoute;
}

function ctxFor(opts: {
  pattern: string;
  page: unknown;
  layouts?: Array<{ route: ResolvedRoute; mod: unknown }>;
  params?: Record<string, string>;
  routeExtra?: Partial<ResolvedRoute>;
  extraModules?: Record<string, unknown>;
}): RenderContext {
  const pageRoute = route(opts.pattern, `/app${opts.pattern}/page.vue`, opts.routeExtra);
  const modules = new Map<string, AnyGenericModule>();
  modules.set(pageRoute.filePath, opts.page as AnyGenericModule);
  for (const l of opts.layouts ?? []) modules.set(l.route.filePath, l.mod as AnyGenericModule);
  for (const [k, v] of Object.entries(opts.extraModules ?? {})) modules.set(k, v as AnyGenericModule);
  const tree: RouteTree = { root: { pattern: '/', segment: '', children: [], layouts: (opts.layouts ?? []).map((l) => l.route) } };
  return { match: { pathname: opts.pattern, params: opts.params ?? {}, route: pageRoute }, tree, modules };
}

const adapter = new VueRendererAdapter();

describe('VueRendererAdapter', () => {
  it('declares its framework and registers itself', () => {
    expect(adapter.framework).toBe('vue');
    expect(adapter.fileExtension).toBe('vue');
    expect(adapter.handledExtensions).toContain('vue');
    expect(getRendererRegistry().get('vue')).toBeDefined();
  });

  it('server-renders a Vue page component into the HTML shell', async () => {
    const ctx = ctxFor({
      pattern: '/vue-basic',
      params: { id: '9' },
      page: {
        default: (props: { params: Record<string, string> }) => h('h1', null, `Hello Vue ${props.params.id}`),
        metadata: { title: 'Vue Page' },
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="__pledge_root__"');
    expect(html).toContain('Hello Vue 9');
    expect(html).toContain('Vue Page');
    expect(html).toContain('window.__PLEDGE_ROUTE__=');
  });

  it('emits the real route params for hydration and escapes < in the JSON', async () => {
    const ctx = ctxFor({
      pattern: '/vue-dyn/[id]',
      params: { id: '</script><b>' },
      page: { default: () => h('p', null, 'dyn') },
    });
    const html = await adapter.renderToString(ctx);
    const start = html.indexOf('window.__PLEDGE_ROUTE__=') + 'window.__PLEDGE_ROUTE__='.length;
    const end = html.indexOf('</script>', start);
    const json = html.slice(start, end);
    expect(json).not.toContain('<');
    const data = JSON.parse(json);
    expect(data.params.id).toBe('</script><b>');
    expect(data.pattern).toBe('/vue-dyn/[id]');
  });

  it('client script mounts with the server route data, not an empty pathname lookup', () => {
    const js = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(js).toContain('window.__PLEDGE_ROUTE__');
    expect(js).toContain('resolveRouteChain(routes, routeData)');
    expect(js).toContain('params: routeData.params');
  });

  it('nests every layout in the chain around the page (outermost first)', async () => {
    const outer = route('/', '/app/layout.vue', { isLayout: true });
    const inner = route('/', '/app/inner-layout.vue', { isLayout: true });
    const wrap = (cls: string) => (_p: unknown, { slots }: { slots: { default: () => unknown } }) => h('div', { class: cls }, slots.default() as never);
    const ctx = ctxFor({
      pattern: '/',
      page: { default: () => h('span', null, 'content') },
      layouts: [
        { route: outer, mod: { default: wrap('outer') } },
        { route: inner, mod: { default: wrap('inner') } },
      ],
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<div class="outer"><div class="inner"><span>content</span></div></div>');
  });

  it('throws a clear error when the page module is missing', async () => {
    const ctx = ctxFor({ pattern: '/vue-missing', page: undefined });
    await expect(adapter.renderToString(ctx)).rejects.toThrow(/Page module not found/);
  });

  it('renderToReadableStream emits the document', async () => {
    const ctx = ctxFor({ pattern: '/vue-stream', page: { default: () => h('p', null, 'vue streamed') } });
    const text = await new Response(await adapter.renderToReadableStream(ctx)).text();
    expect(text).toContain('vue streamed');
  });

  it('renderNotFound falls back to a default 404, or renders the custom module', async () => {
    const plain = ctxFor({ pattern: '/vue-404', page: { default: () => h('div') } });
    expect(await adapter.renderNotFound(plain)).toContain('404 - Page Not Found');

    const custom = ctxFor({
      pattern: '/vue-404b',
      page: { default: () => h('div') },
      routeExtra: { notFoundFilePath: '/app/nf.vue' },
      extraModules: { '/app/nf.vue': { default: () => h('h1', null, 'Nothing here') } },
    });
    expect(await adapter.renderNotFound(custom)).toContain('Nothing here');
  });

  it('generateClientScript hydrates with createSSRApp, via dev server in dev mode', () => {
    const prod = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(prod).toContain("import { createSSRApp, h } from 'vue'");
    expect(prod).toContain('app.mount(root)');
    const dev = adapter.generateClientScript({ isDev: true, pledgepackPort: 4555, rscEnabled: false });
    expect(dev).toContain('http://localhost:4555/node_modules/.vite/vue.js');
  });

  it('client script resolves the layout chain and nests layouts around the page', () => {
    const js = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(js).toContain('resolveRouteChain');
    expect(js).toContain('layouts');
    expect(js).toContain('default:');
  });
});
