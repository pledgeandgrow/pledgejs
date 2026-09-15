import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { PledgeConfig, ResolvedRoute, Viewport } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, HeadMetadata } from '../router/types';
import { renderHeadTags, renderViewportTags } from './head-tags';

export interface SSGContext {
  config: PledgeConfig;
  routes: ResolvedRoute[];
  modules: Map<string, PageModule>;
}

/**
 * Generates static HTML for all routes marked as static.
 * Calls generateStaticParams for dynamic routes.
 *
 * Output is the full HTML shell (matching the SSR `wrapHtml` output) — with
 * `<head>` metadata, `#__pledge_root__`, the pledge manifest, and the client
 * hydration script — so exported pages can hydrate on the client.
 */
export async function generateStaticPages(ctx: SSGContext): Promise<Map<string, string>> {
  const output = new Map<string, string>();

  for (const route of ctx.routes) {
    if (route.mode === 'api' || route.mode === 'rsc' || route.isLayout || route.isNotFound) continue;

    const mod = ctx.modules.get(route.filePath);
    if (!mod) continue;

    // For dynamic routes, call generateStaticParams
    if (mod.generateStaticParams && route.pattern.includes(':')) {
      let paramsList: Awaited<ReturnType<typeof mod.generateStaticParams>>;
      try {
        paramsList = await mod.generateStaticParams();
      } catch (err) {
        // Surface the failure rather than silently emitting zero pages for
        // the route — a broken generateStaticParams should fail the build
        // loudly so the operator knows which route produced no output.
        throw new Error(
          `generateStaticParams failed for route "${route.pattern}" (${route.filePath}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      for (const params of paramsList) {
        const path = route.pattern.replace(/:(\w+)/g, (_, name) => params[name] ?? '');
        const html = renderToString(createElement(mod.default, params));
        const metadata = await resolvePageMetadata(mod, params);
        const viewport = await resolvePageViewport(mod);
        output.set(path, wrapStaticHtml(html, route, metadata, viewport));
      }
    } else {
      // Static route
      const html = renderToString(createElement(mod.default, {}));
      const metadata = await resolvePageMetadata(mod, {});
      const viewport = await resolvePageViewport(mod);
      output.set(route.pattern, wrapStaticHtml(html, route, metadata, viewport));
    }
  }

  return output;
}

/**
 * Resolves metadata for a page module — `generateMetadata(params)` takes
 * precedence over the static `metadata` export.
 */
async function resolvePageMetadata(mod: PageModule, params: Record<string, string>): Promise<HeadMetadata> {
  if (mod.generateMetadata) {
    try {
      return await mod.generateMetadata(params);
    } catch (err) {
      console.warn(`[pledgestack] generateMetadata() failed for SSG page, using static metadata:`, err);
    }
  }
  return (mod.metadata as HeadMetadata | undefined) ?? {};
}

/**
 * Resolves viewport from `generateViewport()` or the static `viewport` export.
 */
async function resolvePageViewport(mod: PageModule): Promise<Viewport | undefined> {
  if (mod.generateViewport) {
    try {
      return await mod.generateViewport();
    } catch (err) {
      console.warn('[pledgestack] generateViewport() failed for SSG page, using static viewport:', err);
    }
  }
  return mod.viewport;
}

/**
 * Wraps SSG-rendered content in the same HTML shell as the SSR renderer —
 * head tags, viewport, `#__pledge_root__`, pledge manifest, and the client
 * hydration script. Without this shell the page is a bare fragment that
 * cannot hydrate.
 */
function wrapStaticHtml(content: string, route: ResolvedRoute, metadata: HeadMetadata, viewport?: Viewport): string {
  const headTags = renderHeadTags(metadata, route);
  const viewportTags = renderViewportTags(viewport);

  const manifest: PledgeManifest = { pledges: [] };
  const manifestScript = `<script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${viewportTags || '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'}
  ${headTags}
  <link rel="stylesheet" href="/__pledge__/client.css" />
</head>
<body>
  <div id="__pledge_root__">${content}</div>
  ${manifestScript}
  <script type="module" src="/__pledge__/client.js"></script>
</body>
</html>`;
}
