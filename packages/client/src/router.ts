import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createElement } from 'react';

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

const prefetchedPages = new Map<string, string>();

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

function prefetchPage(href: string, priority: 'high' | 'low' | 'auto' = 'auto'): void {
  const path = href.split('#')[0].split('?')[0];
  if (prefetchedPages.has(path)) return;

  const fetchPriority = priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'auto';

  fetch(path, {
    headers: { 'X-Pledge-Prefetch': '1' },
    priority: fetchPriority as RequestPriority,
  })
    .then((res) => res.text())
    .then((html) => {
      prefetchedPages.set(path, html);
    })
    .catch(() => {});
}

async function fetchPageContent(path: string): Promise<string | null> {
  const cached = prefetchedPages.get(path);
  if (cached) {
    return extractRootContent(cached);
  }

  try {
    const res = await fetch(path);
    const html = await res.text();
    prefetchedPages.set(path, html);
    return extractRootContent(html);
  } catch {
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

function swapRootContent(content: string): void {
  const root = document.getElementById('__pledge_root__');
  if (!root) return;
  root.innerHTML = content;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [params] = useState<Record<string, string>>({});
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

  const navigate = useCallback(async (to: string, options: NavigateOptions = {}) => {
    const { scroll = true, replace = false } = options;
    const url = new URL(to, window.location.origin);

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

    const content = await fetchPageContent(url.pathname);

    if (content) {
      swapRootContent(content);
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

  useEffect(() => {
    const handlePopState = async () => {
      const path = window.location.pathname;
      const savedScroll = scrollPositions.current.get(path);

      const content = await fetchPageContent(path);

      if (content) {
        swapRootContent(content);
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
