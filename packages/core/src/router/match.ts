import type { ResolvedRoute, RouteMatch } from 'pledgestack-shared';
import {
  DYNAMIC_SEGMENT_PATTERN,
  CATCH_ALL_PATTERN,
  OPTIONAL_CATCH_ALL_PATTERN,
  ROUTE_GROUP_PATTERN,
  PARALLEL_ROUTE_PATTERN,
  INTERCEPT_ROUTE_PATTERN,
  INTERCEPT_ROUTE_SEGMENT_PATTERN,
} from 'pledgestack-shared';

/**
 * Converts a filesystem path to a URL pattern.
 * e.g. "blog/[slug]/page.tsx" -> "/blog/:slug"
 *      "shop/(group)/product/page.tsx" -> "/shop/product"
 *      "docs/[...slug]/page.tsx" -> "/docs/*slug"
 *      "dashboard/@analytics/page.tsx" -> "/dashboard" (slot excluded from URL)
 *      "photos/(..)foo/page.tsx" -> intercepts one level up
 */
export function pathToPattern(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  const patternSegments: string[] = [];

  for (const segment of segments) {
    // Skip route groups (group) — no URL impact
    if (ROUTE_GROUP_PATTERN.test(segment)) continue;

    // Skip parallel route slots @slot — no URL impact, rendered in layout
    if (PARALLEL_ROUTE_PATTERN.test(segment)) continue;

    // Handle intercepting routes (..)folder, (...)folder, (....)folder
    const interceptMatch = segment.match(INTERCEPT_ROUTE_SEGMENT_PATTERN);
    if (interceptMatch) {
      // Intercepting routes don't add to the URL pattern directly;
      // they intercept another route. The target segment is the captured group.
      patternSegments.push(interceptMatch[1]);
      continue;
    }

    // Handle standalone intercepting route markers (..), (...), (....)
    if (INTERCEPT_ROUTE_PATTERN.test(segment)) continue;

    // Catch-all [...slug]
    const catchAll = segment.match(CATCH_ALL_PATTERN);
    if (catchAll) {
      patternSegments.push(`*${catchAll[1]}`);
      continue;
    }

    // Optional catch-all [[...slug]]
    const optionalCatchAll = segment.match(OPTIONAL_CATCH_ALL_PATTERN);
    if (optionalCatchAll) {
      patternSegments.push(`*${optionalCatchAll[1]}`);
      continue;
    }

    // Dynamic [slug]
    const dynamic = segment.match(DYNAMIC_SEGMENT_PATTERN);
    if (dynamic) {
      patternSegments.push(`:${dynamic[1]}`);
      continue;
    }

    // Static segment
    patternSegments.push(segment);
  }

  return '/' + patternSegments.join('/');
}

/**
 * Extracts intercept level from a segment.
 * (..) = 1, (...) = 2, (....) = 3
 */
export function getInterceptLevel(segment: string): number | null {
  const match = segment.match(INTERCEPT_ROUTE_PATTERN);
  if (!match) return null;
  const dots = segment.match(/\./g);
  return dots ? dots.length - 1 : null;
}

/**
 * Checks if a segment is a parallel route slot.
 */
export function isParallelSlot(segment: string): boolean {
  return PARALLEL_ROUTE_PATTERN.test(segment);
}

/**
 * Compiles a URL pattern into a RegExp and param names.
 */
export function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pattern.split('/').filter(Boolean);
  const regexParts: string[] = [];

  for (const segment of segments) {
    // Catch-all *slug — matches zero or more path segments
    if (segment.startsWith('*')) {
      const name = segment.slice(1);
      paramNames.push(name);
      // Match optional /rest — the leading / is part of the optional group
      // so this works whether or not there are additional segments
      regexParts.push('(?:/(.*))?');
      continue;
    }
    // Dynamic :slug
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      paramNames.push(name);
      regexParts.push('([^/]+)');
      continue;
    }
    // Static
    regexParts.push(segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  // Build regex: join parts with /, but catch-all parts already include optional /
  // We need to handle the case where a catch-all is the last segment
  let regexStr = '';
  for (let i = 0; i < regexParts.length; i++) {
    const part = regexParts[i];
    if (part.startsWith('(?:/')) {
      // Catch-all — don't add leading / (it's in the group)
      regexStr += part;
    } else {
      if (regexStr) regexStr += '/';
      regexStr += part;
    }
  }

  return {
    regex: new RegExp(`^/${regexStr}/?$`),
    paramNames,
  };
}

/**
 * Matches a pathname against a list of resolved routes.
 * Returns the best match (most specific) or null.
 */
export function matchRoute(pathname: string, routes: ResolvedRoute[]): RouteMatch | null {
  let bestMatch: RouteMatch | null = null;
  let bestScore = -1;

  for (const route of routes) {
    // Layouts are not independently routable — they wrap pages. Without this
    // filter a request to a directory that has only a layout.tsx could match
    // the layout as if it were a page and render broken output instead of 404.
    if (route.isLayout) continue;

    const { regex, paramNames } = compilePattern(route.pattern);
    const match = regex.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1] ?? '');
    });

    const score = specificityScore(route.pattern);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { pathname, params, route };
    }
  }

  return bestMatch;
}

/**
 * Specificity score for a route pattern. Each segment contributes by kind so a
 * more specific segment always outranks a less specific one at the same
 * position: static (3) > dynamic `:slug` (2) > catch-all `*rest` (1). This makes
 * `/blog/:slug` beat `/blog/*rest` deterministically, rather than tying on a
 * static-segment-only count and depending on file-scan order.
 */
function specificityScore(pattern: string): number {
  const segments = pattern.split('/').filter(Boolean);
  let score = 0;
  for (const seg of segments) {
    if (seg.startsWith('*')) score += 1;
    else if (seg.startsWith(':')) score += 2;
    else score += 3;
  }
  return score;
}
