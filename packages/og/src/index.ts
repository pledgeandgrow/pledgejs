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
 * This returns a Response with Content-Type: image/png.
 * The actual rendering is done by PledgePack's OG image pipeline (Satori + resvg).
 * In dev mode, the rendering is delegated to the /__pledge/og endpoint.
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
      'Cache-Control': `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl * 7}`,
      'X-Pledge-OG': 'true',
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
 */
function serializeElement(element: unknown): unknown {
  if (element === null || element === undefined || typeof element === 'string' || typeof element === 'number') {
    return element;
  }
  if (Array.isArray(element)) {
    return element.map(serializeElement);
  }
  if (typeof element === 'object' && element !== null) {
    const el = element as { type?: unknown; props?: Record<string, unknown> };
    return {
      type: typeof el.type === 'string' ? el.type : 'div',
      props: serializeProps(el.props ?? {}),
    };
  }
  return String(element);
}

function serializeProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') {
      result.children = serializeElement(value);
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
