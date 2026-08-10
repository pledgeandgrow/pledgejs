/**
 * Automatic route handlers for robots.txt and sitemap.xml.
 *
 * Intercepts requests for /robots.txt and /sitemap.xml before normal routing.
 * If the user has placed these files in the public/ directory, those are served
 * first. Otherwise, they are generated dynamically from the sitemap package
 * using the route tree and config.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PledgeConfig, PledgeResponse } from 'pledgestack-shared';
import type { RouteTree, RouteTreeNode } from 'pledgestack-core';
import { generateRobotsTxt, generateSitemapXML, routesToSitemapEntries } from 'pledgestack-sitemap';
import { generateRSSFeed, generateAtomFeed, generateJSONFeed, type FeedItem } from 'pledgestack-rss';

/**
 * Checks if a file exists in the public directory.
 */
async function tryReadPublicFile(config: PledgeConfig, filename: string): Promise<string | null> {
  const publicDir = join(config.rootDir, 'public');
  const filePath = join(publicDir, filename);
  try {
    const content = await readFile(filePath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}

/**
 * Collects all static (non-dynamic, non-API) routes from the route tree.
 */
function collectStaticRoutes(tree: RouteTree | null): string[] {
  if (!tree) return [];
  const routes: string[] = [];
  function walk(node: RouteTreeNode) {
    if (node.route && node.route.mode !== 'api' && !node.route.pattern.includes('[')) {
      routes.push(node.route.pattern);
    }
    for (const child of node.children) {
      walk(child);
    }
    if (node.slots) {
      for (const slot of Object.values(node.slots)) {
        walk(slot);
      }
    }
  }
  walk(tree.root);
  return routes;
}

/**
 * Attempts to serve robots.txt or sitemap.xml for a request.
 * Returns a PledgeResponse if the request was handled, or null if not.
 */
export async function tryServeSeoRoute(
  pathname: string,
  config: PledgeConfig,
  tree: RouteTree | null,
): Promise<PledgeResponse | null> {
  // robots.txt
  if (pathname === '/robots.txt') {
    // Check public/robots.txt first
    const staticContent = await tryReadPublicFile(config, 'robots.txt');
    if (staticContent !== null) {
      return {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: staticContent,
      };
    }

    // Generate dynamically
    const baseUrl = config.siteUrl ?? `http://localhost:3000`;
    const robotsContent = generateRobotsTxt({
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      disallow: ['/api/'],
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: robotsContent,
    };
  }

  // sitemap.xml
  if (pathname === '/sitemap.xml') {
    // Check public/sitemap.xml first
    const staticContent = await tryReadPublicFile(config, 'sitemap.xml');
    if (staticContent !== null) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        body: staticContent,
      };
    }

    // Generate dynamically from route tree
    const baseUrl = config.siteUrl ?? `http://localhost:3000`;
    const routes = collectStaticRoutes(tree);
    const entries = routesToSitemapEntries(routes, baseUrl, {
      changefreq: 'weekly',
      priority: 0.7,
    });
    const sitemapContent = generateSitemapXML(entries);

    return {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: sitemapContent,
    };
  }

  // RSS feed (rss.xml) — generated from feed.ts or feed/ directory if present
  if (pathname === '/rss.xml' || pathname === '/feed.xml' || pathname === '/feed.json' || pathname === '/atom.xml') {
    // Check public/ for static feed first
    const filename = pathname.slice(1);
    const staticContent = await tryReadPublicFile(config, filename);
    if (staticContent !== null) {
      const contentType = pathname.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'application/rss+xml; charset=utf-8';
      return { status: 200, headers: { 'Content-Type': contentType }, body: staticContent };
    }

    // Try to load feed items from the app's feed module
    const baseUrl = config.siteUrl ?? `http://localhost:3000`;
    let items: FeedItem[] = [];
    try {
      const feedPath = join(config.rootDir, config.appDir, 'feed.ts');
      const { existsSync } = await import('node:fs');
      if (existsSync(feedPath)) {
        const mod = await import(feedPath).catch(() => null);
        if (mod?.default) {
          items = await mod.default();
        }
      }
    } catch {
      // No feed module — return empty feed
    }

    const feedOpts = {
      title: 'RSS Feed',
      description: 'Latest updates',
      link: baseUrl,
      items,
    };

    if (pathname === '/feed.json') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: generateJSONFeed(feedOpts),
      };
    }
    if (pathname === '/atom.xml') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
        body: generateAtomFeed(feedOpts),
      };
    }
    return {
      status: 200,
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
      body: generateRSSFeed(feedOpts),
    };
  }

  return null;
}
