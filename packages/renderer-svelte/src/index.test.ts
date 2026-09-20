import { describe, it, expect } from 'vitest';
import type { RenderContext, ResolvedRoute, RouteTree, AnyGenericModule } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';
import { SvelteRendererAdapter } from './index';

type Rendered = { html: string; head?: string; css?: string };
// A compiled Svelte SSR component exposes render(props) -> { html, head, css }.
const component = (fn: (props: Record<string, unknown>) => Rendered) => ({ render: fn });

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
  const pageRoute = route(opts.pattern, `/app${opts.pattern}/page.svelte`, opts.routeExtra);
  const modules = new Map<string, AnyGenericModule>();
  modules.set(pageRoute.filePath, opts.page as AnyGenericModule);
  for (const l of opts.layouts ?? []) modules.set(l.route.filePath, l.mod as AnyGenericModule);
  for (const [k, v] of Object.entries(opts.extraModules ?? {})) modules.set(k, v as AnyGenericModule);
  const tree: RouteTree = { root: { pattern: '/', segment: '', children: [], layouts: (opts.layouts ?? []).map((l) => l.route) } };
  return { match: { pathname: opts.pattern, params: opts.params ?? {}, route: pageRoute }, tree, modules };
}

const adapter = new SvelteRendererAdapter();

describe('SvelteRendererAdapter', () => {
  it('declares its framework and registers itself', () => {
    expect(adapter.framework).toBe('svelte');
    expect(adapter.fileExtension).toBe('svelte');
    expect(adapter.handledExtensions).toContain('svelte');
    expect(getRendererRegistry().get('svelte')).toBeDefined();
  });

  it('renders a compiled page component into the HTML shell with its head and css', async () => {
    const ctx = ctxFor({
      pattern: '/svelte-basic',
      params: { id: '5' },
      page: {
        default: component((p) => ({
          html: `<h1>Hello Svelte ${(p.params as Record<string, string>).id}</h1>`,
          head: '<title>From component head</title>',
          css: '<style>h1{color:red}</style>',
        })),
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Hello Svelte 5</h1>');
    expect(html).toContain('<title>From component head</title>');
    expect(html).toContain('h1{color:red}');
    expect(html).toContain('"id":"5"');
  });

  it('composes layouts around the page, passing page HTML as children (outermost last)', async () => {
    const outer = route('/', '/app/layout.svelte', { isLayout: true });
    const inner = route('/', '/app/inner.svelte', { isLayout: true });
    const wrap = (tag: string) => component((p) => ({ html: `<${tag}>${String(p.children)}</${tag}>`, css: '' }));
    const ctx = ctxFor({
      pattern: '/',
      page: { default: component(() => ({ html: '<b>page</b>' })) },
      layouts: [
        { route: outer, mod: { default: wrap('outer') } },
        { route: inner, mod: { default: wrap('inner') } },
      ],
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('<outer><inner><b>page</b></inner></outer>');
  });

  it('falls back to generated head tags when the component provides none', async () => {
    const ctx = ctxFor({
      pattern: '/svelte-meta',
      page: {
        default: component(() => ({ html: '<p>x</p>' })),
        metadata: { title: 'Generated <Title>' },
      },
    });
    const html = await adapter.renderToString(ctx);
    expect(html).toContain('Generated &lt;Title&gt;');
  });

  it('throws a clear error when the page module is missing', async () => {
    const ctx = ctxFor({ pattern: '/svelte-missing', page: undefined });
    await expect(adapter.renderToString(ctx)).rejects.toThrow(/Page module not found/);
  });

  it('renderToReadableStream emits the document', async () => {
    const ctx = ctxFor({ pattern: '/svelte-stream', page: { default: component(() => ({ html: '<p>svelte streamed</p>' })) } });
    const text = await new Response(await adapter.renderToReadableStream(ctx)).text();
    expect(text).toContain('svelte streamed');
  });

  it('renderNotFound uses a default 404 or the custom component', async () => {
    const plain = ctxFor({ pattern: '/svelte-404', page: { default: component(() => ({ html: '' })) } });
    expect(await adapter.renderNotFound(plain)).toContain('404 - Page Not Found');
    const custom = ctxFor({
      pattern: '/svelte-404b',
      page: { default: component(() => ({ html: '' })) },
      routeExtra: { notFoundFilePath: '/app/nf.svelte' },
      extraModules: { '/app/nf.svelte': { default: component(() => ({ html: '<h1>Gone</h1>' })) } },
    });
    expect(await adapter.renderNotFound(custom)).toContain('<h1>Gone</h1>');
  });

  it('generateClientScript hydrates via the svelte package export', () => {
    const prod = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(prod).toContain("import { hydrate } from 'svelte'");
    expect(prod).not.toContain("from 'svelte/client'");
    const dev = adapter.generateClientScript({ isDev: true, pledgepackPort: 4888, rscEnabled: false });
    expect(dev).toContain('http://localhost:4888/node_modules/.vite/svelte.js');
  });

  it('client script hydrates layouts around the page', () => {
    const js = adapter.generateClientScript({ isDev: false, rscEnabled: false });
    expect(js).toContain('resolveRouteChain');
    expect(js).toContain('children');
    expect(js).toContain('layouts');
  });
});
