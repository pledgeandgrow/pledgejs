import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PledgeConfig, PledgePlugin } from 'pledgestack-shared';
import { escapeXml } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes } from 'pledgestack-core';

/**
 * Sitemap generation plugin for PledgeStack.
 *
 * Automatically generates sitemap.xml and robots.txt from the route tree
 * at build time, via the plugin's `buildEnd` hook.
 *
 * Usage in pledge.config.ts:
 * ```typescript
 * import { sitemapPlugin } from 'pledgestack-sitemap';
 *
 * export default defineConfig({
 *   plugins: [sitemapPlugin({
 *     siteUrl: 'https://example.com',
 *     exclude: ['/admin/*'],
 *   })],
 * });
 * ```
 */

export interface SitemapPluginOptions {
  /** Base site URL (e.g. 'https://example.com') */
  siteUrl: string;
  /** Paths to exclude from sitemap (glob patterns) */
  exclude?: string[];
  /** Default changefreq (default: 'weekly') */
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  /** Default priority 0.0-1.0 (default: 0.7) */
  priority?: number;
  /** Custom route metadata for specific paths */
  routes?: Record<string, SitemapEntry>;
  /** Include lastmod date (default: true) */
  lastmod?: boolean;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
  alternates?: Array<{ hreflang: string; href: string }>;
}

export function sitemapPlugin(options: SitemapPluginOptions): PledgePlugin {
  return {
    name: 'pledgestack-sitemap',

    async buildEnd(config: PledgeConfig) {
      // Scan the route tree the same way the build command does, then emit
      // sitemap.xml and robots.txt straight into the build output directory.
      // This is what actually makes them exist on disk for static exports
      // (output: 'export'), where there's no server to generate them at
      // request time the way `tryServeSeoRoute` does for standalone builds.
      const appDir = join(config.rootDir, config.appDir);
      const files = await scanAppDir(appDir);
      const resolved = resolveRoutes(files, config);

      const pagePaths = resolved
        .filter((route) => !route.isLayout && !route.isNotFound && route.mode !== 'api')
        .map((route) => route.pattern);

      const siteUrl = options.siteUrl.replace(/\/$/, '');
      const entries = routesToSitemapEntries(pagePaths, siteUrl, {
        changefreq: options.changefreq,
        priority: options.priority,
        exclude: options.exclude,
        routes: options.routes,
      });
      const finalEntries =
        options.lastmod === false ? entries.map(({ lastmod: _lastmod, ...rest }) => rest) : entries;

      const outDir = join(config.rootDir, config.outDir);
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'sitemap.xml'), generateSitemapXML(finalEntries), 'utf-8');
      await writeFile(
        join(outDir, 'robots.txt'),
        generateRobotsTxt({ sitemapUrl: `${siteUrl}/sitemap.xml` }),
        'utf-8',
      );
    },

    transformHtml(html) {
      // Inject sitemap link reference in HTML head
      if (html.includes('<head>') && !html.includes('rel="sitemap"')) {
        return html.replace(
          '<head>',
          `<head><link rel="sitemap" type="application/xml" href="/sitemap.xml">`,
        );
      }
      return html;
    },
  };
}

/**
 * Generate sitemap XML from a list of entries.
 */
export function generateSitemapXML(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts: string[] = [`  <url>`, `    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod}</lastmod>`);
    if (entry.changefreq) parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined) parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    if (entry.alternates) {
      for (const alt of entry.alternates) {
        parts.push(`    <xhtml:link rel="alternate" hreflang="${alt.hreflang}" href="${escapeXml(alt.href)}"/>`);
      }
    }
    parts.push(`  </url>`);
    return parts.join('\n');
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>`;
}

/**
 * Generate sitemap entries from a route list.
 * Filters out API routes, dynamic segments, and excluded patterns.
 */
export function routesToSitemapEntries(
  routes: string[],
  siteUrl: string,
  options?: {
    changefreq?: string;
    priority?: number;
    exclude?: string[];
    routes?: Record<string, Partial<SitemapEntry>>;
  },
): SitemapEntry[] {
  const exclude = options?.exclude ?? [];
  const changefreq = options?.changefreq ?? 'weekly';
  const priority = options?.priority ?? 0.7;

  return routes
    .filter((route) => {
      // Skip API routes
      if (route.startsWith('/api/')) return false;
      // Skip dynamic segments
      if (route.includes('[')) return false;
      // Skip excluded patterns
      for (const pattern of exclude) {
        if (matchGlob(route, pattern)) return false;
      }
      return true;
    })
    .map((route) => {
      const custom = options?.routes?.[route];
      return {
        loc: `${siteUrl}${route === '/' ? '' : route}`,
        changefreq: custom?.changefreq ?? changefreq,
        priority: custom?.priority ?? priority,
        lastmod: custom?.lastmod ?? new Date().toISOString().split('T')[0],
      };
    });
}

function matchGlob(path: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*/g, '.*')                    // * → .*
    .replace(/\?/g, '.');                     // ? → .
  return new RegExp(`^${regex}$`).test(path);
}

/**
 * Generate robots.txt content.
 */
export function generateRobotsTxt(options: {
  sitemapUrl?: string;
  allow?: string[];
  disallow?: string[];
  crawlDelay?: number;
}): string {
  const lines: string[] = ['User-agent: *'];

  if (options.disallow) {
    for (const path of options.disallow) {
      lines.push(`Disallow: ${path}`);
    }
  } else {
    lines.push('Disallow:');
  }

  if (options.allow) {
    for (const path of options.allow) {
      lines.push(`Allow: ${path}`);
    }
  }

  if (options.crawlDelay) {
    lines.push(`Crawl-delay: ${options.crawlDelay}`);
  }

  if (options.sitemapUrl) {
    lines.push('', `Sitemap: ${options.sitemapUrl}`);
  }

  return lines.join('\n');
}
