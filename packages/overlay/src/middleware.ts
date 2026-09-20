import type { DevtoolsData as DevtoolsDataType, RouteInfo, CacheEntry } from './types';

export type { DevtoolsData, RouteInfo, CacheEntry } from './types';

export interface DevtoolsMiddlewareOptions {
  /**
   * URL of a script that boots the devtools UI on the page. When set, the
   * middleware injects `<script src="..." defer>` before `</body>` (never in
   * production). When unset — the default — nothing is injected: PledgeStack
   * does not ship a script at a fixed URL, and injecting a reference to a route
   * nothing serves only produced a 404 on every page load.
   */
  scriptUrl?: string;
}

const SAFE_SCRIPT_URL = /^(\/|https?:\/\/)[^\s"'<>]*$/;

export function createDevtoolsMiddleware(options: DevtoolsMiddlewareOptions = {}) {
  const data: DevtoolsDataType = { routes: [], cacheEntries: [] };

  return {
    name: 'pledgestack-devtools',
    getData(): DevtoolsDataType {
      return data;
    },
    addRoute(route: RouteInfo): void {
      data.routes.push(route);
    },
    addCacheEntry(entry: CacheEntry): void {
      data.cacheEntries.push(entry);
    },
    transformHtml(html: string): string {
      if (!options.scriptUrl || !SAFE_SCRIPT_URL.test(options.scriptUrl)) return html;
      if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return html;
      if (!html.includes('</body>')) return html;
      return html.replace('</body>', () => `<script src="${options.scriptUrl}" defer></script></body>`);
    },
  };
}
