/**
 * #238 — Rust HTML template engine.
 *
 * Native HTML template rendering in Rust for layout shells, <head> tag
 * generation, script/link injection, replacing renderToPipeableStream for
 * static parts of the page.
 *
 * The Rust HTML engine:
 * - Renders layout shells (html, head, body, div#root) natively
 * - Generates <head> tags from metadata (title, meta, link, script)
 * - Injects CSS/JS resources with proper ordering
 * - Handles viewport tags, OpenGraph, Twitter cards, structured data
 * - Escapes HTML entities to prevent XSS
 *
 * This module provides the JS interface to the Rust template engine via NAPI,
 * with a pure-JS fallback for environments without the native addon.
 */

import type { ResolvedRoute, PledgeConfig, Viewport } from 'pledgestack-shared';
import { MANIFEST_SCRIPT_ID, type PledgeManifest } from 'pledgestack-shared';
import type { HeadMetadata } from '../router/types';
import { renderHeadTags, renderViewportTags, escapeHtmlShared } from './head-tags';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust HTML template engine is available */
let rustHtmlAvailable: boolean | null = null;
let rustHtmlAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust HTML template engine.
 */
export function isRustHtmlEngineAvailable(): boolean {
  if (rustHtmlAvailable !== null) return rustHtmlAvailable;
  try {
    const addon = require('../../native/rust-html.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.renderHtmlShell === 'function' && typeof addon.renderHead === 'function') {
      rustHtmlAddon = addon;
      rustHtmlAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustHtmlAvailable = false;
  return false;
}

export interface HtmlShellOptions {
  /** The inner HTML content (page body) */
  content: string;
  /** Page metadata */
  metadata?: HeadMetadata;
  /** Viewport configuration */
  viewport?: Viewport;
  /** Route being rendered */
  route: ResolvedRoute;
  /** PledgeStack manifest */
  manifest?: PledgeManifest;
  /** Additional head tags (from head.tsx component) */
  customHeadTags?: string;
  /** CSS file paths to inject */
  cssFiles?: string[];
  /** JS module paths to inject */
  jsModules?: string[];
  /** Whether to include the RSC client script */
  includeRSCClient?: boolean;
  /** Language attribute for <html> */
  lang?: string;
  /** Whether to include Suspense boundary data */
  suspenseBoundaryData?: string;
  /** Preload hints for critical resources */
  preloadHints?: PreloadHint[];
}

export interface PreloadHint {
  /** Resource URL */
  href: string;
  /** Resource type: style, script, font, image */
  as: 'style' | 'script' | 'font' | 'image';
  /** Optional crossOrigin setting */
  crossOrigin?: 'anonymous' | 'use-credentials';
  /** Optional integrity hash */
  integrity?: string;
}

export interface HtmlRenderResult {
  /** The complete HTML document */
  html: string;
  /** Whether the Rust engine was used */
  usedRustEngine: boolean;
  /** Head section HTML */
  head: string;
  /** Body section HTML */
  body: string;
  /** Render time in microseconds */
  renderTimeUs?: number;
}

/**
 * Renders a complete HTML document shell using the Rust template engine.
 *
 * The Rust engine handles:
 * - DOCTYPE and html tag generation
 * - <head> with all meta tags, title, viewport, CSS preloads
 * - <body> with content injection and script loading
 * - HTML entity escaping for all dynamic content
 */
export function renderHtmlShell(options: HtmlShellOptions): HtmlRenderResult {
  if (isRustHtmlEngineAvailable() && rustHtmlAddon) {
    try {
      const result = rustHtmlAddon.renderHtmlShell(options) as HtmlRenderResult;
      if (result) return result;
    } catch (err) {
      console.warn('[pledgestack] Rust HTML engine failed, falling back to JS:', err);
    }
  }

  return renderHtmlShellJS(options);
}

/**
 * Renders just the <head> section using the Rust template engine.
 */
export function renderHead(
  metadata: HeadMetadata,
  viewport?: Viewport,
  customTags?: string,
  cssFiles?: string[],
  preloadHints?: PreloadHint[],
): { html: string; usedRustEngine: boolean } {
  if (isRustHtmlEngineAvailable() && rustHtmlAddon) {
    try {
      const html = rustHtmlAddon.renderHead(metadata, viewport, customTags, cssFiles, preloadHints) as string;
      if (html) return { html, usedRustEngine: true };
    } catch {
      // Fall through
    }
  }

  return { html: renderHeadJS(metadata, viewport, customTags, cssFiles, preloadHints), usedRustEngine: false };
}

/**
 * Escapes HTML entities in a string using the Rust engine.
 * Falls back to JS implementation.
 */
export function escapeHtml(input: string): string {
  if (isRustHtmlEngineAvailable() && rustHtmlAddon && typeof rustHtmlAddon.escapeHtml === 'function') {
    try {
      return rustHtmlAddon.escapeHtml(input) as string;
    } catch {
      // Fall through
    }
  }

  return escapeHtmlJS(input);
}

/**
 * JS fallback: Renders a complete HTML document shell.
 */
function renderHtmlShellJS(options: HtmlShellOptions): HtmlRenderResult {
  const startTime = process.hrtime.bigint();

  const lang = options.lang ?? 'en';
  const metadata = options.metadata ?? {};
  const viewport = options.viewport;
  const cssFiles = options.cssFiles ?? ['/__pledge__/client.css'];
  const jsModules = options.jsModules ?? ['/__pledge__/client.js'];
  const manifest = options.manifest ?? { pledges: [] };
  const preloadHints = options.preloadHints ?? [];

  const headHtml = renderHeadJS(metadata, viewport, options.customHeadTags, cssFiles, preloadHints);

  const scriptTags = jsModules.map(src => `  <script type="module" src="${escapeHtmlJS(src)}"></script>`).join('\n');

  const manifestTag = `  <script id="${MANIFEST_SCRIPT_ID}" type="application/json">${JSON.stringify(manifest)}</script>`;

  const suspenseTag = options.suspenseBoundaryData
    ? `\n  <script id="__pledge_suspense_boundaries__" type="application/json">${options.suspenseBoundaryData}</script>`
    : '';

  const rscClientTag = options.includeRSCClient
    ? '\n  <script type="module" src="/__pledge__/rsc-client.js"></script>'
    : '';

  const html = `<!DOCTYPE html>
<html lang="${escapeHtmlJS(lang)}">
<head>
${headHtml}
</head>
<body>
  <div id="__pledge_root__">${options.content}</div>
${manifestTag}${suspenseTag}
${scriptTags}${rscClientTag}
</body>
</html>`;

  const endTime = process.hrtime.bigint();
  const renderTimeUs = Number(endTime - startTime) / 1000;

  return {
    html,
    usedRustEngine: false,
    head: headHtml,
    body: options.content,
    renderTimeUs,
  };
}

/**
 * JS fallback: Renders the <head> section from metadata.
 * Uses shared renderHeadTags for metadata tags, adds charset, viewport, preload hints, CSS, and custom tags.
 */
function renderHeadJS(
  metadata: HeadMetadata,
  viewport?: Viewport,
  customTags?: string,
  cssFiles?: string[],
  preloadHints?: PreloadHint[],
): string {
  const tags: string[] = [];

  // Charset (always first)
  tags.push('  <meta charset="UTF-8" />');

  // Viewport
  if (viewport) {
    tags.push(`  ${renderViewportTags(viewport)}`);
  } else {
    tags.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0" />');
  }

  // Metadata tags (title, description, OG, Twitter, canonical, icons, JSON-LD, etc.)
  const metaTags = renderHeadTags(metadata);
  tags.push(metaTags);

  // Preload hints
  if (preloadHints) {
    for (const hint of preloadHints) {
      const attrs = [`rel="preload"`, `href="${escapeHtmlJS(hint.href)}"`, `as="${hint.as}"`];
      if (hint.crossOrigin) attrs.push(`crossorigin="${hint.crossOrigin}"`);
      if (hint.integrity) attrs.push(`integrity="${escapeHtmlJS(hint.integrity)}"`);
      tags.push(`  <link ${attrs.join(' ')} />`);
    }
  }

  // CSS files
  if (cssFiles) {
    for (const css of cssFiles) {
      tags.push(`  <link rel="stylesheet" href="${escapeHtmlJS(css)}" />`);
    }
  }

  // Custom head tags from head.tsx
  if (customTags) {
    tags.push(customTags);
  }

  return tags.join('\n');
}

/**
 * JS fallback: Escapes HTML entities.
 */
function escapeHtmlJS(input: string): string {
  return escapeHtmlShared(input);
}

/**
 * Renders a minimal HTML shell for error pages.
 */
export function renderErrorShell(
  statusCode: number,
  title: string,
  message: string,
  config?: PledgeConfig,
): string {
  const options: HtmlShellOptions = {
    content: `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,sans-serif;"><h1 style="font-size:2rem;margin-bottom:0.5rem;">${escapeHtmlJS(title)}</h1><p style="color:#666;">${escapeHtmlJS(message)}</p><p style="color:#999;font-size:0.875rem;">Status: ${statusCode}</p></div>`,
    metadata: { title: `${title} — ${statusCode}` },
    route: {
      filePath: '',
      pattern: '/error',
      mode: 'ssr',
      runtime: 'node',
      isLayout: false,
      isErrorBoundary: false,
      isLoading: false,
      isNotFound: false,
    },
    cssFiles: [],
    jsModules: [],
  };
  void config;
  return renderHtmlShell(options).html;
}

/**
 * Renders a 404 not-found shell.
 */
export function renderNotFoundShell(config?: PledgeConfig): string {
  return renderErrorShell(404, 'Not Found', 'The page you are looking for does not exist.', config);
}
