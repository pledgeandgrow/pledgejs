import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PledgeConfig, PledgeResponse, MiddlewareResult, ResolvedRoute, PledgeRequest, PluginRenderContext, BundlerAdapter } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, createRouter, renderSSR, renderNotFound } from 'pledgestack-core';
import { getIsr, setIsr, isRevalidating, markRevalidating } from 'pledgestack-core';
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
import { validateRedirect, validateOrigin, isSameSiteRequest } from 'pledgestack-auth';
import { corsMiddleware, DEFAULT_CORS_CONFIG, type CorsConfig } from './cors';

/**
 * Decide whether a state-changing request passes CSRF checks.
 *
 * CSRF is only exploitable against requests that carry ambient credentials
 * (cookies); a request with no Cookie header cannot be a cross-site forgery of
 * an authenticated action, so it is allowed through (this keeps tokenless
 * server-to-server / API-key clients working). For cookie-bearing requests we
 * require a positive same-origin signal:
 *   - an explicit same-origin/same-site `Sec-Fetch-Site` header, or
 *   - an `Origin` header that matches the site origin.
 * If neither is present the request cannot be confirmed same-origin and is
 * rejected (fail-closed) — previously a simply-omitted `Origin` header skipped
 * the check entirely.
 */
function passesCsrf(headers: Record<string, string>, siteOrigin: string): boolean {
  const hasCookies = !!(headers['cookie'] ?? headers['Cookie']);
  if (!hasCookies) return true;
  if (isSameSiteRequest(headers)) return true;
  const origin = headers['origin'] ?? headers['Origin'];
  if (origin) return validateOrigin(origin, [siteOrigin]);
  return false;
}

/** Read a page module's ISR revalidate interval (seconds), or 0 if none. */
function getRevalidateSeconds(mod: unknown): number {
  const m = mod as { revalidate?: unknown; metadata?: { revalidate?: unknown } } | undefined;
  const r = typeof m?.revalidate === 'number' ? m.revalidate : m?.metadata?.revalidate;
  return typeof r === 'number' && r > 0 ? r : 0;
}

/** Extract the best-available client identifier for rate limiting / lockout. */
function clientIdentifier(headers: Record<string, string>): string {
  // Only trust infrastructure-set forwarding headers. The previous fallback to
  // `x-request-id` was attacker-controllable (and even randomly generated per
  // request when absent), giving every request a fresh bucket / lockout counter
  // and defeating both rate limiting and brute-force protection.
  const xff = headers['x-forwarded-for']?.split(',')[0]?.trim();
  if (xff) return xff;
  const realIp = headers['x-real-ip']?.trim();
  if (realIp) return realIp;
  return 'unknown';
}

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
        // Server actions are state-changing and cookie-authenticated, so they
        // must pass the same CSRF check as any other mutating request. This
        // branch returns early (before the general CSRF block below), so the
        // check has to be applied here explicitly — otherwise any third-party
        // page could POST a known action id with the victim's cookies.
        if (config.securityHeaders !== false && !passesCsrf(req.headers, req.url.origin)) {
          return {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'CSRF check failed' }),
          };
        }

        const actionId = req.headers['x-pledge-action-id'];
        if (!actionId) {
          return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Missing action ID' }) };
        }

        const actionFn = getServerAction(actionId);
        if (!actionFn) {
          return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Action "${actionId}" not found` }) };
        }

        // Parse body (may arrive as a Buffer from the Node server, or a string
        // from edge runtimes).
        const rawBody = typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
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
          // Include the body so middleware that inspects a POST/PUT/PATCH body
          // sees it (constructing a Request with a body is invalid for GET/HEAD).
          const canHaveBody = req.method !== 'GET' && req.method !== 'HEAD';
          const mwRequest = new Request(req.url, {
            method: req.method,
            headers: req.headers as HeadersInit,
            // Buffer is a valid body at runtime though the DOM lib types omit it.
            ...(canHaveBody && req.body != null ? { body: req.body as unknown as BodyInit } : {}),
          });
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
        const ip = clientIdentifier(req.headers);
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
        const ip = clientIdentifier(req.headers);
        const bfResult = checkBruteForce(ip);
        if (bfResult.lockedOut) {
          return {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              // Retry-After in whole seconds. The parentheses were previously
              // misplaced so the division fell outside Math.ceil, producing a
              // fractional value like "899.123" that clients ignore.
              'Retry-After': String(Math.ceil(((bfResult.lockoutEndsAt ?? Date.now()) - Date.now()) / 1000)),
            },
            body: JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
          };
        }
      }

      // CSRF protection for state-changing requests (server actions are handled
      // by the same check in their own branch above).
      const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
      const isServerAction = req.url.pathname === ACTION_ENDPOINT;
      if (isStateChanging && !isServerAction && config.securityHeaders !== false) {
        if (!passesCsrf(req.headers, req.url.origin)) {
          return {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'CSRF check failed: origin mismatch' }),
          };
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
      let matchPathname = req.url.pathname;
      if (config.i18n) {
        const { extractLocale } = await import('pledgestack-core');
        const extracted = extractLocale(req.url.pathname, config.i18n);
        if (extracted) {
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

      // Run routeMatch plugin hooks (e.g. the rate-limiter plugin). A plugin
      // may short-circuit the request by setting `response`. These hooks were
      // previously never invoked by the pipeline, so plugins like
      // rateLimitMiddleware had no effect at all.
      const routeMatchResult = await context.pluginRunner.runRouteMatch({
        config,
        pathname: matchPathname,
        method: req.method,
        params: match.params,
        headers: req.headers,
        ip: clientIdentifier(req.headers),
      });
      if (routeMatchResult?.response) {
        return {
          status: routeMatchResult.response.status,
          headers: { 'Content-Type': 'application/json' },
          body: routeMatchResult.response.body,
        };
      }

      // API route
      if (match.route.mode === 'api') {
        const mod = context.modules.get(match.route.filePath) as RouteHandlerModule | undefined;
        if (!mod) {
          return { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: renderErrorPage(500, 'Internal Server Error', 'Route module not loaded') };
        }

        // CORS preflight handling for API routes
        const corsConfig: CorsConfig = config.cors ?? DEFAULT_CORS_CONFIG;
        const corsResult = corsMiddleware(req.method, req.headers, corsConfig);
        if (corsResult && req.method === 'OPTIONS') {
          // Preflight request. A disallowed origin is rejected with 403 rather
          // than answered with a 204 success.
          if (corsResult.rejected) {
            return {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
              body: 'CORS origin not allowed',
            };
          }
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
          // Allow header must list only the HTTP-method exports, not every
          // module export (config, runtime, default, …).
          const httpMethods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
          const allow = Object.keys(mod).filter((k) => httpMethods.includes(k)).join(', ');
          return { status: 405, headers: { Allow: allow }, body: 'Method Not Allowed' };
        }
        const request = new Request(req.url, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req.body == null ? undefined : (req.body as unknown as BodyInit),
        });
        const response = await handlerFn(request);

        // Extract Set-Cookie separately: Headers.entries() combines multiple
        // Set-Cookie into one comma-joined value (corrupting cookies that
        // contain commas, e.g. Expires), so pull the real array via
        // getSetCookie() and drop the combined entry from the flat record.
        const setCookies = typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [];
        const responseHeaders = Object.fromEntries(response.headers.entries());
        delete responseHeaders['set-cookie'];
        if (corsResult) {
          Object.assign(responseHeaders, corsResult.headers);
        }

        return {
          status: response.status,
          headers: responseHeaders,
          body: response.body,
          ...(setCookies.length > 0 ? { cookies: setCookies } : {}),
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
              searchParams: pledgeReq.query,
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

        // ISR: when the page exports a positive `revalidate` (seconds) and no
        // query params vary the output, serve from the ISR cache with
        // stale-while-revalidate. Only in production (dev always renders fresh).
        const pageMod = context.modules.get(match.route.filePath) as (PageModule & { revalidate?: number }) | undefined;
        const revalidate = getRevalidateSeconds(pageMod);
        const isrKey = req.url.pathname;
        const isrEligible = !isDev
          && revalidate > 0
          && Object.keys(pledgeReq.query).length === 0
          && Object.keys(match.params).length === 0;

        const doRenderSSR = () => renderSSR({
          config,
          match,
          tree: context.tree!,
          modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule>,
          searchParams: pledgeReq.query,
        });

        let html: string;
        if (isrEligible) {
          const cached = getIsr(isrKey);
          if (cached) {
            // Serve cached immediately; regenerate in the background if stale.
            if (cached.stale && !isRevalidating(isrKey)) {
              markRevalidating(isrKey, true);
              void doRenderSSR()
                .then((fresh) => setIsr(isrKey, fresh, revalidate))
                .catch((e) => console.error('[pledgestack] ISR revalidation failed:', e))
                .finally(() => markRevalidating(isrKey, false));
            }
            html = cached.html;
          } else {
            html = await doRenderSSR();
            setIsr(isrKey, html, revalidate);
          }
        } else {
          html = await doRenderSSR();
        }

        // Inject devtools overlay in dev mode
        let finalHtml = html;
        if (isDev) {
          try {
            // pledgestack-overlay is an optional dev-only dependency — built from
            // a variable specifier so TS treats this as an untyped dynamic import
            // instead of pulling the whole package into server's compile graph.
            const overlayModuleName: string = 'pledgestack-overlay';
            const { createDevtoolsMiddleware } = await import(overlayModuleName);
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
