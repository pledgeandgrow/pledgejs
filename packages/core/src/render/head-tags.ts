/**
 * Shared head tag rendering utilities.
 *
 * Single source of truth for rendering <head> tags from HeadMetadata.
 * Used by server.ts, streaming-metadata.ts, and rust-html.ts to avoid
 * code duplication and ensure consistent tag generation.
 */

import type { HeadMetadata } from '../router/types';
import type { Viewport, ResolvedRoute } from 'pledgestack-shared';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Native SIMD-accelerated HTML escape (from rust-html addon) */
let nativeEscapeHtml: ((input: string) => string) | null = null;
let nativeEscapeChecked = false;

function loadNativeEscape(): typeof nativeEscapeHtml {
  if (nativeEscapeChecked) return nativeEscapeHtml;
  nativeEscapeChecked = true;
  try {
    const addon = require('../../native/rust-html.node') as { escape_html: (input: string) => string };
    if (typeof addon.escape_html === 'function') {
      nativeEscapeHtml = addon.escape_html;
    }
  } catch {
    // Addon not compiled
  }
  return nativeEscapeHtml;
}

/**
 * Escapes HTML entities in a string to prevent XSS.
 * Uses native SIMD-accelerated escaping when the rust-html addon is available.
 */
export function escapeHtmlShared(str: string): string {
  const native = loadNativeEscape();
  if (native) return native(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Renders head metadata to HTML tags.
 *
 * Supports: title, description, keywords, robots, themeColor, canonical,
 * icons (icon/apple/favicon), OpenGraph, Twitter cards, JSON-LD structured
 * data, and arbitrary other meta tags.
 */
export function renderHeadTags(metadata: HeadMetadata, route?: ResolvedRoute): string {
  const tags: string[] = [];

  const title = metadata.title ?? route?.metadata?.title ?? 'PledgeStack App';
  tags.push(`<title>${escapeHtmlShared(title)}</title>`);

  if (metadata.description) {
    tags.push(`<meta name="description" content="${escapeHtmlShared(metadata.description)}" />`);
  }

  if (metadata.keywords && metadata.keywords.length > 0) {
    tags.push(`<meta name="keywords" content="${escapeHtmlShared(metadata.keywords.join(', '))}" />`);
  }

  if (metadata.robots) {
    tags.push(`<meta name="robots" content="${escapeHtmlShared(metadata.robots)}" />`);
  }

  if (metadata.themeColor) {
    tags.push(`<meta name="theme-color" content="${escapeHtmlShared(metadata.themeColor)}" />`);
  }

  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) tags.push(`<meta property="og:title" content="${escapeHtmlShared(og.title)}" />`);
    if (og.description) tags.push(`<meta property="og:description" content="${escapeHtmlShared(og.description)}" />`);
    if (og.url) tags.push(`<meta property="og:url" content="${escapeHtmlShared(og.url)}" />`);
    if (og.type) tags.push(`<meta property="og:type" content="${escapeHtmlShared(og.type)}" />`);
    if (og.siteName) tags.push(`<meta property="og:site_name" content="${escapeHtmlShared(og.siteName)}" />`);
    if (og.images) {
      for (const img of og.images) {
        tags.push(`<meta property="og:image" content="${escapeHtmlShared(img)}" />`);
      }
    }
  }

  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card) tags.push(`<meta name="twitter:card" content="${escapeHtmlShared(tw.card)}" />`);
    if (tw.site) tags.push(`<meta name="twitter:site" content="${escapeHtmlShared(tw.site)}" />`);
    if (tw.creator) tags.push(`<meta name="twitter:creator" content="${escapeHtmlShared(tw.creator)}" />`);
    if (tw.title) tags.push(`<meta name="twitter:title" content="${escapeHtmlShared(tw.title)}" />`);
    if (tw.description) tags.push(`<meta name="twitter:description" content="${escapeHtmlShared(tw.description)}" />`);
    if (tw.images) {
      for (const img of tw.images) {
        tags.push(`<meta name="twitter:image" content="${escapeHtmlShared(img)}" />`);
      }
    }
  }

  if (metadata.alternates?.canonical) {
    tags.push(`<link rel="canonical" href="${escapeHtmlShared(metadata.alternates.canonical)}" />`);
  }

  if (metadata.icons?.icon) {
    tags.push(`<link rel="icon" href="${escapeHtmlShared(metadata.icons.icon)}" />`);
  }
  if (metadata.icons?.apple) {
    tags.push(`<link rel="apple-touch-icon" href="${escapeHtmlShared(metadata.icons.apple)}" />`);
  }
  if (metadata.icons?.favicon) {
    tags.push(`<link rel="shortcut icon" href="${escapeHtmlShared(metadata.icons.favicon)}" />`);
  }

  // JSON-LD structured data
  if (metadata.structuredData) {
    const schemas = Array.isArray(metadata.structuredData) ? metadata.structuredData : [metadata.structuredData];
    for (const schema of schemas) {
      tags.push(`<script type="application/ld+json">${JSON.stringify(schema)}</script>`);
    }
  }

  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      tags.push(`<meta name="${escapeHtmlShared(name)}" content="${escapeHtmlShared(content)}" />`);
    }
  }

  return tags.join('\n  ');
}

/**
 * Renders viewport meta tags from a Viewport object.
 */
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
  if (viewport.themeColor) tags.push(`<meta name="theme-color" content="${escapeHtmlShared(viewport.themeColor)}" />`);
  if (viewport.colorScheme) tags.push(`<meta name="color-scheme" content="${escapeHtmlShared(viewport.colorScheme)}" />`);
  return tags.join('\n  ');
}

/**
 * Merges layout metadata with page metadata (layout → page inheritance).
 *
 * Page-level metadata takes precedence. Arrays are concatenated. Objects are
 * shallow-merged with page winning on conflicts. Fields not set on the page
 * fall through to the layout.
 */
export function mergeMetadata(parent: HeadMetadata, child: HeadMetadata): HeadMetadata {
  const result: HeadMetadata = { ...parent };

  // Scalar overrides — child wins if defined
  if (child.title !== undefined) result.title = child.title;
  if (child.description !== undefined) result.description = child.description;
  if (child.robots !== undefined) result.robots = child.robots;
  if (child.themeColor !== undefined) result.themeColor = child.themeColor;

  // Arrays — concatenate (parent first, child after)
  if (child.keywords) {
    result.keywords = [...(parent.keywords ?? []), ...child.keywords];
  }

  // Objects — shallow merge, child wins
  if (child.openGraph || parent.openGraph) {
    result.openGraph = { ...(parent.openGraph ?? {}), ...(child.openGraph ?? {}) };
    if (parent.openGraph?.images && child.openGraph?.images) {
      result.openGraph.images = [...parent.openGraph.images, ...child.openGraph.images];
    }
  }

  if (child.twitter || parent.twitter) {
    result.twitter = { ...(parent.twitter ?? {}), ...(child.twitter ?? {}) };
    if (parent.twitter?.images && child.twitter?.images) {
      result.twitter.images = [...parent.twitter.images, ...child.twitter.images];
    }
  }

  if (child.alternates || parent.alternates) {
    result.alternates = { ...(parent.alternates ?? {}), ...(child.alternates ?? {}) };
  }

  if (child.icons || parent.icons) {
    result.icons = { ...(parent.icons ?? {}), ...(child.icons ?? {}) };
  }

  // Structured data — concatenate
  if (child.structuredData || parent.structuredData) {
    const parentSd = parent.structuredData
      ? (Array.isArray(parent.structuredData) ? parent.structuredData : [parent.structuredData])
      : [];
    const childSd = child.structuredData
      ? (Array.isArray(child.structuredData) ? child.structuredData : [child.structuredData])
      : [];
    result.structuredData = [...parentSd, ...childSd];
  }

  // Other — merge, child wins
  if (child.other || parent.other) {
    result.other = { ...(parent.other ?? {}), ...(child.other ?? {}) };
  }

  return result;
}
