/**
 * OpenGraph image generation route handler.
 *
 * Intercepts requests for /opengraph-image or /<path>/opengraph-image
 * (and /twitter-image or /<path>/twitter-image).
 *
 * If the matched route has an opengraph-image.tsx (or twitter-image.tsx)
 * file, the component is rendered to an SVG image and returned with the
 * appropriate content-type.
 *
 * The component's default export receives { params } as props and should
 * return a React element that renders an SVG-like image. The rendered HTML
 * is wrapped in an SVG envelope.
 */

import type { PledgeConfig, PledgeResponse, ResolvedRoute } from 'pledgestack-shared';
import type { PageModule } from 'pledgestack-core';
import { renderOgImage, compilePattern } from 'pledgestack-core';
import { renderSvgToImage, isNativeOgRendererAvailable } from 'pledgestack-core';
import type { ModuleLoader } from './module-loader';

/**
 * Attempts to serve an OG image or Twitter image for a request.
 * Returns a PledgeResponse if the request was handled, or null if not.
 */
export async function tryServeOgImage(
  pathname: string,
  _config: PledgeConfig,
  routes: ResolvedRoute[],
  moduleLoader: ModuleLoader,
): Promise<PledgeResponse | null> {
  // Check if the pathname ends with /opengraph-image or /twitter-image
  const isOgImage = pathname === '/opengraph-image' || pathname.endsWith('/opengraph-image');
  const isTwImage = pathname === '/twitter-image' || pathname.endsWith('/twitter-image');

  if (!isOgImage && !isTwImage) return null;

  // Derive the parent route path by stripping the image suffix
  const suffix = isOgImage ? '/opengraph-image' : '/twitter-image';
  const parentPath = pathname.slice(0, -suffix.length) || '/';

  // Match the parent path against route patterns, honoring dynamic segments.
  // Exact string equality (the previous approach) never matched a dynamic
  // route like `/blog/:slug`, so OG images for dynamic pages always 404'd.
  let route: ResolvedRoute | undefined;
  let params: Record<string, string> = {};
  for (const r of routes) {
    if (isOgImage ? !r.opengraphImageFilePath : !r.twitterImageFilePath) continue;
    const { regex, paramNames } = compilePattern(r.pattern);
    const m = regex.exec(parentPath);
    if (m) {
      route = r;
      params = Object.fromEntries(paramNames.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')]));
      break;
    }
  }
  if (!route) return null;

  const filePath = isOgImage ? route.opengraphImageFilePath : route.twitterImageFilePath;
  if (!filePath) return null;

  try {
    const mod = await moduleLoader.load(filePath) as PageModule | undefined;
    if (!mod || typeof mod.default !== 'function') return null;

    const svg = renderOgImage(mod, params);

    // Use native SVG-to-PNG renderer when available (resvg + tiny-skia)
    // Falls back to raw SVG when native addon is not compiled
    const { buffer, contentType } = renderSvgToImage(svg);
    const isNative = isNativeOgRendererAvailable();

    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'X-PledgeStack-OG-Renderer': isNative ? 'native-png' : 'fallback-svg',
      },
      body: buffer.toString('base64'),
      isBase64: true,
    };
  } catch (err) {
    console.error('[pledgestack] OG image render error:', err);
    return null;
  }
}
