import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PledgeConfig, PledgeResponse, MiddlewareResult, ResolvedRoute, PledgeRequest, PluginRenderContext, BundlerAdapter } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, createRouter, renderSSR, renderNotFound } from 'pledgestack-core';
import { renderRSCToHTML } from 'pledgestack-core';
import { renderRSCStream } from 'pledgestack-core';
import { renderSSRStream } from 'pledgestack-core';
import { initRenderer } from 'pledgestack-core';
import type { PageModule, LayoutModule, RouteHandlerModule, MiddlewareModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, TemplateModule } from 'pledgestack-core';
import type { RouteTree } from 'pledgestack-core';
import { createModuleLoader, type ModuleLoader } from './module-loader';
import { setRequestContext, clearRequestContext } from './server-utils';
import { createMatcher } from './middleware-matcher';
import { getServerAction } from './actions';
import { ACTION_ENDPOINT } from 'pledgestack-shared';
import { PluginRunner } from 'pledgestack-shared';
import { tryServeSeoRoute } from './seo-routes';
import { tryServeOgImage } from './og-image';
import { generateETag, isETagMatch } from './etag';
import { validateRedirect } from 'pledgestack-auth';
import { corsMiddleware, DEFAULT_CORS_CONFIG, type CorsConfig } from './cors';

type AnyModule = PageModule | LayoutModule | RouteHandlerModule | MiddlewareModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule;

interface HandlerContext {
  config: PledgeConfig;
  routes: ReturnType<typeof resolveRoutes>;
  router: ReturnType<typeof createRouter>;
  tree: RouteTree | null;
  modules: Map<string, AnyModule>;
  moduleLoader: ModuleLoader;
  middleware: MiddlewareModule | null;
  pluginRunner: PluginRunner;
}

export interface RequestHandlerOptions {
  config: PledgeConfig;
  isDev?: boolean;
  /** Bundler dev server port for module transforms (dev mode only) */
  pledgepackPort?: number;
  /** Optional bundler adapter — if provided, used for module transforms instead of legacy transformFile */
  adapter?: BundlerAdapter;
}

/**
 * Collects all file paths that need to be loaded for a set of routes,
 * including convention files (loading, error, not-found, head).
 */
function collectAllFilePaths(routes: ResolvedRoute[]): string[] {
  const paths = new Set<string>();
  for (const route of routes) {
    paths.add(route.filePath);
    if (route.loadingFilePath) paths.add(route.loadingFilePath);
    if (route.errorFilePath) paths.add(route.errorFilePath);
    if (route.notFoundFilePath) paths.add(route.notFoundFilePath);
    if (route.headFilePath) paths.add(route.headFilePath);
    if (route.templateFilePath) paths.add(route.templateFilePath);
    if (route.globalErrorFilePath) paths.add(route.globalErrorFilePath);
    if (route.opengraphImageFilePath) paths.add(route.opengraphImageFilePath);
    if (route.twitterImageFilePath) paths.add(route.twitterImageFilePath);
  }
  return [...paths];
}

/**
 * Creates a request handler that routes requests to the appropriate
 * page, API route, or static asset. Integrates module loading,
 * middleware execution, and RSC rendering.
 */
export function createRequestHandler(options: RequestHandlerOptions) {
  const { config, isDev = false, pledgepackPort, adapter } = options;
  let localCtx: HandlerContext | null = null;

  /** Default request timeout in ms (30s, configurable via env) */
  const REQUEST_TIMEOUT_MS = parseInt(process.env.PLEDGE_REQUEST_TIMEOUT ?? '30000', 10);

  /**
   * Wraps a promise with a timeout. Returns the promise result or a 504 timeout response.
   */
  function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  class TimeoutError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TimeoutError';
    }
  }

  async function ensureContext() {
    if (localCtx) return localCtx;

    // Initialize the renderer adapter for the configured framework
    await initRenderer(config);

    const moduleLoader = createModuleLoader(config, isDev, pledgepackPort, adapter);
    const files = await scanAppDir(join(config.rootDir, config.appDir));
    const routes = resolveRoutes(files, config);
    const router = createRouter(routes, config);

    // Load all modules including convention files
    const allPaths = collectAllFilePaths(routes);
    const modules = new Map<string, AnyModule>();
    await Promise.all(
      allPaths.map(async (filePath) => {
        try {
          const mod = await moduleLoader.load(filePath);
          modules.set(filePath, mod as AnyModule);
        } catch (err) {
          console.error(`[pledgestack] Failed to load module ${filePath}:`, err);
        }
      }),
    );

    const middleware = await moduleLoader.loadMiddleware();
    const pluginRunner = new PluginRunner(config.plugins ?? []);

    localCtx = {
      config,
      routes,
      router,
      tree: router.tree,
      modules,
      moduleLoader,
      middleware,
      pluginRunner,
    };
    return localCtx;
  }

  async function innerHandler(req: { url: URL; method: string; headers: Record<string, string>; body?: string | Buffer | null }): Promise<PledgeResponse> {
    const context = await ensureContext();
    const { router, middleware } = context;

    // Build PledgeRequest for server utilities (cookies, headers, params)
    const pledgeReq: PledgeRequest = {
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
      params: {},
      query: Object.fromEntries(req.url.searchParams.entries()),
      cookies: parseCookies(req.headers),
    };

    // Set request context so server utilities can access it
    setRequestContext(pledgeReq);

    // Generate request ID for tracing
    const requestId = req.headers['x-request-id'] ?? randomUUID();
    pledgeReq.headers['x-request-id'] = requestId;

    // Start tracing span for this request
    let tracingSpan: { end: (error?: Error) => void } | null = null;
    try {
      const { startSpan, isTracingEnabled } = await import('./tracing');
      if (isTracingEnabled()) {
        const span = startSpan(`HTTP ${req.method} ${req.url.pathname}`, {
          'http.method': req.method,
          'http.url': req.url.toString(),
          'http.request_id': requestId,
        });
        tracingSpan = span;
      }
    } catch {
      // Tracing module not available
    }

    try {
      // Handle server action endpoint
      if (req.url.pathname === ACTION_ENDPOINT && req.method === 'POST') {
        const actionId = req.headers['x-pledge-action-id'];
        if (!actionId) {
          return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing action ID' }) };
        }

        const actionFn = getServerAction(actionId);
        if (!actionFn) {
          return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Action "${actionId}" not found` }) };
        }

        // Parse body
        const rawBody = typeof req.body === 'string' ? req.body : '';
        let args: unknown[];
        try {
          const parsed = JSON.parse(rawBody || '{}') as { args?: unknown[] };
          args = Array.isArray(parsed.args) ? parsed.args : [];
        } catch {
          return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Invalid JSON body' }) };
        }

        try {
          const result = await actionFn(...args);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result }),
          };
        } catch (err) {
          return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: err instanceof Error ? err.message : 'Action failed' }),
          };
        }
      }

      // Execute middleware first (respecting matcher config if present)
      if (middleware) {
        const shouldRun = middleware.matcher
          ? createMatcher(middleware.matcher)(req.url.pathname)
          : true;
        if (shouldRun) {
          const mwRequest = new Request(req.url, { method: req.method, headers: req.headers as HeadersInit });
          const mwResult: MiddlewareResult = await middleware.default(mwRequest);

          if (mwResult.redirect) {
            // Validate redirect destination to prevent open-redirect attacks
            const safeDestination = validateRedirect(mwResult.redirect.destination, { origin: req.url.origin });
            if (!safeDestination) {
              return { status: 400, headers: {}, body: 'Invalid redirect' };
            }
            return {
              status: mwResult.redirect.permanent ? 308 : 307,
              headers: { Location: safeDestination },
              body: null,
            };
          }

          if (mwResult.rewrite) {
            req.url = new URL(mwResult.rewrite, req.url.origin);
          }

          if (mwResult.next === false) {
            return {
              status: 200,
              headers: mwResult.headers ?? {},
              body: '',
            };
          }

          // Merge middleware headers into the request
          if (mwResult.headers) {
            req.headers = { ...req.headers, ...mwResult.headers };
            pledgeReq.headers = { ...pledgeReq.headers, ...mwResult.headers };
            setRequestContext(pledgeReq);
          }
        }
      }

      // Auto-apply bot detection (if enabled in config)
      if (config.botDetection) {
        const { detectBot } = await import('./safety-net');
        const botResult = detectBot({
          headers: req.headers,
          method: req.method,
          path: req.url.pathname,
        });
        if (botResult.isBot && botResult.shouldChallenge) {
          return {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Bot detected', challenge: true }),
          };
        }
      }

      // Auto-apply rate limiting (if enabled in config)
      if (config.rateLimit) {
        const { checkRateLimit } = await import('pledgestack-core');
        const rateLimitConfig = typeof config.rateLimit === 'object' ? config.rateLimit : {};
        const maxTokens = rateLimitConfig.maxTokens ?? 100;
        const refillRate = rateLimitConfig.refillRate ?? 10;
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? pledgeReq.headers['x-request-id'] ?? 'unknown';
        const rateResult = checkRateLimit(ip, maxTokens, refillRate);
        if (!rateResult.allowed) {
          return {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(Math.ceil(rateResult.retryAfterMs / 1000)),
            },
            body: JSON.stringify({ error: 'Too Many Requests', retryAfterMs: rateResult.retryAfterMs }),
          };
        }
      }

      // Auto-apply brute force protection on auth endpoints (if enabled in config)
      if (config.bruteForceProtection && (req.url.pathname.includes('/login') || req.url.pathname.includes('/auth'))) {
        const { checkBruteForce } = await import('./safety-net');
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? pledgeReq.headers['x-request-id'] ?? 'unknown';
        const bfResult = checkBruteForce(ip);
        if (bfResult.lockedOut) {
          return {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(Math.ceil((bfResult.lockoutEndsAt ?? Date.now()) - Date.now()) / 1000),
            },
            body: JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
          };
        }
      }

      // CSRF protection for state-changing requests (not server actions, which have their own CSRF)
      const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
      const isServerAction = req.url.pathname === ACTION_ENDPOINT;
      if (isStateChanging && !isServerAction && config.securityHeaders !== false) {
        const { validateOrigin, isSameSiteRequest } = await import('pledgestack-auth');
        const origin = req.headers['origin'] ?? req.headers['Origin'];
        if (origin) {
          if (!isSameSiteRequest(req.headers)) {
            if (!validateOrigin(origin, [req.url.origin])) {
              return {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'CSRF check failed: origin mismatch' }),
              };
            }
          }
        }
      }

      // Serve robots.txt and sitemap.xml automatically
      const seoResponse = await tryServeSeoRoute(req.url.pathname, context.config, context.tree);
      if (seoResponse) {
        return seoResponse;
      }

      // Serve OG/Twitter images from opengraph-image.tsx / twitter-image.tsx
      const ogResponse = await tryServeOgImage(req.url.pathname, context.config, context.routes, context.moduleLoader);
      if (ogResponse) {
        return ogResponse;
      }

      // i18n: extract locale from pathname if configured
      let _locale: string | undefined;
      let matchPathname = req.url.pathname;
      if (config.i18n) {
        const { extractLocale } = await import('pledgestack-core');
        const extracted = extractLocale(req.url.pathname, config.i18n);
        if (extracted) {
          _locale = extracted.locale;
          matchPathname = extracted.pathWithoutLocale;
        } else {
          // No locale prefix and 'always' strategy — redirect to detected locale
          const acceptLang = req.headers['accept-language'] ?? '';
          const { detectLocale, addLocalePrefix } = await import('pledgestack-core');
          const preferred = detectLocale(acceptLang, config.i18n);
          const redirectUrl = addLocalePrefix(req.url.pathname, preferred, config.i18n);
          return {
            status: 307,
            headers: { Location: redirectUrl },
            body: null,
          };
        }
      }

      const match = router.match(matchPathname);
      if (!match) {
        // Try to render not-found page
        return await renderNotFoundResponse(context, req.url.pathname);
      }

      // Update params in request context
      pledgeReq.params = match.params;
      setRequestContext(pledgeReq);

      // API route
      if (match.route.mode === 'api') {
        const mod = context.modules.get(match.route.filePath) as RouteHandlerModule | undefined;
        if (!mod) {
          return { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: renderErrorPage(500, 'Internal Server Error', 'Route module not loaded') };
        }

        // CORS preflight handling for API routes
        const corsConfig: CorsConfig = (config as unknown as Record<string, unknown>).cors as CorsConfig ?? DEFAULT_CORS_CONFIG;
        const corsResult = corsMiddleware(req.method, req.headers, corsConfig);
        if (corsResult && req.method === 'OPTIONS') {
          // Preflight request — return CORS headers directly
          return {
            status: 204,
            headers: corsResult.headers,
            body: null,
          };
        }

        const handlerFn = mod[req.method as keyof RouteHandlerModule] as
          | ((req: Request) => Promise<Response> | Response)
          | undefined;
        if (!handlerFn) {
          return { status: 405, headers: { Allow: Object.keys(mod).join(', ') }, body: 'Method Not Allowed' };
        }
        const request = new Request(req.url, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: typeof req.body === 'string' ? req.body : undefined,
        });
        const response = await handlerFn(request);

        // Merge CORS headers into API response
        const responseHeaders = Object.fromEntries(response.headers.entries());
        if (corsResult) {
          Object.assign(responseHeaders, corsResult.headers);
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: response.body,
        };
      }

      // SSR or RSC page
      try {
        // Static export mode — always use SSR (no streaming)
        if (config.output === 'export') {
          const renderCtx: PluginRenderContext = {
            config,
            url: req.url,
            pathname: req.url.pathname,
            params: match.params,
            status: 200,
            headers: {},
          };
          await context.pluginRunner.runRenderStart(renderCtx);
          let html = await renderSSR({
            config,
            match,
            tree: context.tree!,
            modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule>,
            searchParams: pledgeReq.query,
          });
          html = await context.pluginRunner.runRenderEnd(renderCtx, html);
          html = await context.pluginRunner.runTransformHtml(html, renderCtx);
          return {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html,
          };
        }

        if (config.rsc && (config.framework ?? 'react') === 'react' && match.route.mode !== 'ssg') {
          const html = await renderRSCToHTML({
            config,
            match,
            tree: context.tree!,
            modules: context.modules as Map<string, PageModule | LayoutModule>,
            searchParams: pledgeReq.query,
          });
          return {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html,
          };
        }

        // PPR: serve prerendered static shell + stream dynamic holes
        if (config.ppr && match.route.mode !== 'ssg' && !(match.route as { mode?: string }).mode?.includes('api')) {
          try {
            const { renderDynamicHoles } = await import('pledgestack-core');
            const { existsSync, readFileSync } = await import('node:fs');
            const { join: joinPath } = await import('node:path');

            // Try to load the prerendered static shell from the build output
            const shellPath = joinPath(
              config.rootDir,
              config.outDir,
              'ppr-shells',
              match.route.pattern.replace(/\//g, '_').replace(/^\//, '') + '.shell.html',
            );

            let staticShell: string | undefined;
            if (existsSync(shellPath)) {
              staticShell = readFileSync(shellPath, 'utf-8');
            }

            // At request time, render dynamic holes into the prerendered shell
            // If we have a cached shell, the dynamic holes fill in the placeholders
            // If not, we render the full page (fallback to SSR-like behavior)
            const stream = await renderDynamicHoles({
              config,
              match,
              tree: context.tree!,
              modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
              staticShell,
              isPrerender: false,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8', 'Transfer-Encoding': 'chunked' },
              body: stream,
            };
          } catch (pprErr) {
            console.warn('[pledgestack] PPR render failed, falling back to SSR:', pprErr);
          }
        }

        // Use true streaming (ReadableStream) when loading.tsx is present
        if (match.route.loadingFilePath) {
          try {
            const stream = await renderRSCStream({
              config,
              match,
              tree: context.tree!,
              modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
              searchParams: pledgeReq.query,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8', 'Transfer-Encoding': 'chunked' },
              body: stream,
            };
          } catch (streamErr) {
            console.warn('[pledgestack] RSC stream failed, falling back to buffered SSR:', streamErr);
          }
        }

        // Use buffered streaming SSR (renderToPipeableStream with Suspense)
        // when error boundaries or loading boundaries exist but RSCStream failed
        if (match.route.loadingFilePath || match.route.errorFilePath) {
          try {
            const html = await renderSSRStream({
              config,
              match,
              tree: context.tree!,
              modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>,
              searchParams: pledgeReq.query,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
              body: html,
            };
          } catch (ssrStreamErr) {
            console.warn('[pledgestack] SSR stream failed, falling back to non-streaming:', ssrStreamErr);
          }
        }

        const html = await renderSSR({
          config,
          match,
          tree: context.tree!,
          modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule>,
          searchParams: pledgeReq.query,
        });

        // Inject devtools overlay in dev mode
        let finalHtml = html;
        if (isDev) {
          try {
            const { createDevtoolsMiddleware } = await import('pledgestack-overlay');
            const devtools = createDevtoolsMiddleware();
            finalHtml = devtools.transformHtml(html);
          } catch {
            // Overlay package not available — skip
          }
        }

        // Generate ETag for SSR response and check If-None-Match
        const etag = generateETag(finalHtml);
        if (isETagMatch(req.headers['if-none-match'] ?? req.headers['If-None-Match'], etag)) {
          return {
            status: 304,
            headers: { ETag: etag },
            body: null,
          };
        }

        return {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: etag, 'X-Request-Id': requestId },
          body: finalHtml,
        };
      } catch (err) {
        console.error('[pledgestack] Render error:', err);
        return {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: renderErrorPage(500, 'Internal Server Error', 'Something went wrong while rendering this page.'),
        };
      }
    } finally {
      clearRequestContext();
      if (tracingSpan) tracingSpan.end();
    }
  }

  async function renderNotFoundResponse(context: HandlerContext, pathname: string): Promise<PledgeResponse> {
    // Find a not-found route or use the default
    const notFoundRoute = context.routes.find((r) => r.isNotFound);
    if (notFoundRoute) {
      const notFoundModule = context.modules.get(notFoundRoute.filePath) as NotFoundModule | undefined;
      if (notFoundModule) {
        try {
          const html = await renderNotFound({
            config: context.config,
            match: { pathname, params: {}, route: notFoundRoute },
            tree: context.tree!,
            modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule>,
          });
          return {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: html,
          };
        } catch (err) {
          console.error('[pledgestack] Not-found render error:', err);
        }
      }
    }

    return {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Not Found',
    };
  }

  async function handler(req: { url: URL; method: string; headers: Record<string, string>; body?: string | Buffer | null }): Promise<PledgeResponse> {
    try {
      return await withTimeout(innerHandler(req), REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimeoutError) {
        console.error(`[pledgestack] ${err.message} — ${req.method} ${req.url.pathname}`);
        return {
          status: 504,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: renderErrorPage(504, 'Gateway Timeout', 'The request took too long to process.'),
        };
      }
      console.error('[pledgestack] Unhandled request error:', err);
      return {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: renderErrorPage(500, 'Internal Server Error', 'Something went wrong on the server.'),
      };
    }
  }

  function invalidate() {
    if (localCtx) {
      localCtx.moduleLoader.invalidateAll();
      localCtx = null;
    }
  }

  return { handler, invalidate };
}

function parseCookies(headers: Record<string, string>): Record<string, string> {
  const cookieHeader = headers['cookie'] ?? headers['Cookie'] ?? '';
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(rest.join('='));
    }
  }
  return cookies;
}

/**
 * Renders a user-friendly HTML error page.
 *
 * In dev mode, includes the error message and stack trace for debugging.
 * In production, shows a generic message without sensitive details.
 *
 * If a global-error.tsx module is available, it would be rendered here —
 * for now we use a built-in fallback that matches PledgeStack's styling.
 */
function renderErrorPage(status: number, title: string, message: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const devDetails = isDev ? `\n    <p class="detail">${message}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { text-align: center; max-width: 600px; padding: 2rem; }
    .status { font-size: 6rem; font-weight: 700; color: #ff4444; line-height: 1; }
    .title { font-size: 1.5rem; margin: 1rem 0; color: #fff; }
    .message { color: #999; font-size: 1rem; margin-bottom: 2rem; }
    .detail { color: #666; font-size: 0.875rem; margin-top: 1rem; padding: 1rem; background: #1a1a1a; border-radius: 8px; text-align: left; white-space: pre-wrap; word-break: break-word; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="status">${status}</div>
    <h1 class="title">${title}</h1>
    <p class="message">${message}</p>${devDetails}
    <p><a href="/">Go home</a></p>
  </div>
</body>
</html>`;
}
