import { renderSvgToImage, isNativeOgRendererAvailable } from 'pledgestack-core';

/**
 * Server-side OG image rendering.
 *
 * `ImageResponse` (pledgestack-og) emits its body as a serialized element
 * tree with `X-Pledge-OG: true` / `X-Pledge-OG-Rendered: false`, expecting a
 * renderer to swap in real image bytes. This module is that renderer for the
 * Node server: SVG-shaped element trees are rasterized to PNG via the
 * rust-og-renderer addon (raw SVG fallback when the addon isn't compiled).
 * Layout-based (div/flex) trees are left untouched — PledgePack's
 * build-time pipeline (Satori) handles those.
 */

interface SerializedElement {
  type?: string;
  props?: Record<string, unknown>;
}

interface OgBody {
  element?: unknown;
  width?: number;
  height?: number;
}

/**
 * Renders an OG response if it needs server-side rasterization.
 * Returns the original response untouched otherwise.
 */
export async function maybeRenderOgResponse(response: Response): Promise<Response> {
  if (response.headers.get('x-pledge-og') !== 'true') return response;
  if (response.headers.get('x-pledge-og-rendered') !== 'false') return response;

  let body: OgBody;
  try {
    body = JSON.parse(await response.text()) as OgBody;
  } catch {
    return response; // Malformed body — leave for the build pipeline.
  }

  const svg = elementTreeToSvg(body.element);
  if (!svg) return response; // Not SVG-shaped — Satori/PledgePack handles it.

  const width = body.width ?? parseInt(response.headers.get('x-pledge-og-width') ?? '1200', 10);
  const height = body.height ?? parseInt(response.headers.get('x-pledge-og-height') ?? '630', 10);

  const { buffer, contentType } = renderSvgToImage(svg, width, height);

  const headers = new Headers(response.headers);
  headers.set('Content-Type', contentType);
  headers.set('X-Pledge-OG-Rendered', 'true');
  if (!isNativeOgRendererAvailable()) {
    // Honest marker: social platforms vary in SVG support; PNG requires the
    // native addon (or PledgePack's build-time pipeline).
    headers.set('X-Pledge-OG-Fallback', 'svg');
  }

  return new Response(new Uint8Array(buffer), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Converts a serialized element tree back to an SVG string.
 * Only handles SVG-shaped trees — the root must be an `svg` element and
 * children must use SVG tags. Returns null for anything else.
 */
function elementTreeToSvg(element: unknown): string | null {
  const root = asElement(element);
  if (!root || root.type !== 'svg') return null;

  const inner = renderChildren(root.props?.children, 0);
  if (inner === null) return null;

  const attrs = svgAttributes(root.props);
  return `<svg ${attrs}>${inner}</svg>`;
}

const MAX_SVG_DEPTH = 200;

function asElement(value: unknown): SerializedElement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as SerializedElement;
}

function renderChildren(children: unknown, depth: number): string | null {
  if (depth > MAX_SVG_DEPTH) return null;
  if (children === null || children === undefined) return '';
  if (typeof children === 'string' || typeof children === 'number') return escapeXml(String(children));
  if (Array.isArray(children)) {
    let out = '';
    for (const child of children) {
      const rendered = renderChildren(child, depth + 1);
      if (rendered === null) return null;
      out += rendered;
    }
    return out;
  }
  const el = asElement(children);
  if (!el) return null;
  if (typeof el.type !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(el.type)) return null;

  const attrs = svgAttributes(el.props);
  const inner = renderChildren(el.props?.children, depth + 1);
  if (inner === null) return null;
  return `<${el.type} ${attrs}>${inner}</${el.type}>`;
}

function svgAttributes(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const attrs: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue;
    if (typeof value === 'string' || typeof value === 'number') {
      const name = key === 'className' ? 'class' : key;
      if (!/^[a-zA-Z][a-zA-Z0-9-:]*$/.test(name)) continue;
      attrs.push(`${name}="${escapeXml(String(value))}"`);
    }
    // style objects and event handlers are skipped — string/attr SVG only.
  }
  return attrs.join(' ');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#quot;')
    .replace(/'/g, '&#apos;');
}
