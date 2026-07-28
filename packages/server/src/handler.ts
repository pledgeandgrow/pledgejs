import { join } from 'node:path';
import type { PledgeConfig, PledgeResponse, MiddlewareResult, ResolvedRoute, PledgeRequest, PluginRenderContext, BundlerAdapter } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, createRouter, renderSSR, renderNotFound } from 'pledgestack-core';
import { renderRSCToHTML } from 'pledgestack-core';
import { renderRSCStream } from 'pledgestack-core';
import { renderSSRStream } from 'pledgestack-core';
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

  async function ensureContext() {
    if (localCtx) return localCtx;

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

  async function handler(req: { url: URL; method: string; headers: Record<string, string>; body?: string | Buffer | null }): Promise<PledgeResponse> {
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
            return {
              status: mwResult.redirect.permanent ? 308 : 307,
              headers: { Location: mwResult.redirect.destination },
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

      const match = router.match(req.url.pathname);
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
          return { status: 500, headers: {}, body: 'Route module not loaded' };
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
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
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

        if (config.rsc && match.route.mode !== 'ssg') {
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
          } catch {
            // Fall back to buffered streaming SSR
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
          } catch {
            // Fall back to non-streaming SSR
          }
        }

        const html = await renderSSR({
          config,
          match,
          tree: context.tree!,
          modules: context.modules as Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule>,
          searchParams: pledgeReq.query,
        });

        return {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: html,
        };
      } catch (err) {
        console.error('[pledgestack] Render error:', err);
        return {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
          body: 'Internal Server Error',
        };
      }
    } finally {
      clearRequestContext();
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
