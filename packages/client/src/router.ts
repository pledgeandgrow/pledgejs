import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode, type ComponentType } from 'react';
import { createElement, isValidElement, Children, Fragment, Suspense, Component } from 'react';
import { routeMapKey } from './route-chain';
import {
  classifyNavigation,
  fetchPage,
  prefetchPage,
  registerSpaNavigation,
  swapRootContent,
  type FetchedPage,
} from './navigation';
import { rehydratePledges } from './hydrate-pledges';

export { classifyNavigation };

/** Route data emitted by SSR into `window.__PLEDGE_ROUTE__`. */
export interface PledgeRouteData {
  pattern: string;
  params: Record<string, string>;
  searchParams: Record<string, string>;
}

interface RouteMapEntry {
  type: string;
  component?: ComponentType<Record<string, unknown>>;
}

/**
 * Rebuild the same React element tree the server rendered — the matched page
 * component wrapped in its layout chain — from the generated `routes` map and
 * the SSR route data. This is what the client hydrates against; hydrating an
 * empty tree (the previous behavior) discarded the entire SSR payload.
 *
 * Layouts are resolved by ancestor-prefix walk over the route pattern
 * (root → leaf) and wrapped innermost-first, mirroring the server's
 * getLayoutChain composition.
 */
export function resolveRouteElement(
  routes: Record<string, RouteMapEntry>,
  routeData: PledgeRouteData,
): ReactNode {
  const pageEntry = routes[routeData.pattern];
  if (!pageEntry?.component) return null;

  const props = { params: routeData.params, searchParams: routeData.searchParams };

  // Ancestor prefixes of the pattern, root → leaf: '/', '/blog', '/blog/:slug'.
  const prefixes = ['/'];
  let acc = '';
  for (const seg of routeData.pattern.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    prefixes.push(acc);
  }

  // Per-segment error/loading/template wrappers — the server wraps every page
  // and layout in these boundaries (buildElementTree in renderer-react), and
  // their anchors (<!--$-->, error fallbacks) are compared positionally during
  // hydration, so the client tree must reproduce them exactly. Conventions are
  // same-directory only (resolveRoutes attaches dir-local files), so lookups
  // are exact-prefix, not nearest-ancestor.
  const conventionAt = (convention: string, prefix: string) =>
    routes[routeMapKey(convention, prefix)]?.component;
  const wrapSegment = (
    node: ReactNode,
    find: (convention: string) => ComponentType<Record<string, unknown>> | undefined,
  ): ReactNode => {
    let out = node;
    const ErrorC = find('error') as ComponentType<{ error: Error; reset: () => void; children?: ReactNode }> | undefined;
    if (ErrorC) out = createElement(ClientErrorBoundary, { fallback: ErrorC }, out);
    const LoadingC = find('loading');
    if (LoadingC) out = createElement(Suspense, { fallback: createElement(LoadingC, {}) }, out);
    const TemplateC = find('template');
    if (TemplateC) out = createElement(TemplateC, { children: out });
    return out;
  };

  // Page with its own directory's convention wrappers.
  let element: ReactNode = wrapSegment(
    createElement(pageEntry.component, props),
    (conv) => conventionAt(conv, routeData.pattern),
  );

  // Wrap innermost (leaf) layout first so the root layout ends up outermost,
  // each with its own segment wrappers — mirroring the server's layout chain.
  for (let i = prefixes.length - 1; i >= 0; i--) {
    const layoutEntry = routes[routeMapKey('layout', prefixes[i])] ?? routes[prefixes[i]];
    const Layout = layoutEntry && layoutEntry.type === 'layout' ? layoutEntry.component : undefined;
    if (!Layout) continue;
    // DocumentLayoutShim unwraps a full-<html> layout inside the boundary,
    // matching the server's splitDocumentMarkup output.
    let content: ReactNode = createElement(
      DocumentLayoutShim,
      null,
      createElement(Layout, { ...props, children: element }),
    );
    content = wrapSegment(content, (conv) => conventionAt(conv, prefixes[i]));
    element = content;
  }
  return element;
}

interface ClientErrorBoundaryState { hasError: boolean; error: Error | null; }

/**
 * Mirrors the ErrorBoundary used by the server renderer (renderer-react) —
 * same state shape and fallback contract so hydration renders the same tree.
 */
class ClientErrorBoundary extends Component<
  { fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode },
  ClientErrorBoundaryState
> {
  state: ClientErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ClientErrorBoundaryState {
    return { hasError: true, error };
  }

  reset = () => { this.setState({ hasError: false, error: null }); };

  render() {
    if (this.state.hasError && this.state.error) {
      return createElement(this.props.fallback, { error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

/**
 * Root layouts may return a full document (`<html><head>…</head><body>…`),
 * which SSR splits — head children go to the real <head>, body children mount
 * inside #__pledge_root__. This shim performs the same unwrap client-side so
 * the hydration tree matches the served markup (otherwise React reports a
 * #418 mismatch comparing <html> against the split body content).
 *
 * The layout is invoked directly only when it is a plain function component;
 * class/memo/forwardRef components render normally (they can't return a
 * document element anyway in those forms).
 */
export function DocumentLayoutShim({ children }: { children?: ReactNode }): ReactNode {
  if (!isValidElement(children)) return children;
  const Layout = children.type;
  if (typeof Layout !== 'function' || (Layout as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    return children;
  }
  const out = (Layout as (p: Record<string, unknown>) => ReactNode)(
    (children.props ?? {}) as Record<string, unknown>,
  );
  if (isValidElement(out) && out.type === 'html') {
    const kids = Children.toArray((out.props as { children?: ReactNode } | undefined)?.children);
    const body = kids.find((k) => isValidElement(k) && (k as { type?: unknown }).type === 'body');
    if (body) {
      return createElement(Fragment, null, (body as { props?: { children?: ReactNode } }).props?.children);
    }
    return createElement(
      Fragment,
      null,
      ...kids.filter((k) => !(isValidElement(k) && (k as { type?: unknown }).type === 'head')),
    );
  }
  return out;
}

export interface ClientRouterContextValue {
  pathname: string;
  params: Record<string, string>;
  query: Record<string, string>;
  navigate: (to: string, options?: NavigateOptions) => void;
  refresh: () => void;
  back: () => void;
  forward: () => void;
  prefetch: (href: string, priority?: 'high' | 'low' | 'auto') => void;
}

interface NavigateOptions {
  scroll?: boolean;
  replace?: boolean;
  priority?: 'high' | 'low' | 'auto';
}

const RouterContext = createContext<ClientRouterContextValue | null>(null);

export function useRouter(): ClientRouterContextValue {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return ctx;
}

/**
 * Returns the current pathname (e.g. "/blog/hello-world").
 * Next.js-compatible: `const pathname = usePathname()`
 */
export function usePathname(): string {
  return useRouter().pathname;
}

/**
 * Returns the current search params as a readonly record.
 * Next.js-compatible: `const searchParams = useSearchParams()`
 *
 * Returns a URLSearchParams-like object with get(), getAll(), has(), entries(),
 * and forEach() methods for compatibility with Next.js apps.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  const { query } = useRouter();
  return new ReadonlyURLSearchParams(query);
}

/**
 * A readonly wrapper around URLSearchParams backed by the router's query object.
 */
export class ReadonlyURLSearchParams {
  private readonly params: Record<string, string>;

  constructor(params: Record<string, string>) {
    this.params = params;
  }

  get(name: string): string | null {
    return this.params[name] ?? null;
  }

  getAll(name: string): string[] {
    const value = this.params[name];
    return value ? [value] : [];
  }

  has(name: string): boolean {
    return name in this.params;
  }

  entries(): IterableIterator<[string, string]> {
    return Object.entries(this.params)[Symbol.iterator]();
  }

  keys(): IterableIterator<string> {
    return Object.keys(this.params)[Symbol.iterator]();
  }

  values(): IterableIterator<string> {
    return Object.values(this.params)[Symbol.iterator]();
  }

  forEach(callback: (value: string, key: string, parent: this) => void): void {
    for (const [key, value] of Object.entries(this.params)) {
      callback(value, key, this);
    }
  }

  get size(): number {
    return Object.keys(this.params).length;
  }

  toString(): string {
    return new URLSearchParams(this.params).toString();
  }
}

/**
 * Applies a fetched page to the document: swaps the root content, refreshes
 * `window.__PLEDGE_ROUTE__`, re-binds pledge islands on the new DOM (the
 * elements inserted by innerHTML are never hydrated otherwise), and syncs
 * `document.title` with the fetched page.
 */
function applyFetchedPage(page: FetchedPage): void {
  swapRootContent(page.content!);
  if (page.routeData) {
    (window as { __PLEDGE_ROUTE__?: PledgeRouteData }).__PLEDGE_ROUTE__ = page.routeData;
  }
  rehydratePledges();
  const title = page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title !== undefined) document.title = title;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [pathname, setPathname] = useState(window.location.pathname);
  // Seed params from the SSR route data so useRouter().params is correct on the
  // initial render instead of always being empty.
  const [params] = useState<Record<string, string>>(
    () => (window as { __PLEDGE_ROUTE__?: PledgeRouteData }).__PLEDGE_ROUTE__?.params ?? {},
  );
  const [query, setQuery] = useState<Record<string, string>>(
    Object.fromEntries(new URLSearchParams(window.location.search).entries()),
  );

  const scrollPositions = useRef<Map<string, number>>(new Map());
  const currentScroll = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      currentScroll.current = window.scrollY;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const saveScrollPosition = useCallback(() => {
    scrollPositions.current.set(pathname, currentScroll.current);
  }, [pathname]);

  // Track the latest navigation so a slow in-flight fetch can't overwrite a
  // newer navigation's result (race protection). The AbortController cancels
  // the previous in-flight fetch when a new navigation starts, freeing
  // bandwidth/CPU instead of letting the stale fetch run to completion (#34).
  const navSeq = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const navigate = useCallback(async (to: string, options: NavigateOptions = {}) => {
    const { scroll = true, replace = false } = options;
    const target = classifyNavigation(to, window.location.origin);
    if (!target.safe) return;
    if (target.external) {
      // pushState rejects cross-origin URLs, so hand off to the browser.
      window.location.href = target.url.href;
      return;
    }
    const url = target.url;

    if (url.pathname === pathname && url.search === window.location.search) {
      if (scroll) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    saveScrollPosition();

    if (replace) {
      window.history.replaceState({}, '', to);
    } else {
      window.history.pushState({}, '', to);
    }

    // Abort any in-flight navigation fetch before starting a new one.
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const seq = ++navSeq.current;
    // Include the query string: the server renders search-dependent pages from it.
    const page = await fetchPage(target.fetchPath, controller.signal);

    // A newer navigation started before this one resolved — discard.
    if (seq !== navSeq.current) return;

    if (page?.content) {
      applyFetchedPage(page);
      setPathname(url.pathname);
      setQuery(Object.fromEntries(url.searchParams.entries()));

      if (scroll) {
        const saved = scrollPositions.current.get(url.pathname);
        requestAnimationFrame(() => {
          window.scrollTo(0, saved ?? 0);
        });
      } else {
        requestAnimationFrame(() => {
          window.scrollTo(0, 0);
        });
      }
    } else {
      window.location.href = to;
    }
  }, [pathname, saveScrollPosition]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  const back = useCallback(() => window.history.back(), []);
  const forward = useCallback(() => window.history.forward(), []);

  const prefetch = useCallback((href: string, priority?: 'high' | 'low' | 'auto') => {
    prefetchPage(href, priority);
  }, []);

  // Register as the active navigation so framework-agnostic
  // `navigate()`/`prefetch()` from this package delegate to React-aware routing.
  useEffect(() => registerSpaNavigation({ navigate, prefetch }), [navigate, prefetch]);

  useEffect(() => {
    const handlePopState = async () => {
      const path = window.location.pathname;
      const savedScroll = scrollPositions.current.get(path);

      const page = await fetchPage(path + window.location.search);

      if (page?.content) {
        applyFetchedPage(page);
        setPathname(path);
        setQuery(Object.fromEntries(new URLSearchParams(window.location.search).entries()));

        requestAnimationFrame(() => {
          window.scrollTo(0, savedScroll ?? 0);
        });
      } else {
        window.location.reload();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const value: ClientRouterContextValue = {
    pathname,
    params,
    query,
    navigate,
    refresh,
    back,
    forward,
    prefetch,
  };

  return createElement(RouterContext.Provider, { value }, children);
}

export function Link({
  href,
  children,
  prefetch = 'intent',
  scroll = true,
  replace = false,
  priority = 'auto',
  ...props
}: {
  href: string;
  children: ReactNode;
  prefetch?: boolean | 'intent' | 'render' | 'none' | 'visible';
  scroll?: boolean;
  replace?: boolean;
  priority?: 'high' | 'low' | 'auto';
  [key: string]: unknown;
}) {
  const { navigate, prefetch: doPrefetch } = useRouter();
  const linkRef = useRef<HTMLElement | null>(null);

  // 'render' strategy: prefetch immediately on mount
  useEffect(() => {
    if (prefetch === 'render' || prefetch === true) {
      doPrefetch(href, priority);
    }
  }, [href, prefetch, priority, doPrefetch]);

  // 'visible' strategy: prefetch when link enters viewport (IntersectionObserver)
  useEffect(() => {
    if (prefetch !== 'visible') return;
    if (typeof IntersectionObserver === 'undefined') return;
    const el = linkRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            doPrefetch(href, priority);
            observer.disconnect();
          }
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [href, prefetch, priority, doPrefetch]);

  const handleClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    const target = (e.currentTarget as HTMLElement).getAttribute('target');
    if (target === '_blank') return;

    e.preventDefault();
    navigate(href, { scroll, replace });
  };

  const handleMouseEnter = () => {
    if (prefetch === 'intent' || prefetch === true) {
      doPrefetch(href, priority);
    }
  };

  const handleFocus = () => {
    if (prefetch === 'intent' || prefetch === true) {
      doPrefetch(href, priority);
    }
  };

  return createElement('a', {
    href,
    ref: linkRef,
    onClick: handleClick,
    onMouseEnter: handleMouseEnter,
    onFocus: handleFocus,
    ...props,
  }, children);
}
