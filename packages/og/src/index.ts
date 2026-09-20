import type { CSSProperties } from 'react';
import { escapeHtml } from 'pledgestack-shared';

/**
 * OpenGraph image generation for PledgeStack.
 *
 * Converts a JSX tree to SVG with a built-in flexbox layout (server side), then rasterizes to PNG.
 * Rasterization uses the native rust-og-renderer addon or the optional `sharp` package.
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
 * IMPORTANT: the constructor only SERIALIZES the element tree; the body it
 * carries is JSON, not PNG bytes, and is marked `X-Pledge-OG: true` /
 * `X-Pledge-OG-Rendered: false`. The PledgeStack server (`maybeRenderOgResponse`
 * in pledgestack-server) intercepts such responses, lays the tree out
 * (a flexbox subset: see the README for supported CSS), and rasterizes it to a
 * real PNG with the native rust-og-renderer addon or the optional `sharp`
 * package. If neither is installed the server answers 501 with an actionable
 * message instead of returning fake image bytes. If you consume an
 * ImageResponse outside the PledgeStack server (e.g. a unit test), check
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
  // React renders nothing for booleans (`{cond && <X/>}`) — String(false) used
  // to leak a literal "false" into the image.
  if (typeof element === 'boolean') return null;
  if (Array.isArray(element)) {
    return element.map((e) => serializeElement(e, depth + 1));
  }
  if (typeof element === 'object' && element !== null) {
    const el = element as { type?: unknown; props?: Record<string, unknown> };
    // Function components are expanded by calling them with their props (they must
    // be pure — hooks are not available here, exactly as with Satori). A component
    // that throws degrades to an empty box rather than failing the whole image.
    if (typeof el.type === 'function') {
      try {
        return serializeElement((el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}), depth + 1);
      } catch {
        return { type: 'div', props: {} };
      }
    }
    // Fragments (React.Fragment is a symbol) contribute only their children.
    if (typeof el.type === 'symbol') {
      return serializeElement(el.props?.children, depth + 1);
    }
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
