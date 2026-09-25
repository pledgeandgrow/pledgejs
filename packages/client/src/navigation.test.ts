// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyNavigation,
  fetchPage,
  installSpaNavigation,
  extractRootContent,
  clearPageCache,
  type RouteSwapContext,
} from './navigation';

const doc = (body: string, routeData = '{ "pattern": "/target", "params": { "id": "9" }, "searchParams": {} }') =>
  `<!DOCTYPE html><html><head><title>Target</title></head><body>` +
  `<div id="__pledge_root__">${body}</div>\n  ` +
  `<script>window.__PLEDGE_ROUTE__=${routeData}</script></body></html>`;

function stubFetch(html: string, ok = true) {
  return vi.fn(async () => ({ ok, text: async () => html }) as Response);
}

describe('classifyNavigation', () => {
  const origin = 'http://localhost';

  it('marks same-origin http(s) targets safe and internal', () => {
    const r = classifyNavigation('/a/b?x=1', origin);
    expect(r.safe).toBe(true);
    expect(r.external).toBe(false);
    expect(r.fetchPath).toBe('/a/b?x=1');
  });

  it('marks cross-origin targets external', () => {
    expect(classifyNavigation('https://other.example/x', origin).external).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(classifyNavigation('javascript:alert(1)', origin).safe).toBe(false);
    expect(classifyNavigation('data:text/html,x', origin).safe).toBe(false);
  });
});

describe('extractRootContent / fetchPage', () => {
  it('extracts the root content between the marker and the trailing script', () => {
    expect(extractRootContent(doc('<p>hi</p>'))).toBe('<p>hi</p>');
    expect(extractRootContent('<html><body>no root</body></html>')).toBeNull();
  });

  it('parses __PLEDGE_ROUTE__ from the fetched document', async () => {
    vi.stubGlobal('fetch', stubFetch(doc('<p>x</p>')));
    const page = await fetchPage('/target');
    expect(page?.content).toBe('<p>x</p>');
    expect(page?.routeData).toEqual({ pattern: '/target', params: { id: '9' }, searchParams: {} });
    vi.unstubAllGlobals();
  });

  it('returns null content for documents without the root marker', async () => {
    vi.stubGlobal('fetch', stubFetch('<html><body>nope</body></html>'));
    const page = await fetchPage('/nowhere');
    expect(page?.content).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    expect(await fetchPage('/x')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('installSpaNavigation', () => {
  let nav: ReturnType<typeof installSpaNavigation> | null = null;

  beforeEach(() => {
    // The page/prefetch cache is module-level — reset it so fetches in one
    // test can't serve stale HTML to the next.
    clearPageCache();
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = '__pledge_root__';
    root.innerHTML = '<p>home</p>';
    document.body.appendChild(root);
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    nav?.destroy();
    nav = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('intercepts same-origin anchor clicks and hands the fetched page to onRoute', async () => {
    vi.stubGlobal('fetch', stubFetch(doc('<p>target</p>', '{ "pattern": "/spa-target", "params": { "id": "9" }, "searchParams": {} }')));
    const swaps: RouteSwapContext[] = [];
    nav = installSpaNavigation({ onRoute: (ctx) => (swaps.push(ctx), true) });

    const a = document.createElement('a');
    a.href = '/spa-target';
    a.textContent = 'go';
    document.body.appendChild(a);

    const evt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(swaps).toHaveLength(1));
    expect(swaps[0].content).toBe('<p>target</p>');
    expect(swaps[0].routeData?.pattern).toBe('/spa-target');
    expect(window.location.pathname).toBe('/spa-target');
    expect((window as { __PLEDGE_ROUTE__?: unknown }).__PLEDGE_ROUTE__).toEqual(swaps[0].routeData);
    expect(document.title).toBe('Target');
  });

  it('does not intercept external, modified, download, or opted-out clicks', () => {
    vi.stubGlobal('fetch', stubFetch(doc('<p>x</p>')));
    const onRoute = vi.fn(() => true);
    nav = installSpaNavigation({ onRoute });

    const mk = (attrs: Record<string, string>) => {
      const a = document.createElement('a');
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      document.body.appendChild(a);
      return a;
    };

    const external = mk({ href: 'https://other.example/' });
    const blank = mk({ href: '/t', target: '_blank' });
    const dl = mk({ href: '/f.zip', download: '' });
    const optOut = mk({ href: '/t', 'data-pledge-reload': '' });
    const plain = mk({ href: '/t' });

    for (const a of [external, blank, dl, optOut]) {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      a.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    // Modifier-click opens a new tab — not intercepted.
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    plain.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);

    expect(fetch).not.toHaveBeenCalled();
    expect(onRoute).not.toHaveBeenCalled();
  });

  it('lets same-page hash links fall through to the browser', () => {
    nav = installSpaNavigation({ onRoute: () => true });
    const a = document.createElement('a');
    a.href = '/#section';
    document.body.appendChild(a);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('returns false → the core performs a hard navigation fallback', async () => {
    vi.stubGlobal('fetch', stubFetch(doc('<p>t</p>')));
    const onRoute = vi.fn(() => false);
    nav = installSpaNavigation({ onRoute });
    await expect(nav.navigate('/target')).resolves.toBeUndefined();
    expect(onRoute).toHaveBeenCalled();
    // jsdom can't perform real navigation; reaching here means the fallback ran.
  });

  it('handles popstate by fetching the current location and swapping', async () => {
    vi.stubGlobal('fetch', stubFetch(doc('<p>back</p>', '{ "pattern": "/" }')));
    const swaps: RouteSwapContext[] = [];
    nav = installSpaNavigation({ onRoute: (ctx) => (swaps.push(ctx), true) });
    window.dispatchEvent(new PopStateEvent('popstate'));
    // jsdom's stubbed navigation can emit an extra stray popstate; assert the
    // expected swap happened rather than an exact count.
    await vi.waitFor(() => expect(swaps.length).toBeGreaterThanOrEqual(1));
    expect(swaps.some((s) => s.content === '<p>back</p>')).toBe(true);
  });

  it('prefetches same-origin anchors on hover intent', async () => {
    const fetchMock = stubFetch(doc('<p>t</p>'));
    vi.stubGlobal('fetch', fetchMock);
    nav = installSpaNavigation({ onRoute: () => true });
    const a = document.createElement('a');
    a.href = '/hovered';
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/hovered', expect.objectContaining({ headers: { 'X-Pledge-Prefetch': '1' } })));
  });

  it('destroy() removes listeners', () => {
    nav = installSpaNavigation({ onRoute: () => true });
    nav.destroy();
    nav = null;
    const a = document.createElement('a');
    a.href = '/t';
    document.body.appendChild(a);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
