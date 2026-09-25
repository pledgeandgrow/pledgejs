import { describe, it, expect } from 'vitest';
import { ssr } from 'solid-js/web';
import type { RenderContext, ResolvedRoute, RouteTree, AnyGenericModule } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';
import { SolidRendererAdapter } from './index';

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
  const pageRoute = route(opts.pattern, `/app${opts.pattern}/page.tsx`, opts.routeExtra);
  const modules = new Map<string, AnyGenericModule>();
  modules.set(pageRoute.filePath, opts.page as AnyGenericModule);
  for (const l of opts.layouts ?? []) modules.set(l.route.filePath, l.mod as AnyGenericModule);
  for (const [k, v] of Object.entries(opts.extraModules ?? {})) modules.set(k, v as AnyGenericModule);
  const tree: RouteTree = { root: { pattern: '/', segment: '', children: [], layouts: (opts.layouts ?? []).map((l) => l.route) } };
  return { match: { pathname: opts.pattern, params: opts.params ?? {}, route: pageRoute }, tree, modules };
}

const adapter = new SolidRendererAdapter();

describe('SolidRendererAdapter', () => {
  it('declares its framework and registers itself', () => {
    expect(adapter.framework).toBe('solid');
    expect(adapter.fileExtension).toBe('tsx');
    expect(getRendererRegistry().get('solid')).toBeDefined();
  });

  it('server-renders a Solid page (via solid-js/web) into the HTML shell', async () => {
    const ctx = ctxFor({
      pattern: '/solid-basic',
      params: { id: '3' },
      page: {
        default: (p: { params: Record<string, string> }) => ssr(['<h1>Hello Solid ', '</h1>'] as never, p.params.id as never),
        metadata: { title: 'Solid Page' },
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('id="__pledge_root__"');
    expect(html).toContain('<h1>Hello Solid 3</h1>');
    expect(html).toContain('Solid Page');
    expect(html).toContain('"id":"3"');
  });

  it('wraps the page in layouts, passing the rendered page as children', async () => {
    const layout = route('/', '/app/layout.tsx', { isLayout: true });
    const ctx = ctxFor({
      pattern: '/',
      page: { default: () => ssr(['<i>page</i>'] as never) },
      layouts: [{ route: layout, mod: { default: (p: { children: unknown }) => ssr(['<section>', '</section>'] as never, p.children as never) } }],
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<section><i>page</i></section>');
  });

  it('throws a clear error when the page module is missing', async () => {
    const ctx = ctxFor({ pattern: '/solid-missing', page: undefined });
    await expect(adapter.renderToString(ctx)).rejects.toThrow(/Page module not found/);
  });

  it('renderToReadableStream emits the document', async () => {
    const ctx = ctxFor({ pattern: '/solid-stream', page: { default: () => ssr(['<p>solid streamed</p>'] as never) } });
    const text = await new Response(await adapter.renderToReadableStream(ctx)).text();
    expect(text).toContain('solid streamed');
  });

  it('renderNotFound uses a default 404 or the custom module', async () => {
    const plain = ctxFor({ pattern: '/solid-404', page: { default: () => '' } });
    expect(await adapter.renderNotFound(plain)).toContain('404 - Page Not Found');
    const custom = ctxFor({
      pattern: '/solid-404b',
      page: { default: () => '' },
      routeExtra: { notFoundFilePath: '/app/nf.tsx' },
      extraModules: { '/app/nf.tsx': { default: () => ssr(['<h1>Nope</h1>'] as never) } },
    });
    expect(await adapter.renderNotFound(custom)).toContain('<h1>Nope</h1>');
  });

  it('generateClientScript hydrates with the server params and dev-server import', () => {
    const prod = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(prod).toContain("import { hydrate } from 'solid-js/web'");
    expect(prod).toContain('installSpaNavigation');
    expect(prod).toContain('rd.params');
    const dev = adapter.generateClientScript({ isDev: true, pledgepackPort: 4777, rscEnabled: false });
    expect(dev).toContain("from 'solid-js/web'");
  });

  it('client script hydrates layouts around the page', () => {
    const js = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(js).toContain('resolveRouteChain');
    expect(js).toContain('children');
    expect(js).toContain('layouts');
  });
});
