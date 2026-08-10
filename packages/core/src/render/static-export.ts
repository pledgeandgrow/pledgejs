import type { PledgeConfig, ResolvedRoute } from 'pledgestack-shared';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Static export generator — pre-renders all routes to static HTML files.
 * Used when `config.output === 'export'`.
 */

interface StaticExportOptions {
  config: PledgeConfig;
  routes: ResolvedRoute[];
  outputDir: string;
  renderPage: (route: ResolvedRoute, params: Record<string, string>) => Promise<string>;
  /** Optional: prerender PPR static shells (called when config.ppr is true) */
  prerenderPPRShell?: (route: ResolvedRoute, params: Record<string, string>) => Promise<string>;
  /** Loaded modules (file path -> module) — used to call generateStaticParams */
  modules?: Map<string, { generateStaticParams?: () => Promise<Record<string, string>[]> }>;
}

interface ExportResult {
  writtenFiles: string[];
  errors: Array<{ route: string; error: string }>;
  /** PPR static shells written (when config.ppr is true) */
  pprShells?: string[];
}

/**
 * Generates static HTML files for all SSR/SSG routes.
 * Dynamic routes with generateStaticParams are expanded.
 *
 * When config.ppr is true, also prerenders static shells for PPR routes.
 */
export async function generateStaticExport(options: StaticExportOptions): Promise<ExportResult> {
  const { config, routes, outputDir, renderPage, prerenderPPRShell, modules } = options;
  const writtenFiles: string[] = [];
  const errors: Array<{ route: string; error: string }> = [];
  const pprShells: string[] = [];

  for (const route of routes) {
    // Skip API routes and non-page routes
    if (route.mode === 'api' || route.isLayout || route.isNotFound) continue;

    // Skip routes that can't be statically exported
    if (route.mode === 'rsc') continue;

    try {
      const paths = await getStaticPaths(route, config, modules);

      if (paths.length === 0) {
        // Static route — render once
        await renderPage(route, {});
        const outPath = getOutputPath(route.pattern, outputDir);
        writtenFiles.push(outPath);

        // PPR: also prerender the static shell for SSR routes
        if (config.ppr && route.mode === 'ssr' && prerenderPPRShell) {
          try {
            const shellHtml = await prerenderPPRShell(route, {});
            const shellDir = join(config.rootDir, config.outDir, 'ppr-shells');
            const shellFile = join(shellDir, route.pattern.replace(/\//g, '_').replace(/^\//, '') + '.shell.html');
            mkdirSync(dirname(shellFile), { recursive: true });
            writeFileSync(shellFile, shellHtml);
            pprShells.push(shellFile);
          } catch {
            // PPR shell prerender failed — not fatal, route will use normal SSR
          }
        }
      } else {
        // Dynamic route — render for each param set
        for (const params of paths) {
          await renderPage(route, params);
          const outPath = getOutputPathWithParams(route.pattern, params, outputDir);
          writtenFiles.push(outPath);

          // PPR: also prerender the static shell for dynamic SSR routes
          if (config.ppr && route.mode === 'ssr' && prerenderPPRShell) {
            try {
              const shellHtml = await prerenderPPRShell(route, params);
              const shellDir = join(config.rootDir, config.outDir, 'ppr-shells');
              const paramSuffix = Object.values(params).join('_');
              const shellFile = join(shellDir, route.pattern.replace(/\//g, '_').replace(/^\//, '') + '_' + paramSuffix + '.shell.html');
              mkdirSync(dirname(shellFile), { recursive: true });
              writeFileSync(shellFile, shellHtml);
              pprShells.push(shellFile);
            } catch {
              // PPR shell prerender failed — not fatal
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        route: route.pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { writtenFiles, errors, pprShells };
}

/**
 * Gets static paths for a dynamic route by calling generateStaticParams.
 * Returns empty array for non-dynamic routes or routes without generateStaticParams.
 */
async function getStaticPaths(
  route: ResolvedRoute,
  _config: PledgeConfig,
  modules?: Map<string, { generateStaticParams?: () => Promise<Record<string, string>[]> }>,
): Promise<Record<string, string>[]> {
  // Only dynamic routes have generateStaticParams
  if (!route.filePath || !modules) return [];

  const pageModule = modules.get(route.filePath);
  if (!pageModule?.generateStaticParams) return [];

  try {
    const params = await pageModule.generateStaticParams();
    return Array.isArray(params) ? params : [];
  } catch {
    return [];
  }
}

/**
 * Converts a route pattern to an output file path.
 * e.g. '/about' -> 'about.html', '/' -> 'index.html'
 */
function getOutputPath(pattern: string, outputDir: string): string {
  if (pattern === '/' || pattern === '') {
    return `${outputDir}/index.html`;
  }
  const clean = pattern.replace(/^\//, '');
  return `${outputDir}/${clean}.html`;
}

/**
 * Converts a route pattern with params to an output file path.
 * e.g. '/blog/[slug]' with { slug: 'hello' } -> 'blog/hello.html'
 */
function getOutputPathWithParams(pattern: string, params: Record<string, string>, outputDir: string): string {
  let path = pattern;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`[${key}]`, value);
  }
  return getOutputPath(path, outputDir);
}

/**
 * Checks if a route can be statically exported.
 */
export function canStaticExport(route: ResolvedRoute): boolean {
  if (route.mode === 'api') return false;
  if (route.mode === 'rsc') return false;
  if (route.isLayout) return false;
  if (route.isNotFound) return false;

  // Routes with force-dynamic can't be exported
  if (route.metadata?.revalidate === 0) return false;

  return true;
}
