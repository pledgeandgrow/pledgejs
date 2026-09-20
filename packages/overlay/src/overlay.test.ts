// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ErrorOverlay,
  DevTools,
  CacheInspector,
  ComponentInspector,
  createDevtoolsMiddleware,
  type StructuredError,
  type ComponentInfo,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

async function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(element); });
  return host;
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const err = (id: string, message: string, extra: Partial<StructuredError> = {}): StructuredError => ({
  id, message, timestamp: 1, type: 'runtime', severity: 'error', ...extra,
});

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => { (el as HTMLElement).click(); });
};
const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);

describe('ErrorOverlay', () => {
  it('renders nothing when there are no errors', async () => {
    const host = await render(createElement(ErrorOverlay, { errors: [] }));
    expect(host.innerHTML).toBe('');
  });

  it('lists errors with a count and shows the first error message', async () => {
    const host = await render(createElement(ErrorOverlay, {
      errors: [err('a', 'Boom happened', { stack: 'at foo (x.ts:1:1)' }), err('b', 'Second failure')],
    }));
    expect(host.textContent).toContain('PledgeStack Errors (2)');
    expect(host.textContent).toContain('Boom happened');
    expect(host.textContent).toContain('Second failure');
  });

  it('minimizes to a badge and restores on click', async () => {
    const host = await render(createElement(ErrorOverlay, { errors: [err('a', 'Boom')] }));
    await click(button(host, 'Minimize'));
    expect(host.textContent).toBe('1 error(s)');
    await click(host.firstElementChild);
    expect(host.textContent).toContain('PledgeStack Errors (1)');
  });

  it('calls onClear from the Clear button', async () => {
    const onClear = vi.fn();
    const host = await render(createElement(ErrorOverlay, { errors: [err('a', 'x')], onClear }));
    await click(button(host, 'Clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('escapes hostile error messages (React text nodes, never HTML)', async () => {
    const host = await render(createElement(ErrorOverlay, { errors: [err('a', '<img src=x onerror=alert(1)>')] }));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('DevTools', () => {
  const routes = [
    { path: '/', mode: 'ssg', runtime: 'node', filePath: '/proj/app/page.tsx', loadTime: 0, renderTime: 12.34 },
    { path: '/api/x', mode: 'api', runtime: 'edge', filePath: 'C:\\proj\\app\\api\\x\\route.ts' },
  ];

  it('starts collapsed and opens on click, showing the routes table', async () => {
    const host = await render(createElement(DevTools, { routes }));
    expect(host.textContent).toBe('PledgeStack DevTools');
    await click(host.querySelector('button'));
    expect(host.textContent).toContain('/api/x');
    expect(host.textContent).toContain('page.tsx');
    // Windows-style paths are reduced to their base name too.
    expect(host.textContent).toContain('route.ts');
    expect(host.textContent).not.toContain('C:\\proj');
  });

  it('shows 0ms load times (not a dash) and a dash only when the value is missing', async () => {
    const host = await render(createElement(DevTools, { routes }));
    await click(host.querySelector('button'));
    const rows = Array.from(host.querySelectorAll('tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent));
    expect(rows[0][4]).toBe('0.0ms');
    expect(rows[0][5]).toBe('12.3ms');
    expect(rows[1][4]).toBe('-');
    expect(rows[1][5]).toBe('-');
  });

  it('switches to the cache and build tabs', async () => {
    const host = await render(createElement(DevTools, {
      routes,
      cacheEntries: [{ key: 'posts', tags: ['blog', 'all'], expiresAt: 0, size: 42 }],
    }));
    await click(host.querySelector('button'));
    await click(button(host, 'Cache'));
    expect(host.textContent).toContain('posts');
    expect(host.textContent).toContain('blog, all');
    expect(host.textContent).toContain('42B');
    await click(button(host, 'Build'));
    expect(host.textContent).toContain('Build Summary');
    const summary = Array.from(host.querySelectorAll('span')).map((s) => s.textContent);
    expect(summary).toEqual(expect.arrayContaining(['total', '2', 'ssg', 'api']));
  });
});

describe('ComponentInspector', () => {
  it('prompts when nothing is selected', async () => {
    const host = await render(createElement(ComponentInspector, { selected: null, theme: 'dark' }));
    expect(host.textContent).toContain('No component selected');
  });

  it('shows the component summary, props, state and lets the source link navigate', async () => {
    const onNavigateSource = vi.fn();
    const selected: ComponentInfo = {
      name: 'Counter', type: 'client', depth: 2, filePath: '/app/counter.tsx', renderTime: 1.26,
      props: { label: 'hi', step: 2 }, state: { count: 5 }, hooks: ['useState'],
    };
    const host = await render(createElement(ComponentInspector, { selected, theme: 'light', onNavigateSource }));
    expect(host.textContent).toContain('Counter');
    expect(host.textContent).toContain('client');
    expect(host.textContent).toContain('1.3ms');
    expect(host.textContent).toContain('Props (2)');
    expect(host.textContent).toContain('State (1)');
    await click(host.querySelector('a'));
    expect(onNavigateSource).toHaveBeenCalledWith('/app/counter.tsx');
  });
});

describe('CacheInspector', () => {
  it('fetches cache data from the dev endpoint on mount', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await render(createElement(CacheInspector, { refreshInterval: 0 }));
    expect(fetchMock).toHaveBeenCalledWith('/__pledge__/cache/inspect');
  });

  it('survives a server without the inspection endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const host = await render(createElement(CacheInspector, { refreshInterval: 0 }));
    expect(host).toBeDefined();
  });
});

describe('createDevtoolsMiddleware', () => {
  it('collects routes and cache entries', () => {
    const mw = createDevtoolsMiddleware();
    mw.addRoute({ path: '/', mode: 'ssr', runtime: 'node', filePath: 'a' });
    mw.addCacheEntry({ key: 'k', tags: [], expiresAt: 1, size: 2 });
    expect(mw.getData()).toEqual({
      routes: [{ path: '/', mode: 'ssr', runtime: 'node', filePath: 'a' }],
      cacheEntries: [{ key: 'k', tags: [], expiresAt: 1, size: 2 }],
    });
    expect(mw.name).toBe('pledgestack-devtools');
  });

  it('does not inject a script by default (nothing serves /__pledge/devtools)', () => {
    const html = '<html><body>x</body></html>';
    expect(createDevtoolsMiddleware().transformHtml(html)).toBe(html);
  });

  it('injects the configured script before </body> in development only', () => {
    const mw = createDevtoolsMiddleware({ scriptUrl: '/assets/devtools.js' });
    expect(mw.transformHtml('<body>x</body>')).toBe('<body>x<script src="/assets/devtools.js" defer></script></body>');
    expect(mw.transformHtml('<div>no body</div>')).toBe('<div>no body</div>');
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(mw.transformHtml('<body>x</body>')).toBe('<body>x</body>');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('refuses script URLs that could break out of the attribute', () => {
    const mw = createDevtoolsMiddleware({ scriptUrl: '/x.js"><script>alert(1)</script>' });
    expect(mw.transformHtml('<body></body>')).toBe('<body></body>');
  });
});
