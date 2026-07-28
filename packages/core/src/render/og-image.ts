/**
 * OpenGraph image rendering utilities.
 *
 * Renders a React component to an SVG image for OG/Twitter card usage.
 * The component's default export receives { params } as props and should
 * return a React element that renders visual content (divs, text, etc.).
 * The rendered HTML is wrapped in an SVG envelope with a foreignObject.
 */

import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import type { PageModule } from '../router/types';

/** OG image dimensions (Next.js default) */
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

/**
 * Renders an OG image component to an SVG string.
 *
 * @param module The page module containing the OG image component
 * @param params Route params to pass as props
 * @returns SVG string
 */
export function renderOgImage(module: PageModule, params: Record<string, string> = {}): string {
  const html = renderToString(createElement(module.default, { params }));
  return wrapInSvg(html);
}

/**
 * Wraps rendered HTML content in an SVG envelope for OG image serving.
 */
function wrapInSvg(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;">
      ${content}
    </div>
  </foreignObject>
</svg>`;
}
