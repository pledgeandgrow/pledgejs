/**
 * Framework-agnostic route-map helpers (no React dependency) shared by the
 * generated `/__pledge_router` module and the Vue/Solid/Svelte client scripts.
 */

export interface RouteChainData {
  pattern: string;
  params: Record<string, string>;
  searchParams: Record<string, string>;
}

interface ChainEntry {
  type: string;
  component?: unknown;
}

/**
 * Route-map key. Pages and API routes are keyed by their pattern; every other
 * convention (layout/error/loading/not-found/template) is prefixed with its
 * type so a layout and a page at the same pattern no longer overwrite each other.
 */
export function routeMapKey(convention: string, pattern: string): string {
  return convention === 'page' || convention === 'route' ? pattern : `${convention}:${pattern}`;
}

/**
 * Resolve the page component and its layout components (outermost first) for
 * the SSR-matched pattern. Layouts are found by ancestor-prefix walk.
 */
export function resolveRouteChain<C = unknown>(
  routes: Record<string, ChainEntry>,
  routeData: RouteChainData,
): { page: C; layouts: C[] } | null {
  const pageEntry = routes[routeData.pattern];
  if (!pageEntry || pageEntry.type !== 'page' || !pageEntry.component) return null;
  const prefixes = ['/'];
  let acc = '';
  for (const seg of routeData.pattern.split('/').filter(Boolean)) {
    acc += `/${seg}`;
    prefixes.push(acc);
  }
  const layouts: C[] = [];
  for (const prefix of prefixes) {
    const entry = routes[routeMapKey('layout', prefix)];
    if (entry && entry.type === 'layout' && entry.component) layouts.push(entry.component as C);
  }
  return { page: pageEntry.component as C, layouts };
}
