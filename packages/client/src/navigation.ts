/**
 * Framework-agnostic SPA navigation core (no React dependency).
 *
 * PledgeStack client navigation is an HTML-fetch model: navigate() fetches the
 * target page from the server, extracts the `#__pledge_root__` content and the
 * `window.__PLEDGE_ROUTE__` payload it carries, and hands both to the
 * framework's `onRoute` hook (React swaps + re-binds islands; Vue/Solid/Svelte
 * unmount, swap, and re-hydrate). All four renderers share the history,
 * prefetch, scroll-restoration, and race-handling logic implemented here.
 */

import type { RouteChainData } from './route-chain';

/** Route data emitted by SSR into `window.__PLEDGE_ROUTE__`. */
export type NavigationRouteData = RouteChainData;

export interface NavigateOptions {
  scroll?: boolean;
  replace?: boolean;
}

export interface NavigationTarget {
  url: URL;
  external: boolean;
  safe: boolean;
  fetchPath: string;
}

/**
 * Classify a navigation target. Cross-origin targets can't be handled by
 * pushState (it throws SecurityError) or fetched as pages, so callers must do a
 * real browser navigation for them; non-http(s) schemes (javascript:, data:)
 * must never be navigated to at all.
 */
export function classifyNavigation(to: string, origin: string): NavigationTarget {
  let url: URL;
  try {
    url = new URL(to, origin);
  } catch {
    return { url: new URL(origin), external: true, safe: false, fetchPath: '/' };
  }
  const safe = url.protocol === 'http:' || url.protocol === 'https:';
  return { url, external: url.origin !== origin, safe, fetchPath: url.pathname + url.search };
}

/**
 * Prefetch cache. Bounded to avoid unbounded growth from a long-lived SPA
 * session: without a cap, every page a user ever navigates to stays in memory
 * forever.
 */
const PREFETCH_CACHE_MAX = 100;
const prefetchedPages = new Map<string, string>();

/**
 * Clears the SPA page/prefetch cache. Useful after deploys (stale HTML from a
 * previous build should not be swapped in) and in tests.
 */
export function clearPageCache(): void {
  prefetchedPages.clear();
}

function rememberPrefetch(path: string, html: string): void {
  if (prefetchedPages.size >= PREFETCH_CACHE_MAX && !prefetchedPages.has(path)) {
    const oldest = prefetchedPages.keys().next().value;
    if (oldest !== undefined) prefetchedPages.delete(oldest);
  }
  prefetchedPages.set(path, html);
}

export function prefetchPage(href: string, priority: 'high' | 'low' | 'auto' = 'auto'): void {
  // Only same-origin pages can be prefetched into the SPA page cache.
  if (typeof window !== 'undefined' && classifyNavigation(href, window.location.origin).external) return;
  const path = href.split('#')[0];
  if (prefetchedPages.has(path)) return;

  const fetchPriority = priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto';

  // eslint-disable-next-line pledge/no-unsafe-fetch -- path is same-origin by construction (classifyNavigation gate above)
  fetch(path, {
    headers: { 'X-Pledge-Prefetch': '1' },
    priority: fetchPriority as RequestPriority,
  })
    .then((res) => res.text())
    .then((html) => {
      rememberPrefetch(path, html);
    })
    .catch(() => {});
}

export interface FetchedPage {
  html: string;
  /** Inner markup of `#__pledge_root__`, or null when the document has none. */
  content: string | null;
  /** Parsed `window.__PLEDGE_ROUTE__` payload, or null when absent/malformed. */
  routeData: NavigationRouteData | null;
}

export async function fetchPage(path: string, signal?: AbortSignal): Promise<FetchedPage | null> {
  try {
    // eslint-disable-next-line pledge/no-unsafe-fetch -- callers only pass paths already classified same-origin
    const html = prefetchedPages.get(path) ?? (await (await fetch(path, { signal })).text());
    rememberPrefetch(path, html);
    return { html, content: extractRootContent(html), routeData: extractRouteData(html) };
  } catch (err) {
    // AbortError is expected when a newer navigation supersedes this one.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    return null;
  }
}

function extractRootContent(html: string): string | null {
  const marker = '<div id="__pledge_root__">';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + marker.length;
  const endMarker = '</div>\n  <script';
  const endIdx = html.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;
  return html.slice(contentStart, endIdx);
}

/**
 * Pulls the `window.__PLEDGE_ROUTE__={...}` payload out of a fetched document.
 * The renderer escapes `<` as < inside the JSON, so the payload can never
 * contain a literal `</script>` — matching up to the closing tag is safe.
 */
function extractRouteData(html: string): NavigationRouteData | null {
  const m = html.match(/window\.__PLEDGE_ROUTE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]) as Partial<NavigationRouteData>;
    if (typeof data.pattern !== 'string') return null;
    return {
      pattern: data.pattern,
      params: data.params ?? {},
      searchParams: data.searchParams ?? {},
    };
  } catch {
    return null;
  }
}

/** Extracts `<title>` text so SPA navigation can update document.title. */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

function swapRootContent(content: string): void {
  const root = document.getElementById('__pledge_root__');
  if (!root) return;
  root.innerHTML = content;
}

export interface RouteSwapContext {
  url: URL;
  /** Full fetched document. */
  html: string;
  /** Inner markup of `#__pledge_root__`. */
  content: string;
  /** Route data parsed from the fetched document (pattern/params/searchParams). */
  routeData: NavigationRouteData | null;
}

export interface SpaNavigationOptions {
  /**
   * Framework hook invoked with the fetched page. Return true when the new
   * route was mounted (the core then commits history/scroll); return false to
   * fall back to a full browser navigation.
   */
  onRoute: (ctx: RouteSwapContext) => boolean | Promise<boolean>;
  /**
   * Optional hook after the raw DOM swap — e.g. React re-binds pledge islands
   * here. Frameworks that remount inside onRoute don't need it.
   */
  onSwap?: () => void;
  /** Anchor prefetch strategy. 'intent' prefetches on hover/focus/touch. */
  prefetch?: 'intent' | 'none';
  /** Root element id whose content gets swapped by the default swapContent. */
  rootId?: string;
}

export interface SpaNavigation {
  navigate: (to: string, options?: NavigateOptions) => Promise<void>;
  prefetch: (href: string, priority?: 'high' | 'low' | 'auto') => void;
  /** Removes all listeners (page teardown / HMR). */
  destroy: () => void;
}

/**
 * The currently installed navigation implementation — registered by
 * `installSpaNavigation` (Vue/Solid/Svelte client scripts) or by React's
 * RouterProvider, so `navigate()`/`prefetch()` below work identically in app
 * code regardless of framework.
 */
let activeNavigation: Pick<SpaNavigation, 'navigate' | 'prefetch'> | null = null;

/**
 * Registers the active SPA navigation implementation. Returns an unregister
 * function (used by React's RouterProvider on unmount / installSpaNavigation's
 * destroy()).
 */
export function registerSpaNavigation(
  nav: Pick<SpaNavigation, 'navigate' | 'prefetch'>,
): () => void {
  const prev = activeNavigation;
  activeNavigation = nav;
  return () => {
    if (activeNavigation === nav) activeNavigation = prev;
  };
}

/**
 * Framework-agnostic programmatic navigation — the same-origin
 * `<a>` interception covers plain anchors, and this covers imperative
 * navigation (`navigate('/checkout')`). Without an installed router it falls
 * back to a full browser navigation.
 */
export function navigate(to: string, options?: NavigateOptions): Promise<void> {
  if (activeNavigation) return activeNavigation.navigate(to, options);
  if (typeof window !== 'undefined') window.location.href = to;
  return Promise.resolve();
}

/**
 * Installs delegated SPA navigation for non-React renderers: every same-origin
 * `<a href>` click is intercepted (no Link component needed), history and
 * scroll restoration are handled, and `onRoute` decides how the fetched page
 * is mounted. Anchors opt out via `target`, `download`, `data-pledge-reload`,
 * external URLs, or modifier-clicks — all left to the browser.
 */
export function installSpaNavigation(options: SpaNavigationOptions): SpaNavigation {
  const { onRoute, onSwap, prefetch = 'intent' } = options;

  const scrollPositions = new Map<string, number>();
  let currentScroll = 0;
  let navSeq = 0;
  let abortController: AbortController | null = null;

  const scrollKey = () => window.location.pathname + window.location.search;
  const saveScroll = () => scrollPositions.set(scrollKey(), currentScroll);

  const onScroll = () => {
    currentScroll = window.scrollY;
  };

  async function applyNavigation(url: URL, page: FetchedPage): Promise<boolean> {
    if (!page || page.content == null) return false;
    const handled = await onRoute({
      url,
      html: page.html,
      content: page.content,
      routeData: page.routeData,
    });
    if (!handled) return false;
    if (page.routeData) {
      (window as { __PLEDGE_ROUTE__?: NavigationRouteData }).__PLEDGE_ROUTE__ = page.routeData;
    }
    onSwap?.();
    const title = extractTitle(page.html);
    if (title !== null) document.title = title;
    return true;
  }

  async function navigate(to: string, navOpts: NavigateOptions = {}): Promise<void> {
    const { scroll = true, replace = false } = navOpts;
    const target = classifyNavigation(to, window.location.origin);
    if (!target.safe) return;
    if (target.external) {
      // pushState rejects cross-origin URLs, so hand off to the browser.
      window.location.href = target.url.href;
      return;
    }
    const url = target.url;

    if (url.pathname === window.location.pathname && url.search === window.location.search) {
      if (scroll && !url.hash) window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    saveScroll();

    // Abort any in-flight navigation fetch before starting a new one.
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    const seq = ++navSeq;

    const page = await fetchPage(target.fetchPath, controller.signal);

    // A newer navigation started before this one resolved — discard.
    if (seq !== navSeq) return;

    if (!page || !(await applyNavigation(url, page))) {
      window.location.href = to;
      return;
    }

    if (replace) {
      window.history.replaceState({}, '', to);
    } else {
      window.history.pushState({}, '', to);
    }

    const saved = scrollPositions.get(url.pathname);
    requestAnimationFrame(() => {
      window.scrollTo(0, scroll ? (saved ?? 0) : 0);
    });
  }

  function isPlainAnchorClick(e: MouseEvent, anchor: HTMLAnchorElement): boolean {
    if (e.defaultPrevented || e.button !== 0) return false;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    if (anchor.target && anchor.target !== '_self') return false;
    if (anchor.hasAttribute('download')) return false;
    if (anchor.hasAttribute('data-pledge-reload') || anchor.hasAttribute('data-no-spa')) return false;
    return true;
  }

  const onClick = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]');
    if (!anchor || !(anchor instanceof HTMLAnchorElement)) return;
    if (!isPlainAnchorClick(e, anchor)) return;
    const target = classifyNavigation(anchor.getAttribute('href') ?? '', window.location.origin);
    if (!target.safe || target.external) return;
    // Same-page hash links are plain anchor scrolling — leave to the browser.
    if (
      target.url.pathname === window.location.pathname &&
      target.url.search === window.location.search &&
      target.url.hash
    ) {
      return;
    }
    e.preventDefault();
    void navigate(anchor.getAttribute('href') ?? '', {});
  };

  const onPrefetchIntent = (e: Event) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    prefetchPage(anchor.getAttribute('href') ?? '', 'auto');
  };

  const onPopState = async () => {
    // Participate in the nav sequence: a popstate supersedes any in-flight
    // navigate() and is itself superseded by a newer one.
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    const seq = ++navSeq;
    const path = window.location.pathname + window.location.search;
    const page = await fetchPage(path, controller.signal);
    if (seq !== navSeq) return;
    const url = new URL(window.location.href);
    if (!page || !(await applyNavigation(url, page))) {
      window.location.reload();
      return;
    }
    const saved = scrollPositions.get(window.location.pathname);
    requestAnimationFrame(() => {
      window.scrollTo(0, saved ?? 0);
    });
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('popstate', onPopState);
  document.addEventListener('click', onClick);
  if (prefetch === 'intent') {
    document.addEventListener('mouseover', onPrefetchIntent);
    document.addEventListener('focusin', onPrefetchIntent);
    document.addEventListener('touchstart', onPrefetchIntent, { passive: true });
  }

  const navigation: SpaNavigation = {
    navigate,
    prefetch: prefetchPage,
    destroy() {
      unregister();
      abortController?.abort();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onClick);
      document.removeEventListener('mouseover', onPrefetchIntent);
      document.removeEventListener('focusin', onPrefetchIntent);
      document.removeEventListener('touchstart', onPrefetchIntent);
    },
  };
  const unregister = registerSpaNavigation(navigation);
  return navigation;
}

export { extractRootContent, swapRootContent };
