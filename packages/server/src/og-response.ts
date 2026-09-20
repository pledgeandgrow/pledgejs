import { renderSvgToImage, isNativeOgRendererAvailable } from 'pledgestack-core';
import { layoutTreeToSvg, OgLayoutError, esc as escapeXml } from './og-layout';

/**
 * Server-side OG image rendering.
 *
 * `ImageResponse` (pledgestack-og) emits its body as a serialized element
 * tree with `X-Pledge-OG: true` / `X-Pledge-OG-Rendered: false`. This module
 * is the renderer that swaps in real PNG bytes:
 *
 *  1. SVG-rooted trees are converted to SVG directly; div/span/img trees are
 *     laid out with a small flexbox engine (see og-layout.ts) and converted
 *     to SVG.
 *  2. The SVG is rasterized to PNG with the native rust-og-renderer addon
 *     when compiled, otherwise with the optional `sharp` package.
 *  3. If neither rasterizer is available the response is a clear `501` with an
 *     actionable message — the body is never serialized JSX labelled image/png.
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

export interface OgRasterizers {
  /** Override the sharp loader (tests). Resolve to a module exposing the sharp default export, or null. */
  loadSharp?: () => Promise<unknown | null>;
  /** Force the native addon on/off (tests). */
  native?: boolean;
}

const MAX_DIMENSION = 4096;

function clampDimension(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_DIMENSION);
}

function ogError(status: number, message: string, base: Response): Response {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Pledge-OG-Error', 'true');
  void base;
  return new Response(JSON.stringify({ error: 'og_render_failed', message }), { status, headers });
}

async function defaultLoadSharp(): Promise<unknown | null> {
  try {
    const name = 'sharp';
    const mod = await import(name);
    return (mod as { default?: unknown }).default ?? mod;
  } catch {
    return null;
  }
}

/** Rasterizes an SVG string to PNG bytes, or returns null when no rasterizer is available. */
export async function rasterizeSvgToPng(
  svg: string,
  width: number,
  height: number,
  deps: OgRasterizers = {},
): Promise<Buffer | null> {
  const useNative = deps.native ?? isNativeOgRendererAvailable();
  if (useNative) {
    const { buffer, contentType } = renderSvgToImage(svg, width, height);
    if (contentType === 'image/png') return buffer;
  }
  const sharp = await (deps.loadSharp ?? defaultLoadSharp)();
  if (typeof sharp === 'function') {
    const png = await (sharp as (input: Buffer, opts?: object) => { png: () => { toBuffer: () => Promise<Buffer> } })(
      Buffer.from(svg, 'utf-8'),
      { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION },
    ).png().toBuffer();
    return png;
  }
  return null;
}

/**
 * Renders an OG response if it needs server-side rasterization.
 * Returns the original response untouched if it is not an un-rendered
 * `ImageResponse`.
 */
export async function maybeRenderOgResponse(response: Response, deps: OgRasterizers = {}): Promise<Response> {
  if (response.headers.get('x-pledge-og') !== 'true') return response;
  if (response.headers.get('x-pledge-og-rendered') !== 'false') return response;

  let body: OgBody;
  try {
    body = JSON.parse(await response.text()) as OgBody;
  } catch {
    return ogError(500, 'ImageResponse body was not a serialized element tree.', response);
  }

  const width = clampDimension(body.width ?? response.headers.get('x-pledge-og-width'), 1200);
  const height = clampDimension(body.height ?? response.headers.get('x-pledge-og-height'), 630);

  let svg: string | null;
  try {
    svg = elementTreeToSvg(body.element) ?? layoutTreeToSvg(body.element, width, height);
  } catch (err) {
    const msg = err instanceof OgLayoutError ? err.message : 'Unsupported element tree.';
    return ogError(422, `Cannot render ImageResponse: ${msg}`, response);
  }

  let png: Buffer | null;
  try {
    png = await rasterizeSvgToPng(svg, width, height, deps);
  } catch (err) {
    return ogError(500, `SVG rasterization failed: ${(err as Error).message}`, response);
  }
  if (!png) {
    return ogError(
      501,
      'ImageResponse cannot be rendered to PNG: no rasterizer is available. ' +
        'Install the optional `sharp` package (npm install sharp) or compile the native rust-og-renderer addon.',
      response,
    );
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'image/png');
  headers.set('X-Pledge-OG-Rendered', 'true');
  headers.delete('content-length');

  return new Response(new Uint8Array(png), {
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
  const ns = /(^|\s)xmlns=/.test(attrs) ? '' : 'xmlns="http://www.w3.org/2000/svg" ';
  return `<svg ${ns}${attrs}>${inner}</svg>`;
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
  // Active / external-resource elements are never emitted.
  if (/^(script|foreignObject|style|use|iframe|animate|set)$/i.test(el.type)) return null;

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
      if (/^on/i.test(name)) continue; // event handlers
      // References may only point at same-document ids or inline data images.
      if (/href$/i.test(name) && !/^(#|data:image\/(png|jpe?g|gif|webp);)/i.test(String(value))) continue;
      attrs.push(`${name}="${escapeXml(String(value))}"`);
    }
    // style objects and event handlers are skipped — string/attr SVG only.
  }
  return attrs.join(' ');
}
