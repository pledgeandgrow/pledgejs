import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PledgeConfig, PledgeResponse, MiddlewareResult, ResolvedRoute, PledgeRequest, PluginRenderContext, BundlerAdapter, RenderSecurity } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, createRouter, renderSSR, renderNotFound } from 'pledgestack-core';
import { getIsr, setIsr, isRevalidating, markRevalidating } from 'pledgestack-core';
import { maybeRenderOgResponse } from './og-response';
import { renderRSCToHTML } from 'pledgestack-core';
import { renderRSCStream } from 'pledgestack-core';
import { renderSSRStream } from 'pledgestack-core';
import { initRenderer } from 'pledgestack-core';
import { ColdStartOptimizer } from 'pledgestack-core';
import { applyScriptSecurity, generateCspNonce } from 'pledgestack-core';
import { resolveClientIdentifier } from './trusted-proxy';
import type { PageModule, LayoutModule, RouteHandlerModule, MiddlewareModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, TemplateModule } from 'pledgestack-core';
import type { RouteTree } from 'pledgestack-core';
import { createModuleLoader, type ModuleLoader } from './module-loader';
import { setRequestContext, clearRequestContext, getSigningSecret, hasConfiguredSecret } from './server-utils';
import { createMatcher } from './middleware-matcher';
import { getServerAction } from './actions';
import { dispatchServerFn, hasServerFn } from './server-fn';
import { ACTION_ENDPOINT } from 'pledgestack-shared';
import { PluginRunner } from 'pledgestack-shared';
import { tryServeSeoRoute } from './seo-routes';
import { tryServeOgImage } from './og-image';
import { generateETag, isETagMatch } from './etag';
import { validateRedirect, validateOrigin, isSameSiteRequest, deepSanitize } from 'pledgestack-auth';
import { hmacSha256Hex, timingSafeEqualStr, setPledgeAssetManifest } from 'pledgestack-shared';
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
function clientIdentifier(
  headers: Record<string, string>,
  config: PledgeConfig,
  remoteAddress?: string,
): string {
  // Forwarding headers are only honored from a trusted peer — otherwise a
  // direct client can spoof X-Forwarded-For per request and get a fresh
  // rate-limit/lockout bucket every time. See trusted-proxy.ts.
  return resolveClientIdentifier(headers, remoteAddress, config.trustedProxies);
}

/**
 * Auth-sensitive paths covered by default brute-force protection: exact
 * match or path prefix (base + '/'). Operators extend via config.authPaths.
 */
const DEFAULT_AUTH_PATHS = [
  '/login',
  '/auth',
  '/signup',
  '/register',
  '/reset',
  '/reset-password',
  '/forgot-password',
  '/verify',
  '/otp',
];

function isAuthPath(pathname: string, config: PledgeConfig): boolean {
  const paths = [...DEFAULT_AUTH_PATHS, ...(config.authPaths ?? [])];
  return paths.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** Standard RateLimit-* headers (draft spec) alongside Retry-After. */
function rateLimitHeaders(maxTokens: number, result: { remaining?: number; retryAfterMs: number }): Record<string, string> {
  const retryAfterSecs = Math.ceil(result.retryAfterMs / 1000);
  return {
    'RateLimit-Limit': String(maxTokens),
    'RateLimit-Remaining': String(Math.max(0, Math.floor(result.remaining ?? 0))),
    'RateLimit-Reset': String(retryAfterSecs),
    'Retry-After': String(retryAfterSecs),
  };
}

/**
 * Cookie name carrying the action-endpoint token. The token is a static
 * HMAC of the server secret — a MAC, not a nonce — so it is safe to issue
 * on shared/ISR-cached HTML. Not `__Host-`-prefixed: the prefix would force
 * Secure and break enforcement on plain-HTTP deployments that still want it.
 */
const ACTION_TOKEN_COOKIE = 'pledge_at';

/** The expected action-token value for the configured signing secret. */
function expectedActionToken(): string {
  return hmacSha256Hex(getSigningSecret(), 'pledge-action-endpoint');
}

/**
 * Validates a redirect() destination. Relative paths and same-origin URLs
 * are always allowed; external hosts need config.allowedRedirects. Returns
 * the sanitized destination or a 400 response — never an unvalidated URL.
 */
function redirectResponse(
  destination: string,
  status: number,
  config: PledgeConfig,
  origin: string,
): PledgeResponse {
  const safe = validateRedirect(destination, { origin, allowedHosts: config.allowedRedirects });
  if (!safe) {
    return { status: 400, headers: { 'Content-Type': 'text/plain' }, body: 'Invalid redirect destination' };
  }
  return { status, headers: { Location: safe }, body: null };
}

/** Strips CR/LF and other control chars from a response header value. */
function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: control chars in header values enable response splitting.
  return value.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
}

type AnyModule = PageModule | LayoutModule | RouteHandlerModule | MiddlewareModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule;

/**
 * The request shape each runtime adapter hands to the handler.
 * `remoteAddress` is the socket peer (Node only — edge runtimes don't
 * expose it); `_pledgeReq` is stashed by innerHandler so the outer wrapper
 * can merge cookies()/headers() mutations into the response.
 */
interface TransportRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer | null;
  remoteAddress?: string;
  _pledgeReq?: PledgeRequest;
}

interface HandlerContext {
  config: PledgeConfig;
  routes: ReturnType<typeof resolveRoutes>;
  router: ReturnType<typeof createRouter>;
  tree: RouteTree | null;
  modules: Map<string, AnyModule>;
  moduleLoader: ModuleLoader;
  middleware: MiddlewareModule | null;
  pluginRunner: PluginRunner;
  /** SRI integrity hashes for framework-emitted /__pledge__/* assets */
  assetIntegrity: Record<string, string>;
  /** Import map injected into dev HTML so bare specifiers in unbundled modules resolve */
  devImportMap?: string;
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
  // Promise singleton to prevent concurrent double-initialization: two
  // simultaneous first-requests both seeing localCtx === null would each run
  // the full init (scanning app dir, loading all modules), doing duplicate
  // work and potentially causing inconsistent state.
  let initPromise: Promise<HandlerContext> | null = null;

  /** Default request timeout in ms (30s, configurable via env) */
  const REQUEST_TIMEOUT_MS = parseInt(process.env.PLEDGE_REQUEST_TIMEOUT ?? '30000', 10);

  /**
   * Wraps a promise with a timeout. Returns the promise result or a 504 timeout response.
   * On timeout, aborts the `AbortController` so handlers performing expensive
   * work (DB calls, renders, fetches) can bail early via `signal.aborted`
   * instead of continuing to consume CPU/memory after the response is gone.
   */
  function withTimeout<T>(
    promise: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise(controller.signal)
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
    // If initialization is already in progress, wait for it instead of
    // running a duplicate initialization (prevents race condition).
    if (initPromise) return initPromise;
    initPromise = doEnsureContext();
    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function doEnsureContext(): Promise<HandlerContext> {
    if (localCtx) return localCtx;

    // Cold-start optimization: wrap the initialization path in the optimizer
    // so critical modules are pre-warmed and cold start time is measured.
    // On serverless/edge runtimes the first request pays the init cost; the
    // optimizer tracks that cost and pre-loads the critical path (renderer,
    // router, module loader) so subsequent requests hit a warm cache.
    const coldStart = new ColdStartOptimizer({
      modules: ['renderer', 'routes', 'modules', 'middleware'],
      criticalModules: ['renderer', 'routes'],
      preloadCritical: true,
      trackMetrics: true,
    });

    coldStart.registerLoader('renderer', () => initRenderer(config));
    coldStart.registerLoader('routes', async () => {
      const files = await scanAppDir(join(config.rootDir, config.appDir));
      return resolveRoutes(files, config);
    });

    // Pre-warm the critical path (renderer + route resolution)
    await coldStart.initialize();

    const routes = (await coldStart.get('routes')) as ReturnType<typeof resolveRoutes>;
    const router = createRouter(routes, config);

    // Load all modules including convention files
    const moduleLoader = createModuleLoader(config, isDev, pledgepackPort, adapter);
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

    // SRI hashes for the framework's virtual assets. Dynamic import so edge
    // bundles don't statically pull in node:fs via virtual-modules.ts.
    let assetIntegrity: Record<string, string> = {};
    try {
      const { computeAssetIntegrity, loadPledgeAssetManifest } = await import('./virtual-modules');
      // Install the build's asset manifest so renderers resolve
      // /__pledge__/client.js-style URLs to their content-hashed names.
      // Explicitly cleared in dev: the virtual module serves generated code
      // at the stable paths and a stale prod manifest must not leak in.
      setPledgeAssetManifest(isDev ? null : loadPledgeAssetManifest(config));
      assetIntegrity = await computeAssetIntegrity(config, isDev, pledgepackPort);
    } catch {
      // Hashing is best-effort — never block startup on it.
    }

    // Dev-only import map: transformed app modules and the generated
    // router/client scripts use bare specifiers the browser cannot resolve
    // without it. Same pattern as pledgepack's own dev shell.
    let devImportMap: string | undefined;
    if (isDev) {
      try {
        const { buildDevImportMap } = await import('./virtual-modules');
        devImportMap = buildDevImportMap(config);
      } catch {
        // Missing node_modules must never block startup.
      }
    }

    localCtx = {
      config,
      routes,
      router,
      tree: router.tree,
      modules,
      moduleLoader,
      middleware,
      pluginRunner,
      assetIntegrity,
      devImportMap,
    };

    // Report cold start metrics when enabled (e.g. PLEDGE_COLD_START_METRICS=1)
    if (process.env.PLEDGE_COLD_START_METRICS === '1') {
      console.log(coldStart.generateReport());
    }

    return localCtx;
  }

  async function innerHandler(req: TransportRequest, signal?: AbortSignal): Promise<PledgeResponse> {
    const context = await ensureContext();
    const { router, middleware } = context;

    // Per-request CSP nonce — stamped on every executable <script> the
    // framework emits and mirrored into the CSP header by the runtime
    // adapter. RenderSecurity.assetIntegrity carries build-stable SRI hashes.
    const cspNonce = generateCspNonce();
    const security: RenderSecurity = { cspNonce, assetIntegrity: context.assetIntegrity };
    /** Stamps nonce/integrity on a buffered HTML response body. */
    const secureHtml = (html: string) => applyScriptSecurity(html, security);

    // Build PledgeRequest for server utilities (cookies, headers, params).
    // Stashed on the transport req so the outer handler can merge cookies()
    // and headers() mutations into the response after innerHandler returns.
    const pledgeReq: PledgeRequest = {
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
      params: {},
      // deepSanitize strips __proto__/constructor/prototype keys so a query
      // like ?__proto__[x]=1 can't pollute downstream object merges.
      query: deepSanitize(Object.fromEntries(req.url.searchParams.entries())),
      cookies: parseCookies(req.headers),
      signal,
      // Resolved through trustedProxies — route code should use this rather
      // than trusting raw forwarded headers.
      ip: clientIdentifier(req.headers, config, req.remoteAddress),
    };
    req._pledgeReq = pledgeReq;

    // Set request context so server utilities can access it
    setRequestContext(pledgeReq);

    // Generate request ID for tracing — sanitize client-supplied value to
    // prevent log injection via newlines or control characters.
    const rawRequestId = req.headers['x-request-id'];
    const sanitizedRequestId = rawRequestId && /^[a-zA-Z0-9_-]{1,128}$/.test(rawRequestId)
      ? rawRequestId
      : randomUUID();
    pledgeReq.headers['x-request-id'] = sanitizedRequestId;

    /**
     * Runs the app middleware. Returns a response when middleware short-circuits
     * the request, or null to continue. For server-action POSTs the matcher is
     * also tested against the page that issued the action (Referer/Origin)
     * because the action endpoint itself never matches page-scoped matchers such
     * as "/dashboard/:path*" — without this, auth middleware would not protect
     * the actions invoked from the pages it guards. Rewrites are ignored for
     * actions.
     */
    const applyMiddleware = async (isAction: boolean): Promise<PledgeResponse | null> => {
      if (!middleware) return null;
      let shouldRun = true;
      if (middleware.matcher) {
        const matches = createMatcher(middleware.matcher);
        shouldRun = matches(req.url.pathname);
        if (!shouldRun && isAction) {
          // Fail closed: skip only when a same-origin referring page is
          // provably outside the matcher. A missing/unparseable/cross-origin
          // referer cannot prove that, so the middleware runs. (Referer is a
          // client-supplied hint — actions that need authorization must still
          // authenticate themselves; this only stops the common bypass.)
          shouldRun = true;
          const referer = req.headers['referer'];
          if (referer) {
            try {
              const refUrl = new URL(referer);
              if (refUrl.origin === req.url.origin) {
                shouldRun = matches(refUrl.pathname);
              }
            } catch {
              // Unparseable referer — keep running the middleware.
            }
          }
        }
      }
      if (!shouldRun) return null;

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
        const safeDestination = validateRedirect(mwResult.redirect.destination, {
          origin: req.url.origin,
          allowedHosts: config.allowedRedirects,
        });
        if (!safeDestination) {
          return { status: 400, headers: {}, body: 'Invalid redirect' };
        }
        return {
          status: mwResult.redirect.permanent ? 308 : 307,
          headers: { Location: safeDestination },
          body: null,
        };
      }

      if (mwResult.rewrite && !isAction) {
        // Validate that the rewrite stays same-origin to prevent open
        // redirect via an absolute URL in the middleware rewrite target.
        const rewriteUrl = new URL(mwResult.rewrite, req.url.origin);
        if (rewriteUrl.origin !== req.url.origin) {
          return { status: 400, headers: {}, body: 'Invalid rewrite: cross-origin not allowed' };
        }
        req.url = rewriteUrl;
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
      return null;
    };

    // Start tracing span for this request
    let tracingSpan: { end: (error?: Error) => void } | null = null;
    try {
      const { startSpan, isTracingEnabled } = await import('./tracing');
      if (isTracingEnabled()) {
        const span = startSpan(`HTTP ${req.method} ${req.url.pathname}`, {
          'http.method': req.method,
          'http.url': req.url.toString(),
          'http.request_id': sanitizedRequestId,
        });
        tracingSpan = span;
      }
    } catch {
      // Tracing module not available
    }

    try {
      // Method gate: TRACE/TRACK/CONNECT have no route semantics and are
      // classic XST/debug vectors — reject before any routing work.
      if (req.method === 'TRACE' || req.method === 'TRACK' || req.method === 'CONNECT') {
        return {
          status: 405,
          headers: { Allow: 'GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS', 'Content-Type': 'text/plain' },
          body: 'Method Not Allowed',
        };
      }

      // Built-in CSP violation report collector. Browser-sent reports arrive
      // as cross-origin POSTs without an Origin header and may carry cookies,
      // so this must run BEFORE the CSRF check — the endpoint is read-only
      // (logs and discards), so there is nothing to forge.
      if (req.url.pathname === '/__pledge__/csp-report' && req.method === 'POST') {
        // Unauthenticated public endpoint — bound it or attacker input
        // becomes unbounded log volume. 60/min per client is generous for
        // real violations (a broken page emits a handful per load) while
        // keeping a flood out of the console.
        const { checkRateLimit } = await import('pledgestack-core');
        const reportIp = clientIdentifier(req.headers, config, req.remoteAddress);
        if (!checkRateLimit(reportIp, 60, 1).allowed) {
          return { status: 204, headers: {}, body: null };
        }
        const rawReport = typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
        try {
          const report = JSON.parse(rawReport || '{}') as Record<string, unknown>;
          const violation = (report['csp-report'] ?? report) as Record<string, unknown>;
          console.warn('[pledgestack/csp-report]', JSON.stringify(violation).slice(0, 2000));
        } catch {
          // Malformed report — discard.
        }
        return { status: 204, headers: {}, body: null };
      }

      // Handle server action endpoint
      if (req.url.pathname === ACTION_ENDPOINT && req.method === 'POST') {
        // Middleware (auth, redirects, headers) must guard actions too.
        {
          const mwResponse = await applyMiddleware(true);
          if (mwResponse) return mwResponse;
        }

        // Content-type allowlist: action calls are JSON RPC. Rejecting
        // anything else also blocks HTML form posts, which can't set
        // application/json and would otherwise reach the parser.
        const actionContentType = (req.headers['content-type'] ?? '').toLowerCase();
        if (!actionContentType.includes('application/json')) {
          return {
            status: 415,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Unsupported Media Type — expected application/json' }),
          };
        }

        // Action-endpoint token: when a deployment secret is configured,
        // HTML responses carry a `pledge_at` cookie (HMAC of the secret) that
        // same-site fetches send automatically. A client that never loaded a
        // page — scanners hammering the RPC endpoint directly — gets 403.
        // This layers on CSRF + rate limiting; it is deliberately skipped
        // when no secret exists so dev workflows are unaffected.
        if (hasConfiguredSecret()) {
          const token = pledgeReq.cookies[ACTION_TOKEN_COOKIE];
          if (!token || !timingSafeEqualStr(token, expectedActionToken())) {
            return {
              status: 403,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: 'Missing or invalid action token' }),
            };
          }
        }

        if (config.rateLimit !== false) {
          const { checkRateLimit } = await import('pledgestack-core');
          const rl = typeof config.rateLimit === 'object' ? config.rateLimit : {};
          const maxTokens = rl.maxTokens ?? 100;
          const rateResult = checkRateLimit(
            `action:${clientIdentifier(req.headers, config, req.remoteAddress)}`,
            maxTokens,
            rl.refillRate ?? 2,
          );
          if (!rateResult.allowed) {
            return {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                ...rateLimitHeaders(maxTokens, rateResult),
              },
              body: JSON.stringify({ error: 'Too Many Requests', retryAfterMs: rateResult.retryAfterMs }),
            };
          }
        }

        // Server actions are state-changing and cookie-authenticated, so they
        // must pass the same CSRF check as any other mutating request. This
        // branch returns early (before the general CSRF block below), so the
        // check has to be applied here explicitly — otherwise any third-party
        // page could POST a known action id with the victim's cookies.
        // CSRF is decoupled from securityHeaders — disabling headers should
        // not silently disable CSRF protection.
        if (config.csrf !== false && !passesCsrf(req.headers, req.url.origin)) {
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

        // Parse body (may arrive as a Buffer from the Node server, or a string
        // from edge runtimes).
        const rawBody = typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : '';
        let args: unknown[];
        try {
          const parsed = JSON.parse(rawBody || '{}') as { args?: unknown[] };
          // Strip __proto__/constructor/prototype keys so action args can't
          // pollute objects they get merged into downstream.
          args = Array.isArray(parsed.args) ? deepSanitize(parsed.args) : [];
        } catch {
          return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Invalid JSON body' }) };
        }

        // Try server functions first (new TanStack Start-style API).
        // Server functions use the same action endpoint and ID header but
        // are registered via createServerFn() rather than serverAction().
        if (hasServerFn(actionId)) {
          try {
            const result = await dispatchServerFn(actionId, args, {
              method: req.method,
              url: req.url.toString(),
              headers: req.headers,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ result }),
            };
          } catch (err) {
            console.error('[pledgestack] Server function error:', err);
            const isProd = process.env.NODE_ENV === 'production';
            return {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: isProd ? 'Server function failed' : (err instanceof Error ? err.message : 'Server function failed') }),
            };
          }
        }

        // Fall back to legacy server actions
        const actionFn = getServerAction(actionId);
        if (!actionFn) {
          return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Action "${actionId}" not found` }) };
        }

        try {
          const result = await actionFn(...args);
          return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ result }),
          };
        } catch (err) {
          console.error('[pledgestack] Server action error:', err);
          // In production, don't leak internal error details to the client.
          const isProd = process.env.NODE_ENV === 'production';
          return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: isProd ? 'Action failed' : (err instanceof Error ? err.message : 'Action failed') }),
          };
        }
      }

      // Execute middleware first (respecting matcher config if present)
      {
        const mwResponse = await applyMiddleware(false);
        if (mwResponse) return mwResponse;
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
        const ip = clientIdentifier(req.headers, config, req.remoteAddress);
        const rateResult = checkRateLimit(ip, maxTokens, refillRate);
        if (!rateResult.allowed) {
          return {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...rateLimitHeaders(maxTokens, rateResult),
            },
            body: JSON.stringify({ error: 'Too Many Requests', retryAfterMs: rateResult.retryAfterMs }),
          };
        }
      }

      // Auto-apply brute force protection on auth endpoints (default: on —
      // path-scoped so it costs nothing for apps without auth routes, and the
      // check is a no-op until recordFailedAttempt() starts tracking).
      // Covers login plus the other credential-bearing endpoints — signup,
      // password reset, OTP/email verification — which are equally
      // flood-worthy. Extend via config.authPaths. Exact match or path
      // prefix only, to avoid false positives like /blog/login-tips.
      if (config.bruteForceProtection !== false && isAuthPath(req.url.pathname, config)) {
        const { checkBruteForce } = await import('./safety-net');
        const ip = clientIdentifier(req.headers, config, req.remoteAddress);
        const bfResult = await checkBruteForce(ip);
        if (bfResult.lockedOut) {
          const retryAfterMs = Math.max(0, (bfResult.lockoutEndsAt ?? Date.now()) - Date.now());
          return {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              ...rateLimitHeaders(0, { remaining: 0, retryAfterMs }),
            },
            body: JSON.stringify({ error: 'Too many login attempts. Try again later.' }),
          };
        }
      }

      // CSRF protection for state-changing requests (server actions are handled
      // by the same check in their own branch above). CSRF is decoupled from
      // securityHeaders — disabling headers should not silently disable CSRF.
      const isStateChanging = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
      const isServerAction = req.url.pathname === ACTION_ENDPOINT;
      if (isStateChanging && !isServerAction && config.csrf !== false) {
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
      let requestLocale: string | undefined;
      if (config.i18n) {
        const { extractLocale } = await import('pledgestack-core');
        const extracted = extractLocale(req.url.pathname, config.i18n);
        if (extracted) {
          matchPathname = extracted.pathWithoutLocale;
          requestLocale = extracted.locale;
        } else {
          // No locale prefix and 'always' strategy — redirect to detected locale
          const acceptLang = req.headers['accept-language'] ?? '';
          const { detectLocale, addLocalePrefix } = await import('pledgestack-core');
          const preferred = detectLocale(acceptLang, config.i18n);
          const redirectUrl = addLocalePrefix(req.url.pathname, preferred, config.i18n);
          return {
            status: 307,
            // The chosen destination varies on Accept-Language — a shared
            // cache must not serve one locale's redirect to another client.
            headers: { Location: redirectUrl, Vary: 'Accept-Language' },
            body: null,
          };
        }
      }

      const match = router.match(matchPathname);
      if (!match) {
        // Try to render not-found page
        return await renderNotFoundResponse(context, req.url.pathname, security, cspNonce);
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
        ip: clientIdentifier(req.headers, config, req.remoteAddress),
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

        const httpMethods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];
        // Only real HTTP-method exports are dispatchable — a request method
        // such as "constructor" must never resolve to an arbitrary property.
        const handlerFn = (httpMethods.includes(req.method) ? mod[req.method as keyof RouteHandlerModule] : undefined) as
          | ((req: Request) => Promise<Response> | Response)
          | undefined;
        if (!handlerFn) {
          const allow = Object.keys(mod).filter((k) => httpMethods.includes(k)).join(', ');
          return { status: 405, headers: { Allow: allow }, body: 'Method Not Allowed' };
        }
        const request = new Request(req.url, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: req.body == null ? undefined : (req.body as unknown as BodyInit),
        });
        const response = await handlerFn(request);

        // OG pipeline: rasterize ImageResponse bodies (X-Pledge-OG) that are
        // SVG-shaped; layout-based trees stay for PledgePack's build-time renderer.
        const ogRendered = await maybeRenderOgResponse(response);

        // Extract Set-Cookie separately: Headers.entries() combines multiple
        // Set-Cookie into one comma-joined value (corrupting cookies that
        // contain commas, e.g. Expires), so pull the real array via
        // getSetCookie() and drop the combined entry from the flat record.
        const setCookies = typeof ogRendered.headers.getSetCookie === 'function'
          ? ogRendered.headers.getSetCookie()
          : [];
        const responseHeaders = Object.fromEntries(ogRendered.headers.entries());
        delete responseHeaders['set-cookie'];
        if (corsResult) {
          Object.assign(responseHeaders, corsResult.headers);
          // The default CORP: same-origin would contradict an explicitly
          // allowed cross-origin CORS route — relax it for this response so
          // the two policies agree.
          if (corsResult.headers['Access-Control-Allow-Origin']) {
            responseHeaders['Cross-Origin-Resource-Policy'] = 'cross-origin';
          }
        }

        return {
          status: ogRendered.status,
          headers: responseHeaders,
          body: ogRendered.body,
          ...(setCookies.length > 0 ? { cookies: setCookies } : {}),
        };
      }

      // Pages are render endpoints — only GET/HEAD produce documents. A
      // mutating method that reached here already passed CSRF but has no
      // handler to receive it; 405 is more honest than rendering a page.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return {
          status: 405,
          headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' },
          body: 'Method Not Allowed',
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
            body: secureHtml(html),
            cspNonce,
          };
        }

        // 'pledge' renders via the React adapter, so it is RSC-capable too.
        if (config.rsc && ['react', 'pledge'].includes(config.framework ?? 'react') && match.route.mode !== 'ssg') {
          const html = await renderRSCToHTML({
            config,
            match,
            tree: context.tree!,
            modules: context.modules as Map<string, PageModule | LayoutModule>,
            searchParams: pledgeReq.query,
            security,
          });
          return {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: secureHtml(html),
            cspNonce,
          };
        }

        // PPR: serve prerendered static shell + stream dynamic holes
        if (config.ppr && match.route.mode !== 'ssg' && !(match.route as { mode?: string }).mode?.includes('api')) {
          try {
            const { renderDynamicHoles } = await import('pledgestack-core');
            const { existsSync, readFileSync } = await import('node:fs');
            const { join: joinPath } = await import('node:path');

            // Try to load the prerendered static shell from the build output.
            // Same naming helper as the build-time writer (static-export):
            // params-specific shell first (generateStaticParams routes), then
            // the route-level shell.
            const { pprShellFileName } = await import('pledgestack-core');
            const shellDir = joinPath(config.rootDir, config.outDir, 'ppr-shells');
            let staticShell: string | undefined;
            for (const fileName of [
              pprShellFileName(match.route.pattern, match.params as Record<string, string>),
              pprShellFileName(match.route.pattern),
            ]) {
              const shellPath = joinPath(shellDir, fileName);
              if (existsSync(shellPath)) {
                staticShell = readFileSync(shellPath, 'utf-8');
                break;
              }
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
              security,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8', 'Transfer-Encoding': 'chunked' },
              body: stream,
              cspNonce,
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
              security,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8', 'Transfer-Encoding': 'chunked' },
              body: stream,
              cspNonce,
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
              security,
            });
            return {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
              body: secureHtml(html),
              cspNonce,
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
        // Include locale in the ISR cache key so different locales sharing the
        // same pathname don't get each other's cached HTML (#28).
        const isrKey = requestLocale ? `${requestLocale}::${req.url.pathname}` : req.url.pathname;
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

        // Stamp CSP nonce + SRI on emitted scripts. ISR-cached HTML is shared
        // across requests, so it gets SRI only — a frozen nonce could never
        // match the next request's CSP nonce.
        finalHtml = applyScriptSecurity(finalHtml, isrEligible ? { assetIntegrity: security.assetIntegrity } : security);

        // Cache policy: ISR pages may be held by shared caches for the
        // revalidate window (opted in via `revalidate`); every other dynamic
        // response is no-store so a CDN/proxy can't persist personalized HTML.
        const cacheControl = isrEligible
          ? `public, s-maxage=${revalidate}, stale-while-revalidate`
          : 'no-store';

        // Generate ETag for SSR response and check If-None-Match
        const etag = generateETag(finalHtml);
        if (isETagMatch(req.headers['if-none-match'] ?? req.headers['If-None-Match'], etag)) {
          return {
            status: 304,
            headers: { ETag: etag, 'Cache-Control': cacheControl },
            body: null,
          };
        }

        return {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: etag, 'X-Request-Id': sanitizedRequestId, 'Cache-Control': cacheControl },
          body: finalHtml,
          ...(isrEligible ? {} : { cspNonce }),
        };
      } catch (err) {
        // redirect()/notFound() throw sentinel errors that land here after
        // bubbling out of the render tree — convert them into real responses
        // instead of reporting them as render failures.
        const pending = pledgeReq as PledgeRequest & { _redirectDestination?: string; _redirectStatus?: number; _notFoundCalled?: boolean };
        if (pending._redirectDestination) {
          return redirectResponse(pending._redirectDestination, pending._redirectStatus ?? 307, config, req.url.origin);
        }
        if (pending._notFoundCalled) {
          return await renderNotFoundResponse(context, req.url.pathname, security, cspNonce);
        }
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

  async function renderNotFoundResponse(context: HandlerContext, pathname: string, security: RenderSecurity, cspNonce: string): Promise<PledgeResponse> {
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
            body: applyScriptSecurity(html, security),
            cspNonce,
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

  /**
   * Feeds the built-in brute-force guard: a 401 from a credential-bearing
   * endpoint (login, signup, password reset, OTP — see isAuthPath) counts as a
   * failed attempt for the client, so checkBruteForce() (enforced above on the
   * next request) actually has data to lock out on. Without this, apps had to
   * remember to call recordFailedAttempt() themselves. Successes deliberately
   * do NOT clear the counter here — an attacker with their own valid account
   * could otherwise reset it between guesses.
   */
  async function trackFailedAuth(req: TransportRequest, response: PledgeResponse): Promise<void> {
    if (
      response.status !== 401 ||
      req.method !== 'POST' ||
      config.bruteForceProtection === false ||
      !isAuthPath(req.url.pathname, config)
    ) {
      return;
    }
    try {
      const { recordFailedAttempt } = await import('./safety-net');
      await recordFailedAttempt(clientIdentifier(req.headers, config, req.remoteAddress));
    } catch (err) {
      console.error('[pledgestack] Failed to record failed auth attempt:', err);
    }
  }

  async function handler(req: TransportRequest): Promise<PledgeResponse> {
    try {
      const response = await withTimeout((signal) => innerHandler(req, signal), REQUEST_TIMEOUT_MS);
      await trackFailedAuth(req, response);
      return finalizeResponse(response, req, config, localCtx?.devImportMap);
    } catch (err) {
      // redirect() thrown outside the render tree (route handlers, middleware,
      // module init) lands here — honor it like an in-render redirect.
      const pending = req._pledgeReq as (PledgeRequest & { _redirectDestination?: string; _redirectStatus?: number; _notFoundCalled?: boolean }) | undefined;
      if (pending?._redirectDestination) {
        return finalizeResponse(
          redirectResponse(pending._redirectDestination, pending._redirectStatus ?? 307, config, req.url.origin),
          req,
          config,
        );
      }
      if (pending?._notFoundCalled) {
        try {
          const context = await ensureContext();
          const cspNonce = generateCspNonce();
          const resp = await renderNotFoundResponse(context, req.url.pathname, { cspNonce, assetIntegrity: context.assetIntegrity }, cspNonce);
          return finalizeResponse(resp, req, config, context.devImportMap);
        } catch {
          // fall through to the generic 500
        }
      }
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

/**
 * Default cache policy: every response that flows through the request
 * handler is dynamic (static assets and framework virtual modules are
 * served before the handler runs), so anything without an explicit
 * Cache-Control gets no-store — a shared CDN/proxy cache must never store
 * personalized HTML, API payloads, redirects, or error pages. Routes opt
 * into caching explicitly: ISR via `revalidate` (sets s-maxage itself),
 * API/OG/SEO routes by sending their own Cache-Control.
 */
/**
 * Merges cookies() and headers() mutations made by route code during
 * handling into the final response. The mutable stores live on the request
 * context; without this, `cookies(c => c.set('session', …))` / `setSession()`
 * would write into a void and never reach the client. Route-set response
 * headers take precedence over utility-store entries.
 */
function mergeResponseState(resp: PledgeResponse, req: TransportRequest): PledgeResponse {
  const pledgeReq = req._pledgeReq as (PledgeRequest & {
    _responseHeaders?: Record<string, string>;
    _responseCookies?: Record<string, string>;
  }) | undefined;
  if (!pledgeReq) return resp;
  const extraHeaders = pledgeReq._responseHeaders;
  const extraCookies = pledgeReq._responseCookies;
  if (!extraHeaders && !extraCookies) return resp;
  return {
    ...resp,
    headers: { ...(extraHeaders ?? {}), ...resp.headers },
    ...(extraCookies && Object.keys(extraCookies).length > 0
      ? { cookies: [...(resp.cookies ?? []), ...Object.values(extraCookies)] }
      : {}),
  };
}

function ensureCacheControl(resp: PledgeResponse): PledgeResponse {
  const hasCacheControl = Object.keys(resp.headers).some((k) => k.toLowerCase() === 'cache-control');
  if (hasCacheControl) return resp;
  return { ...resp, headers: { ...resp.headers, 'Cache-Control': 'no-store' } };
}

/**
 * Terminal response pipeline — runs on every response before it reaches the
 * runtime adapter. Centralizing here means route code, middleware, and
 * cookies()/headers() mutations all pass the same egress checks:
 *
 *  1. mergeResponseState — fold in cookies()/headers() mutations
 *  2. header sanitization — strip CR/LF/CTLs that would split the response
 *  3. default Content-Type — a body without one invites sniffing
 *  4. Cache-Control: no-store — dynamic responses are never CDN-cacheable
 *  5. maskForbidden — optional 403→404 to prevent resource enumeration
 *  6. action token — HTML responses carry the signed `pledge_at` cookie
 */
function finalizeResponse(resp: PledgeResponse, req: TransportRequest, config: PledgeConfig, devImportMap?: string): PledgeResponse {
  let out = mergeResponseState(resp, req);

  // Dev import map: HTML responses get the <script type="importmap"> that lets
  // the browser resolve bare specifiers in unbundled transformed modules.
  // The tag carries this response's CSP nonce — script-src has no
  // 'unsafe-inline', and strict-dynamic trusts the module graph it unlocks.
  if (devImportMap) {
    out = { ...out, body: injectDevImportMap(out.body, devImportMap, out.cspNonce, out.headers) };
  }

  // 2. Sanitize header values — a user-influenced value containing CR/LF
  //    (e.g. a redirect target built from a query param) would otherwise
  //    reach the raw socket or crash the adapter's writeHead.
  let headersChanged = false;
  const sanitizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(out.headers)) {
    const clean = sanitizeHeaderValue(value);
    if (clean !== value) headersChanged = true;
    sanitizedHeaders[key] = clean;
  }
  if (headersChanged) out = { ...out, headers: sanitizedHeaders };

  // 3. Default Content-Type on bodies that don't declare one — nosniff
  //    limits the blast radius but an explicit type is the honest answer.
  const hasContentType = Object.keys(out.headers).some((k) => k.toLowerCase() === 'content-type');
  if (out.body != null && !hasContentType) {
    out = {
      ...out,
      headers: {
        ...out.headers,
        'Content-Type': typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      },
    };
  }

  // 4. Cache policy.
  out = ensureCacheControl(out);

  // 5. Optional enumeration masking — 403s leak that a resource exists but
  //    is forbidden; operators who prefer indistinguishable misses opt in.
  if (config.maskForbidden === true && out.status === 403) {
    out = { ...out, status: 404 };
  }

  // 6. Issue the action-endpoint token on HTML responses when a deployment
  //    secret is configured. The cookie rides along on same-site fetches;
  //    the action endpoint requires it (see innerHandler).
  if (hasConfiguredSecret()) {
    const contentType = out.headers['Content-Type'] ?? out.headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      const secure = req.url.protocol === 'https:' || process.env.NODE_ENV === 'production';
      const tokenCookie = `${ACTION_TOKEN_COOKIE}=${expectedActionToken()}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
      const existing = out.cookies ?? [];
      if (!existing.some((c) => c.startsWith(`${ACTION_TOKEN_COOKIE}=`))) {
        out = { ...out, cookies: [...existing, tokenCookie] };
      }
    }
  }

  return out;
}

/**
 * Injects the dev import map into an HTML response body. Only HTML bodies are
 * touched; the tag is placed right before `</head>` so it precedes every
 * `<script type="module">` (they all live in the body tail).
 */
function injectDevImportMap(
  body: PledgeResponse['body'],
  importMapTag: string,
  cspNonce: string | undefined,
  headers: Record<string, string>,
): PledgeResponse['body'] {
  const contentType = headers['Content-Type'] ?? headers['content-type'] ?? '';
  if (body == null || !contentType.includes('text/html')) return body;

  const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
  const tag = importMapTag.replace(/<script(?=[\s>])/g, `<script${nonceAttr}`);

  if (typeof body === 'string') {
    if (body.includes('type="importmap"')) return body;
    const headEnd = body.indexOf('</head>');
    if (headEnd !== -1) return body.slice(0, headEnd) + tag + body.slice(headEnd);
    // No <head> (fragment/error shell) — an importmap still works anywhere
    // before the first module script; prepending is the safe fallback.
    return tag + body;
  }

  if (body instanceof ReadableStream) {
    return injectTagIntoStreamHead(body, tag);
  }
  return body;
}

/**
 * Streams `tag` into an HTML body right before `</head>`. Buffers only until
 * the needle is found (or a 64 KiB cap — streamed shells put </head> in the
 * first chunk) then passes the rest through untouched.
 */
function injectTagIntoStreamHead(body: ReadableStream<Uint8Array>, tag: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let scanning = true;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (scanning) {
          const { done, value } = await reader.read();
          if (done) {
            scanning = false;
            if (buffered) controller.enqueue(encoder.encode(buffered));
            controller.close();
            return;
          }
          buffered += decoder.decode(value, { stream: true });
          const idx = buffered.indexOf('</head>');
          if (idx !== -1) {
            scanning = false;
            controller.enqueue(encoder.encode(buffered.slice(0, idx) + tag + buffered.slice(idx)));
            break;
          }
          if (buffered.length > 64 * 1024) {
            scanning = false;
            controller.enqueue(encoder.encode(buffered));
            break;
          }
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** Percent-decode a cookie value; malformed escapes yield the raw value instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCookies(headers: Record<string, string>): Record<string, string> {
  const cookieHeader = headers['cookie'] ?? headers['Cookie'] ?? '';
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    // Skip prototype-poisoning names; a malformed %-escape in one cookie must
    // not throw (it used to fail the entire request with a 500).
    if (name && name !== '__proto__') {
      cookies[name] = safeDecode(rest.join('='));
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
