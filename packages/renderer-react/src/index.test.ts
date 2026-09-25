import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import type { RenderContext, ResolvedRoute, RouteTree, AnyGenericModule } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';
import { ReactRendererAdapter } from './index';

function route(pattern: string, filePath: string, extra: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { pattern, filePath, mode: 'ssr', runtime: 'node', isLayout: false, isErrorBoundary: false, isLoading: false, isNotFound: false, ...extra } as ResolvedRoute;
}

function treeWith(layouts: ResolvedRoute[]): RouteTree {
  // Root node carries the layouts; children not needed for single-segment routes.
  return { root: { pattern: '/', segment: '', children: [], layouts } };
}

function ctxFor(opts: {
  pattern: string;
  page: unknown;
  layouts?: Array<{ route: ResolvedRoute; mod: unknown }>;
  params?: Record<string, string>;
  searchParams?: Record<string, string>;
  routeExtra?: Partial<ResolvedRoute>;
  extraModules?: Record<string, unknown>;
  security?: RenderContext['security'];
}): RenderContext {
  const pageRoute = route(opts.pattern, `/app${opts.pattern}/page.tsx`, opts.routeExtra);
  const modules = new Map<string, AnyGenericModule>();
  modules.set(pageRoute.filePath, opts.page as AnyGenericModule);
  for (const l of opts.layouts ?? []) modules.set(l.route.filePath, l.mod as AnyGenericModule);
  for (const [k, v] of Object.entries(opts.extraModules ?? {})) modules.set(k, v as AnyGenericModule);
  return {
    match: { pathname: opts.pattern, params: opts.params ?? {}, route: pageRoute },
    tree: treeWith((opts.layouts ?? []).map((l) => l.route)),
    modules,
    searchParams: opts.searchParams,
    security: opts.security,
  };
}

const adapter = new ReactRendererAdapter();

describe('ReactRendererAdapter', () => {
  it('declares its framework and handled extensions, and registers itself', () => {
    expect(adapter.framework).toBe('react');
    expect(adapter.fileExtension).toBe('tsx');
    expect(adapter.handledExtensions).toContain('tsx');
    expect(getRendererRegistry().get('react')).toBeDefined();
  });

  it('renders a page into the HTML shell with route data and the client entry', async () => {
    const ctx = ctxFor({
      pattern: '/react-basic',
      page: { default: () => createElement('h1', null, 'Hello React') },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="__pledge_root__"');
    expect(html).toContain('<h1>Hello React</h1>');
    expect(html).toContain('window.__PLEDGE_ROUTE__=');
    expect(html).toContain('src="/__pledge__/client.js"');
  });

  it('passes params and searchParams to the page component', async () => {
    const ctx = ctxFor({
      pattern: '/blog/[slug]',
      params: { slug: 'hello' },
      searchParams: { q: 'x' },
      page: {
        default: (p: { params: Record<string, string>; searchParams: Record<string, string> }) =>
          createElement('p', null, `${p.params.slug}|${p.searchParams.q}`),
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('hello|x');
    // Route data for hydration reflects the real params.
    expect(html).toContain('"slug":"hello"');
  });

  it('wraps the page in the layout chain (layout content surrounds the page)', async () => {
    const layoutRoute = route('/', '/app/layout.tsx', { isLayout: true });
    const ctx = ctxFor({
      pattern: '/',
      page: { default: () => createElement('span', null, 'inner') },
      layouts: [{
        route: layoutRoute,
        mod: { default: ({ children }: { children: ReactNode }) => createElement('main', { className: 'shell' }, children) },
      }],
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<main class="shell"><span>inner</span></main>');
  });

  it('emits metadata as head tags and escapes hostile values', async () => {
    const ctx = ctxFor({
      pattern: '/react-meta',
      page: {
        default: () => createElement('div'),
        metadata: { title: 'A <script>alert(1)</script> title', description: 'desc "quoted"' },
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<title>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('name="description"');
    expect(html).not.toContain('content="desc "quoted""');
  });

  it('prefers generateMetadata over static metadata', async () => {
    const ctx = ctxFor({
      pattern: '/react-genmeta',
      params: { id: '7' },
      page: {
        default: () => createElement('div'),
        metadata: { title: 'static' },
        generateMetadata: (params: Record<string, string>) => ({ title: `dynamic ${params.id}` }),
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('dynamic 7');
    expect(html).not.toContain('>static<');
  });

  it('throws a clear error when the page module is missing', async () => {
    const ctx = ctxFor({ pattern: '/react-missing', page: undefined });
    await expect(adapter.renderToString(ctx)).rejects.toThrow(/Page module not found/);
  });

  it('renderToReadableStream streams the same document', async () => {
    const ctx = ctxFor({
      pattern: '/react-stream',
      page: { default: () => createElement('h2', null, 'streamed') },
    });
    const stream = await adapter.renderToReadableStream(ctx);
    const text = await new Response(stream).text();
    expect(text).toContain('streamed');
    expect(text.toLowerCase()).toContain('<html');
    expect(text).toContain('</html>');
  });

  it('renderToStream resolves to a complete HTML string', async () => {
    const ctx = ctxFor({
      pattern: '/react-stream-str',
      page: { default: () => createElement('h3', null, 'buffered') },
    });
    const html = await adapter.renderToStream(ctx);
    expect(html).toContain('buffered');
    expect(html).toContain('</html>');
  });

  it('renders the not-found module when present, otherwise a default 404', async () => {
    const withModule = ctxFor({
      pattern: '/react-404',
      page: { default: () => createElement('div') },
      routeExtra: { notFoundFilePath: '/app/not-found.tsx' },
      extraModules: { '/app/not-found.tsx': { default: () => createElement('h1', null, 'Custom Missing') } },
    });
    expect(await adapter.renderNotFound(withModule)).toContain('Custom Missing');

    const without = ctxFor({ pattern: '/react-404b', page: { default: () => createElement('div') } });
    expect(await adapter.renderNotFound(without)).toMatch(/404|not found/i);
  });

  describe('generateClientScript', () => {
    it('hydrates the real route tree (not an empty one) using the router module', () => {
      const js = adapter.generateClientScript({ isDev: false, rscEnabled: false });
      expect(js).toContain("from 'react-dom/client'");
      expect(js).toContain('hydrateRoot');
      expect(js).toContain('resolveRouteElement');
      expect(js).toContain('window.__PLEDGE_ROUTE__');
      expect(js).toContain('initPledgeHydration');
    });

    it('imports React via bare specifiers resolved by the dev importmap', () => {
      const js = adapter.generateClientScript({ isDev: true, pledgepackPort: 4123, rscEnabled: false });
      expect(js).toContain("from 'react-dom/client'");
      expect(js).toContain("from 'react'");
    });
  });
});
