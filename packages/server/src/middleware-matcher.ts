/**
 * Middleware matcher — Path-based middleware activation.
 *
 * Supports `export const matcher = [...]` in middleware.ts to control
 * which routes trigger middleware execution. Patterns can be:
 * - Exact paths: '/about'
 * - Path patterns: '/blog/:slug'
 * - Glob patterns: '/api/*'
 * - Regex-like: '/((?!api|_next).*)'  (negative lookahead)
 */

export type MatcherPattern = string | { regex: string };

export interface MatcherConfig {
  /** Patterns to match — middleware runs only on matching paths */
  matcher: MatcherPattern[];
}

/**
 * Compiles a matcher pattern into a RegExp.
 *
 * Supported syntax:
 * - `/about` → exact match
 * - `/blog/:slug` → `/blog/[^/]+`
 * - `/api/*` → `/api/.*`
 * - `{ regex: '/((?!api).*)' }` → raw regex
 */
function compilePattern(pattern: MatcherPattern): RegExp {
  if (typeof pattern !== 'string') {
    try {
      return new RegExp(pattern.regex);
    } catch (err) {
      throw new Error(`Invalid middleware regex pattern "${pattern.regex}": ${(err as Error).message}`);
    }
  }

  // Check if it looks like a regex literal: /pattern/flags
  // Must start with / and end with /flags where flags are valid regex flags
  if (pattern.startsWith('/') && pattern.length > 1) {
    const body = pattern.slice(1);
    const lastSlash = body.lastIndexOf('/');
    if (lastSlash !== -1) {
      const flags = body.slice(lastSlash + 1);
      // Only treat as regex literal if flags are valid regex flags
      if (lastSlash > 0 && /^[gimsuyd]*$/.test(flags)) {
        const source = body.slice(0, lastSlash);
        try {
          return new RegExp(source, flags);
        } catch (err) {
          throw new Error(`Invalid middleware regex pattern "${pattern}": ${(err as Error).message}`);
        }
      }
    }
  }

  // Check for regex-specific syntax that indicates a raw regex (not a glob/path pattern)
  // Patterns like ((?!api).*) or (^/api) should be treated as raw regex
  if (/\(\?!|\(\?=|\(\?:|\(\?<=|\(\?<!|\[\^|\|/.test(pattern)) {
    try {
      return new RegExp(pattern);
    } catch (err) {
      throw new Error(`Invalid middleware regex pattern "${pattern}": ${(err as Error).message}`);
    }
  }

  // Convert path pattern to regex (glob-like syntax)
  let regex = pattern
    .replace(/:[a-zA-Z0-9_]+/g, '\x00PARAM\x00')  // :param → placeholder
    .replace(/\*/g, '\x00STAR\x00')                  // * → placeholder
    .replace(/\?/g, '\x00OPT\x00');                   // ? → placeholder

  // Escape special regex chars
  regex = regex.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace placeholders with actual regex patterns
  regex = regex.replace(/\x00PARAM\x00/g, '[^/]+')
    .replace(/\x00STAR\x00/g, '.*')
    .replace(/\x00OPT\x00/g, '[^/]?');

  return new RegExp(`^${regex}$`);
}

/**
 * Creates a matcher function from a matcher config.
 * Returns a function that tests whether a path should trigger middleware.
 */
export function createMatcher(matcher: MatcherPattern[]): (pathname: string) => boolean {
  const regexes = matcher.map(compilePattern);

  return function shouldRunMiddleware(pathname: string): boolean {
    return regexes.some((regex) => regex.test(pathname));
  };
}

/**
 * Parses the `matcher` export from a middleware module.
 * Returns null if no matcher is defined (middleware runs on all routes).
 */
export function parseMatcher(mod: Record<string, unknown>): ((pathname: string) => boolean) | null {
  if (!mod.matcher || !Array.isArray(mod.matcher)) return null;
  return createMatcher(mod.matcher as MatcherPattern[]);
}
