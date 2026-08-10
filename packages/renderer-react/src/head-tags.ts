/**
 * Head tags and metadata rendering — shared across all renderers.
 * Extracted from pledgestack-core's head-tags.ts to avoid circular deps.
 */

import type { ResolvedRoute, Viewport } from 'pledgestack-shared';
import type { HeadMetadata } from 'pledgestack-shared';

export function renderHeadTags(metadata: HeadMetadata, route: ResolvedRoute): string {
  const tags: string[] = [];
  const title = metadata.title ?? route.metadata?.title ?? 'PledgeStack App';
  tags.push(`<title>${escapeHtml(title)}</title>`);

  if (metadata.description) {
    tags.push(`<meta name="description" content="${escapeHtml(metadata.description)}" />`);
  }
  if (metadata.keywords && metadata.keywords.length > 0) {
    tags.push(`<meta name="keywords" content="${escapeHtml(metadata.keywords.join(', '))}" />`);
  }
  if (metadata.robots) {
    tags.push(`<meta name="robots" content="${escapeHtml(metadata.robots)}" />`);
  }
  if (metadata.themeColor) {
    tags.push(`<meta name="theme-color" content="${escapeHtml(metadata.themeColor)}" />`);
  }

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) tags.push(`<meta property="og:title" content="${escapeHtml(og.title)}" />`);
    if (og.description) tags.push(`<meta property="og:description" content="${escapeHtml(og.description)}" />`);
    if (og.url) tags.push(`<meta property="og:url" content="${escapeHtml(og.url)}" />`);
    if (og.type) tags.push(`<meta property="og:type" content="${escapeHtml(og.type)}" />`);
    if (og.siteName) tags.push(`<meta property="og:site_name" content="${escapeHtml(og.siteName)}" />`);
    if (og.images) {
      for (const img of og.images) {
        tags.push(`<meta property="og:image" content="${escapeHtml(img)}" />`);
      }
    }
  }

  // Twitter Card
  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card) tags.push(`<meta name="twitter:card" content="${escapeHtml(tw.card)}" />`);
    if (tw.title) tags.push(`<meta name="twitter:title" content="${escapeHtml(tw.title)}" />`);
    if (tw.description) tags.push(`<meta name="twitter:description" content="${escapeHtml(tw.description)}" />`);
    if (tw.site) tags.push(`<meta name="twitter:site" content="${escapeHtml(tw.site)}" />`);
    if (tw.creator) tags.push(`<meta name="twitter:creator" content="${escapeHtml(tw.creator)}" />`);
    if (tw.images) {
      for (const img of tw.images) {
        tags.push(`<meta name="twitter:image" content="${escapeHtml(img)}" />`);
      }
    }
  }

  // Canonical URL
  if (metadata.alternates?.canonical) {
    tags.push(`<link rel="canonical" href="${escapeHtml(metadata.alternates.canonical)}" />`);
  }

  // Icons
  if (metadata.icons) {
    if (metadata.icons.favicon) tags.push(`<link rel="icon" href="${escapeHtml(metadata.icons.favicon)}" />`);
    if (metadata.icons.apple) tags.push(`<link rel="apple-touch-icon" href="${escapeHtml(metadata.icons.apple)}" />`);
    if (metadata.icons.icon) tags.push(`<link rel="icon" href="${escapeHtml(metadata.icons.icon)}" />`);
  }

  // Structured data (JSON-LD)
  if (metadata.structuredData) {
    const items = Array.isArray(metadata.structuredData) ? metadata.structuredData : [metadata.structuredData];
    for (const item of items) {
      tags.push(`<script type="application/ld+json">${JSON.stringify(item)}</script>`);
    }
  }

  // Other meta tags
  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      tags.push(`<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}" />`);
    }
  }

  return tags.join('\n  ');
}

export function renderViewportTags(viewport: Viewport | undefined): string {
  if (!viewport) return '';
  const tags: string[] = [];
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${viewport.width}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (viewport.maximumScale !== undefined) parts.push(`maximum-scale=${viewport.maximumScale}`);
  if (viewport.userScalable !== undefined) parts.push(`user-scalable=${viewport.userScalable ? 'yes' : 'no'}`);
  if (viewport.viewportFit) parts.push(`viewport-fit=${viewport.viewportFit}`);
  if (parts.length > 0) tags.push(`<meta name="viewport" content="${parts.join(', ')}" />`);
  if (viewport.themeColor) tags.push(`<meta name="theme-color" content="${escapeHtml(viewport.themeColor)}" />`);
  if (viewport.colorScheme) tags.push(`<meta name="color-scheme" content="${escapeHtml(viewport.colorScheme)}" />`);
  return tags.join('\n  ');
}

export function mergeMetadata(base: HeadMetadata, override: HeadMetadata): HeadMetadata {
  return {
    title: override.title ?? base.title,
    description: override.description ?? base.description,
    keywords: override.keywords ?? base.keywords,
    openGraph: { ...base.openGraph, ...override.openGraph },
    twitter: { ...base.twitter, ...override.twitter },
    robots: override.robots ?? base.robots,
    themeColor: override.themeColor ?? base.themeColor,
    alternates: { ...base.alternates, ...override.alternates },
    icons: { ...base.icons, ...override.icons },
    structuredData: override.structuredData ?? base.structuredData,
    other: { ...base.other, ...override.other },
  };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
