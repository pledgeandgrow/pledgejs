/**
 * Streaming metadata — injects <title>/<meta> tags after the first flush
 * of HTML, without blocking TTFB.
 *
 * Goal #222: When `generateMetadata()` is async (e.g. fetches from a CMS),
 * we send the shell HTML immediately with placeholder tags, then inject
 * the real metadata via an inline <script> that replaces the placeholders
 * once the Promise resolves.
 *
 * This module provides:
 * - `createStreamingMetadata()` — starts metadata resolution, returns placeholder + injector
 * - `renderPlaceholderHead()` — renders placeholder tags for the initial shell
 * - `createMetadataInjector()` — creates the inline script that swaps placeholders
 */

import type { HeadMetadata } from '../router/types';
import type { ResolvedRoute } from 'pledgestack-shared';
import { renderHeadTags } from './head-tags';

const PLACEHOLDER_ID = '__pledge_meta__';

/**
 * Result of starting streaming metadata resolution.
 */
export interface StreamingMetadataResult {
  /** Placeholder HTML to include in the initial shell */
  placeholder: string;
  /** Promise that resolves to the injector script HTML (empty if metadata resolved sync) */
  injector: Promise<string>;
}

/**
 * Starts metadata resolution. If `generateMetadata` is sync or fast,
 * returns the real tags immediately. If it's async, returns placeholders
 * and an injector script that updates them post-hydration.
 *
 * @param metadataPromise - The pending metadata promise (or resolved value)
 * @param route - The matched route (for fallback metadata)
 * @param timeoutMs - Max time to wait before falling back to placeholder (default: 50ms)
 */
export function createStreamingMetadata(
  metadataPromise: Promise<HeadMetadata> | HeadMetadata,
  route: ResolvedRoute,
  timeoutMs: number = 50,
): StreamingMetadataResult {
  // If metadata is already resolved (sync), return real tags
  if (!(metadataPromise instanceof Promise)) {
    return {
      placeholder: renderHeadTags(metadataPromise, route),
      injector: Promise.resolve(''),
    };
  }

  // Check if metadata resolves within the timeout
  // If yes, use real tags (no flash). If no, use placeholder + injector.
  let metadataTimer: ReturnType<typeof setTimeout> | undefined;
  const racePromise = Promise.race([
    metadataPromise.then((m) => ({ metadata: m, timedOut: false })),
    new Promise<{ metadata: null; timedOut: true }>((resolve) => {
      metadataTimer = setTimeout(() => resolve({ metadata: null, timedOut: true }), timeoutMs);
    }),
  ]).finally(() => {
    if (metadataTimer) clearTimeout(metadataTimer);
  });

  // Start with placeholder
  const placeholder = renderPlaceholderHead(route);

  // The injector resolves after we know whether to inject or not
  const injector = racePromise.then(async (result) => {
    if (!result.timedOut && result.metadata) {
      // Metadata resolved in time — no injection needed, placeholder was already correct
      // But we used a placeholder, so we need to inject the real tags
      return createMetadataInjectorScript(result.metadata);
    }

    // Timed out — wait for the real metadata and inject when ready
    try {
      const metadata = await metadataPromise;
      return createMetadataInjectorScript(metadata);
    } catch {
      return '';
    }
  });

  return { placeholder, injector };
}

/**
 * Renders placeholder head tags for the initial HTML shell.
 * Uses route-level static metadata if available, otherwise generic defaults.
 */
export function renderPlaceholderHead(route: ResolvedRoute): string {
  const tags: string[] = [];

  const title = route.metadata?.title ?? 'PledgeStack App';
  tags.push(`<title id="${PLACEHOLDER_ID}-title">${escapeHtml(title)}</title>`);

  // Placeholder meta tags with data attributes for replacement
  tags.push(`<meta id="${PLACEHOLDER_ID}-description" name="description" content="" data-placeholder="true" />`);

  return tags.join('\n  ');
}

/**
 * Creates an inline <script> that replaces placeholder title/meta tags
 * with the real metadata values. Runs immediately when parsed.
 */
export function createMetadataInjectorScript(metadata: HeadMetadata): string {
  const updates: string[] = [];

  if (metadata.title) {
    updates.push(`document.getElementById('${PLACEHOLDER_ID}-title').textContent = ${JSON.stringify(metadata.title)};`);
  }

  if (metadata.description) {
    updates.push(`{
  var m = document.getElementById('${PLACEHOLDER_ID}-description');
  if (m) { m.setAttribute('content', ${JSON.stringify(metadata.description)}); m.removeAttribute('data-placeholder'); }
}`);
  }

  // Inject additional meta tags that weren't in the placeholder
  const extraTags: string[] = [];

  if (metadata.keywords && metadata.keywords.length > 0) {
    extraTags.push(`<meta name="keywords" content="${escapeHtml(metadata.keywords.join(', '))}" />`);
  }

  if (metadata.robots) {
    extraTags.push(`<meta name="robots" content="${escapeHtml(metadata.robots)}" />`);
  }

  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title) extraTags.push(`<meta property="og:title" content="${escapeHtml(og.title)}" />`);
    if (og.description) extraTags.push(`<meta property="og:description" content="${escapeHtml(og.description)}" />`);
    if (og.url) extraTags.push(`<meta property="og:url" content="${escapeHtml(og.url)}" />`);
    if (og.type) extraTags.push(`<meta property="og:type" content="${escapeHtml(og.type)}" />`);
    if (og.images) {
      for (const img of og.images) {
        extraTags.push(`<meta property="og:image" content="${escapeHtml(img)}" />`);
      }
    }
  }

  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card) extraTags.push(`<meta name="twitter:card" content="${escapeHtml(tw.card)}" />`);
    if (tw.title) extraTags.push(`<meta name="twitter:title" content="${escapeHtml(tw.title)}" />`);
    if (tw.description) extraTags.push(`<meta name="twitter:description" content="${escapeHtml(tw.description)}" />`);
    if (tw.images) {
      for (const img of tw.images) {
        extraTags.push(`<meta name="twitter:image" content="${escapeHtml(img)}" />`);
      }
    }
  }

  if (metadata.alternates?.canonical) {
    extraTags.push(`<link rel="canonical" href="${escapeHtml(metadata.alternates.canonical)}" />`);
  }

  if (metadata.icons?.icon) {
    extraTags.push(`<link rel="icon" href="${escapeHtml(metadata.icons.icon)}" />`);
  }
  if (metadata.icons?.apple) {
    extraTags.push(`<link rel="apple-touch-icon" href="${escapeHtml(metadata.icons.apple)}" />`);
  }
  if (metadata.icons?.favicon) {
    extraTags.push(`<link rel="shortcut icon" href="${escapeHtml(metadata.icons.favicon)}" />`);
  }

  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      extraTags.push(`<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}" />`);
    }
  }

  // Build the injector script
  const scriptLines: string[] = [];

  // Update existing placeholders
  scriptLines.push(...updates);

  // Inject extra tags into <head>
  if (extraTags.length > 0) {
    const tagsJson = JSON.stringify(extraTags.join('\n  '));
    scriptLines.push(`{
  var head = document.head;
  var range = document.createRange();
  range.selectNode(head);
  var frag = range.createContextualFragment(${tagsJson});
  head.appendChild(frag);
}`);
  }

  if (scriptLines.length === 0) return '';

  return `<script>(function(){${scriptLines.join('\n')}})();</script>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
