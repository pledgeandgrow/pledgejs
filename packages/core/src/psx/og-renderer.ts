/**
 * Native OG image renderer — SVG to PNG/WebP rasterization.
 *
 * Uses the rust-og-renderer NAPI addon (resvg + tiny-skia) to rasterize
 * SVG images to real PNG/WebP at native speed. This produces images that
 * all social platforms (Twitter, Facebook, LinkedIn, Slack) can render.
 *
 * When the native addon is not compiled, falls back to serving raw SVG
 * (which works on some but not all platforms).
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nativeAddon: {
  renderSvgToPng: (svg: string, width?: number, height?: number) => Buffer;
  renderSvgToWebp: (svg: string, width?: number, height?: number, quality?: number) => Buffer;
  isNativeOgRendererAvailable: () => boolean;
} | null = null;

let loadAttempted = false;

/**
 * Attempts to load the native rust-og-renderer addon.
 */
function loadNative(): typeof nativeAddon {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../../native/rust-og-renderer.node') as NonNullable<typeof nativeAddon>;
    if (typeof addon.renderSvgToPng === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

/**
 * Whether the native SVG-to-PNG renderer is available.
 */
export function isNativeOgRendererAvailable(): boolean {
  return loadNative() !== null;
}

/**
 * Renders an SVG string to a PNG buffer.
 *
 * Uses the native resvg addon when available. Falls back to returning
 * the raw SVG as a Buffer (served as image/svg+xml) when not.
 *
 * @param svg SVG string to rasterize
 * @param width Target width (default: 1200)
 * @param height Target height (default: 630)
 * @returns { buffer: Buffer; contentType: string }
 */
export function renderSvgToImage(
  svg: string,
  width?: number,
  height?: number,
): { buffer: Buffer; contentType: string } {
  const addon = loadNative();
  if (addon) {
    const png = addon.renderSvgToPng(svg, width, height);
    return { buffer: png, contentType: 'image/png' };
  }
  // Fallback: return raw SVG
  return { buffer: Buffer.from(svg, 'utf-8'), contentType: 'image/svg+xml' };
}

/**
 * Renders an SVG string to a WebP buffer (smaller file size).
 *
 * Only available with the native addon. Falls back to PNG (or SVG
 * if native is not available).
 *
 * @param svg SVG string to rasterize
 * @param width Target width (default: 1200)
 * @param height Target height (default: 630)
 * @param quality WebP quality 1-100 (default: 85)
 * @returns { buffer: Buffer; contentType: string }
 */
export function renderSvgToWebp(
  svg: string,
  width?: number,
  height?: number,
  quality?: number,
): { buffer: Buffer; contentType: string } {
  const addon = loadNative();
  if (addon && typeof addon.renderSvgToWebp === 'function') {
    const webp = addon.renderSvgToWebp(svg, width, height, quality);
    return { buffer: webp, contentType: 'image/webp' };
  }
  // Fallback to PNG path (which itself falls back to SVG)
  return renderSvgToImage(svg, width, height);
}
