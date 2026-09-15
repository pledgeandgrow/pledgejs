import type { CSSProperties } from 'react';
import { escapeHtml } from 'pledgestack-shared';

/**
 * OpenGraph image generation for PledgeStack.
 *
 * Uses Satori to convert React-like JSX to SVG, then resvg to rasterize to PNG.
 * PledgePack's asset pipeline handles the actual rendering at build/dev time.
 *
 * Usage in an API route:
 * ```typescript
 * // app/api/og/route.ts
 * import { ImageResponse } from 'pledgestack-og';
 *
 * export async function GET(request: Request) {
 *   const { searchParams } = new URL(request.url);
 *   const title = searchParams.get('title') ?? 'PledgeStack';
 *
 *   return new ImageResponse(
 *     <div style={{ display: 'flex', fontSize: 60 }}>
 *       {title}
 *     </div>,
 *     { width: 1200, height: 630 }
 *   );
 * }
 * ```
 */

export interface ImageResponseOptions {
  /** Image width in pixels (default: 1200) */
  width?: number;
  /** Image height in pixels (default: 630) */
  height?: number;
  /** Cache TTL in seconds (default: 86400 — 1 day) */
  cacheTtl?: number;
  /** HTTP status code (default: 200) */
  status?: number;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
  /** Fonts to use (array of { name, data, weight, style }) */
  fonts?: OGFont[];
}

export interface OGFont {
  name: string;
  data: ArrayBuffer;
  weight?: number;
  style?: 'normal' | 'italic';
}

/**
 * Response class for OG image generation.
 *
 * IMPORTANT: until PledgePack's OG pipeline (Satori + resvg) intercepts and
 * renders it, the response BODY is the serialized JSX element tree — NOT PNG
 * bytes — even though Content-Type is `image/png`. Interception is keyed on the
 * `X-Pledge-OG: true` header (and `X-Pledge-OG-Rendered: false` below marks the
 * un-rendered state); the renderer replaces the body with the PNG and clears
 * that marker. If you consume an ImageResponse without that pipeline (e.g. a
 * unit test or a non-PledgePack runtime), read the serialized body via
 * `X-Pledge-OG-Rendered` rather than assuming PNG bytes.
 */
export class ImageResponse extends Response {
  constructor(
    element: unknown,
    options: ImageResponseOptions = {},
  ) {
    const width = options.width ?? 1200;
    const height = options.height ?? 630;
    const cacheTtl = options.cacheTtl ?? 86400;

    // Serialize the JSX element for PledgePack's OG renderer
    const serialized = JSON.stringify({
      element: serializeElement(element),
      width,
      height,
      fonts: options.fonts?.map((f) => ({
        name: f.name,
        weight: f.weight ?? 400,
        style: f.style ?? 'normal',
      })),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'image/png',
      // Prevent content-sniffing: the body is serialized JSON (not PNG) until
      // PledgePack's renderer swaps it. Without nosniff, browsers may
      // content-sniff the JSON as HTML, enabling XSS if user-controlled data
      // is in the element tree.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl * 7}`,
      'X-Pledge-OG': 'true',
      // Marks the body as un-rendered serialized JSX; the render pipeline sets
      // this to 'true' (and swaps in the PNG bytes) once it processes the response.
      'X-Pledge-OG-Rendered': 'false',
      'X-Pledge-OG-Width': String(width),
      'X-Pledge-OG-Height': String(height),
      ...options.headers,
    };

    // In production, PledgePack intercepts this and renders the PNG.
    // In dev, the body is the serialized JSX for the dev server to render.
    super(serialized, {
      status: options.status ?? 200,
      headers,
    });
  }
}

/**
 * Serialize a React-like element tree into a plain object for rendering.
 * Depth-capped to prevent stack overflow on deeply nested trees.
 */
const MAX_ELEMENT_DEPTH = 100;

function serializeElement(element: unknown, depth = 0): unknown {
  if (depth > MAX_ELEMENT_DEPTH) {
    return '[max depth exceeded]';
  }
  if (element === null || element === undefined || typeof element === 'string' || typeof element === 'number') {
    return element;
  }
  if (Array.isArray(element)) {
    return element.map((e) => serializeElement(e, depth + 1));
  }
  if (typeof element === 'object' && element !== null) {
    const el = element as { type?: unknown; props?: Record<string, unknown> };
    return {
      type: typeof el.type === 'string' ? el.type : 'div',
      props: serializeProps(el.props ?? {}, depth + 1),
    };
  }
  return String(element);
}

function serializeProps(props: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') {
      result.children = serializeElement(value, depth);
    } else if (typeof value === 'string' || typeof value === 'number') {
      result[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Helper to generate OG meta tags for a page.
 */
export function ogMetaTags(options: {
  title: string;
  description?: string;
  url?: string;
  image?: string;
  siteName?: string;
  twitterCard?: 'summary' | 'summary_large_image';
}): string[] {
  const tags: string[] = [
    `<meta property="og:title" content="${escapeHtml(options.title)}">`,
    `<meta property="og:type" content="website">`,
  ];

  if (options.description) {
    tags.push(`<meta property="og:description" content="${escapeHtml(options.description)}">`);
  }
  if (options.url) {
    tags.push(`<meta property="og:url" content="${escapeHtml(options.url)}">`);
  }
  if (options.image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(options.image)}">`);
    tags.push(`<meta property="og:image:width" content="1200">`);
    tags.push(`<meta property="og:image:height" content="630">`);
  }
  if (options.siteName) {
    tags.push(`<meta property="og:site_name" content="${escapeHtml(options.siteName)}">`);
  }

  // Twitter Card
  tags.push(`<meta name="twitter:card" content="${options.twitterCard ?? 'summary_large_image'}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(options.title)}">`);
  if (options.description) {
    tags.push(`<meta name="twitter:description" content="${escapeHtml(options.description)}">`);
  }
  if (options.image) {
    tags.push(`<meta name="twitter:image" content="${escapeHtml(options.image)}">`);
  }

  return tags;
}

export type { CSSProperties };
