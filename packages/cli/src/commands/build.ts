import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';
import { resolveBundlerAdapter } from '../bundler-resolver';
import { scanAppDir, resolveRoutes, generateStaticPages, generateStaticExport, renderSSR, buildAllTargets, writeRouteTypes, detectRouteConflicts, formatRouteConflicts } from 'pledgestack-core';
import { createModuleLoader, loadEnv } from 'pledgestack-server';
import { processTailwind, ensureTailwindConfig } from '../tailwind';

/**
 * Builds the project for production.
 *
 * 1. Runs the configured bundler (PledgePack by default, or Vite/Rollup/Turbopack/Rsbuild/Webpack)
 *    to produce optimized JS output with transforms, tree shaking, and code splitting.
 * 2. Scans routes and loads bundled modules (from .pledge/ output).
 * 3. Generates static pages (SSG) using the pre-bundled modules.
 * 4. Copies public assets.
 */
export async function buildCommand(opts?: { crossCompile?: boolean }): Promise<void> {
  const { loadConfig } = await import('../config-loader');
  const config = await loadConfig();

  loadEnv(config.rootDir, 'production');

  console.log('\n  PledgeStack — Building for production...\n');

  // 1. Run the configured bundler
  const bundlerName = config.bundler ?? 'pledgepack';
  console.log(`  → Running ${bundlerName} bundler...`);
  const adapter = await resolveBundlerAdapter(bundlerName);
  const result = await adapter.build(config);
  if (!result.success) {
    console.error(`  ✗ ${bundlerName} build failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`  ✓ Bundle complete (${result.durationMs}ms)\n`);

  // 2. Scan routes
  const appDir = join(config.rootDir, config.appDir);
  const files = await scanAppDir(appDir);
  const routes = resolveRoutes(files, config);

  console.log(`  Found ${routes.length} routes`);

  // #234: Check for route conflicts
  const conflicts = detectRouteConflicts(routes);
  if (conflicts.length > 0) {
    console.warn(formatRouteConflicts(conflicts));
  }

  // #221: Generate route types
  await writeRouteTypes(config);
  console.log('  ✓ Generated route types');

  // 3. Create output directory
  const outDir = join(config.rootDir, config.outDir);
  await mkdir(outDir, { recursive: true });

  // 4. Process Tailwind CSS
  if (config.tailwind) {
    await ensureTailwindConfig(config.rootDir);
    await processTailwind({ config });
  }

  // 5. Load all bundled modules for SSG (reads from .pledge/ output, not esbuild)
  const moduleLoader = createModuleLoader(config, false, undefined, adapter);
  const modules = await moduleLoader.loadAll(routes);

  // 6. Generate static pages or full static export
  if (config.output === 'export') {
    console.log('  → Generating static export...');
    const { createRouter } = await import('pledgestack-core');
    const router = createRouter(routes, config);
    const result = await generateStaticExport({
      config,
      routes,
      outputDir: outDir,
      renderPage: async (route, params) => {
        const match = router.match(route.pattern);
        if (!match) throw new Error(`No match for route: ${route.pattern}`);
        const html = await renderSSR({
          config,
          match: { ...match, params },
          tree: router.tree,
          modules: modules as Map<string, import('pledgestack-core').PageModule>,
        });
        const filePath = join(outDir, route.pattern === '/' ? 'index.html' : `${route.pattern.replace(/^\//, '')}.html`);
        await mkdir(join(filePath, '..'), { recursive: true });
        await writeFile(filePath, html);
        return html;
      },
    });

    for (const file of result.writtenFiles) {
      console.log(`  ✓ Exported: ${file}`);
    }
    for (const err of result.errors) {
      console.error(`  ✗ Failed: ${err.route} — ${err.error}`);
    }
    console.log(`  ✓ Static export complete: ${result.writtenFiles.length} pages\n`);
  } else {
    const staticPages = await generateStaticPages({
      config,
      routes,
      modules: modules as Map<string, import('pledgestack-core').PageModule>,
    });

    for (const [path, html] of staticPages) {
      const filePath = join(outDir, path === '/' ? 'index.html' : `${path}.html`);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, html);
      console.log(`  ✓ Generated: ${path}`);
    }
  }

  // 7. Copy public directory
  await copyPublicDir(config);

  // 8. Cross-compile Rust addons for all platforms (#218)
  if (opts?.crossCompile) {
    console.log('\n  → Cross-compiling Rust addons for all targets...');
    const cargoDir = join(config.rootDir, '.pledge', 'cargo');
    const distDir = join(config.rootDir, config.outDir, 'dist');
    const { results } = await buildAllTargets(config.rootDir, cargoDir, distDir);

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    console.log(`  ✓ ${succeeded} target(s) built successfully`);
    if (failed > 0) {
      console.error(`  ✗ ${failed} target(s) failed`);
    }
    console.log(`  ✓ Manifest written to ${join(distDir, 'manifest.json')}`);
  }

  console.log('\n  Build complete!\n');
}

async function copyPublicDir(config: PledgeConfig): Promise<void> {
  const publicDir = join(config.rootDir, config.publicDir);
  const outPublic = join(config.rootDir, config.outDir, 'public');

  async function copyDir(src: string, dest: string): Promise<number> {
    let count = 0;
    const entries = await readdir(src, { withFileTypes: true });
    await mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        count += await copyDir(srcPath, destPath);
      } else {
        await copyFile(srcPath, destPath);
        count++;
      }
    }
    return count;
  }

  try {
    const total = await copyDir(publicDir, outPublic);
    console.log(`  ✓ Copied ${total} public assets`);
  } catch {
    // No public directory — skip
  }
}
