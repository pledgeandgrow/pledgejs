import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';
import { PluginRunner } from 'pledgestack-shared';
import { resolveBundlerAdapter } from '../bundler-resolver';
import { scanAppDir, resolveRoutes, generateStaticPages, generateStaticExport, renderSSR, buildAllTargets, writeRouteTypes, detectRouteConflicts, formatRouteConflicts } from 'pledgestack-core';
import { createModuleLoader, loadEnv, reportProductionPosture, computeAssetIntegrity } from 'pledgestack-server';
import { processTailwind, ensureTailwindConfig } from '../tailwind';
import { assertEnv } from 'pledgestack-shared';

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
  let config: PledgeConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('\n  ✖ Failed to load configuration:\n');
    console.error(`    ${err}\n`);
    process.exit(1);
  }

  loadEnv(config.rootDir, 'production');

  // Fail-loud on production-unsafe config (disabled CSRF/headers, wildcard
  // CORS with credentials, …). Warnings only — never blocks the build.
  reportProductionPosture(config);

  // The PLEDGE_PUBLIC_ gate controls which vars reach the client bundle —
  // it does not inspect their contents. A public var holding a live
  // credential is a leak regardless of the prefix, so warn on values that
  // match known secret patterns.
  try {
    const { getPublicEnv, matchSecretPatterns } = await import('pledgestack-server');
    for (const [key, value] of Object.entries(getPublicEnv())) {
      const matches = matchSecretPatterns(value);
      if (matches.length > 0) {
        console.warn(
          `  ⚠ PLEDGE_PUBLIC_${key} looks like a secret (${matches.map((m) => m.type).join(', ')}) — ` +
            `it will be embedded in the client bundle and visible to every visitor.`,
        );
      }
    }
  } catch {
    // Best-effort warning — never block the build on it.
  }

  // Validate required env vars before building — fail fast with a clear error
  // instead of crashing mid-build when a missing DATABASE_URL is first accessed (#49).
  if (config.envSchema) {
    try {
      assertEnv(config.envSchema);
    } catch (err) {
      console.error('\n  ✖ Environment validation failed:\n');
      console.error(`    ${err}\n`);
      process.exit(1);
    }
  }

  console.log('\n  PledgeStack — Building for production...\n');

  // Run plugin buildStart hooks
  const pluginRunner = new PluginRunner(config.plugins ?? []);
  await pluginRunner.runBuildStart(config);

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
  // SRI hashes for framework-emitted assets — static HTML carries
  // integrity="sha384-…" on /__pledge__/* script/link tags so a tampered
  // asset can't execute. (No CSP nonce on static pages — a nonce frozen
  // into shared markup is worthless.)
  let buildFailed = false;
  let assetIntegrity: Record<string, string> = {};
  try {
    assetIntegrity = await computeAssetIntegrity(config, false);
  } catch {
    // Best-effort — never fail the build on hashing.
  }
  const { applyScriptSecurity, findExternalAssetsWithoutIntegrity } = await import('pledgestack-core');
  // Third-party <script src>/<link href> without integrity execute with full
  // page privilege if that CDN is compromised — collect flagged URLs across
  // all emitted pages and warn once at the end.
  const unprotectedExternalAssets = new Set<string>();
  const stampSri = (html: string) => {
    for (const url of findExternalAssetsWithoutIntegrity(html)) {
      unprotectedExternalAssets.add(url);
    }
    return applyScriptSecurity(html, { assetIntegrity });
  };

  if (config.output === 'export') {
    console.log('  → Generating static export...');
    const { createRouter } = await import('pledgestack-core');
    const router = createRouter(routes, config);
    const result = await generateStaticExport({
      config,
      routes,
      outputDir: outDir,
      modules: modules as Map<string, { generateStaticParams?: () => Promise<Record<string, string>[]> }>,
      // Render only — generateStaticExport writes the HTML to the correct,
      // param-substituted path itself (this callback must not write, or dynamic
      // routes collide on a literal `:slug.html`).
      renderPage: async (route, params) => {
        const match = router.match(route.pattern);
        if (!match) throw new Error(`No match for route: ${route.pattern}`);
        const html = await renderSSR({
          config,
          match: { ...match, params },
          tree: router.tree,
          modules: modules as Map<string, import('pledgestack-core').PageModule>,
        });
        return stampSri(html);
      },
    });

    for (const file of result.writtenFiles) {
      console.log(`  ✓ Exported: ${file}`);
    }
    for (const err of result.errors) {
      console.error(`  ✗ Failed: ${err.route} — ${err.error}`);
    }
    if (result.errors.length > 0) {
      // A route that failed to render is a missing page in the deployed site —
      // do not report success (CI would ship it).
      buildFailed = true;
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
      await writeFile(filePath, stampSri(html));
      console.log(`  ✓ Generated: ${path}`);
    }
  }

  // 7. Copy public directory
  await copyPublicDir(config);

  if (unprotectedExternalAssets.size > 0) {
    console.warn('\n  ⚠ External subresources without integrity attributes:');
    for (const url of [...unprotectedExternalAssets].slice(0, 10)) {
      console.warn(`    ${url}`);
    }
    if (unprotectedExternalAssets.size > 10) {
      console.warn(`    … and ${unprotectedExternalAssets.size - 10} more`);
    }
    console.warn('    Add integrity="sha384-…" or self-host — a compromised CDN would execute with full page privilege.');
  }

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

  // Run plugin buildEnd hooks
  await pluginRunner.runBuildEnd(config);

  // Generate SBOM for supply chain security
  try {
    const { writeSBOM } = await import('pledgestack-server');
    const sbomPath = writeSBOM(config.rootDir, join(config.rootDir, config.outDir));
    console.log(`  ✓ SBOM written to ${sbomPath}`);
  } catch (err) {
    console.warn(`  ⚠ SBOM generation failed: ${err}`);
  }

  // Zero-config supply-chain pass: secret scan + license compliance. Nobody
  // enables these voluntarily — they run on every build. 'warn' (default)
  // prints findings; 'strict' fails the build; 'off' skips entirely.
  const supplyChainMode = config.supplyChain ?? 'warn';
  if (supplyChainMode !== 'off') {
    try {
      const { scanForSecrets, checkLicenseCompliance } = await import('pledgestack-server');
      let findings = 0;

      const secrets = scanForSecrets(config.rootDir);
      if (!secrets.passed) {
        findings += secrets.findings.length;
        console.warn(`\n  ⚠ Supply chain: ${secrets.findings.length} possible secret(s) in source files:`);
        for (const f of secrets.findings.slice(0, 10)) {
          console.warn(`    ${f.file}:${f.line} — ${f.type} (${f.severity})`);
        }
        if (secrets.findings.length > 10) {
          console.warn(`    … and ${secrets.findings.length - 10} more`);
        }
      }

      // Also scan the emitted bundle — inlining can bake a credential into
      // the shipped JS even when the source pattern didn't match (e.g. an
      // env value interpolated at build time).
      const bundleSecrets = scanForSecrets(join(config.rootDir, config.outDir), {
        extensions: ['.js', '.mjs', '.cjs', '.html', '.css'],
      });
      if (!bundleSecrets.passed) {
        findings += bundleSecrets.findings.length;
        console.warn(`\n  ⚠ Supply chain: ${bundleSecrets.findings.length} possible secret(s) in the EMITTED bundle:`);
        for (const f of bundleSecrets.findings.slice(0, 10)) {
          console.warn(`    ${f.file}:${f.line} — ${f.type} (${f.severity})`);
        }
        if (bundleSecrets.findings.length > 10) {
          console.warn(`    … and ${bundleSecrets.findings.length - 10} more`);
        }
      }

      const licenses = checkLicenseCompliance(config.rootDir);
      if (!licenses.passed) {
        findings += licenses.violations.length;
        console.warn(`\n  ⚠ Supply chain: ${licenses.violations.length} license violation(s):`);
        for (const v of licenses.violations.slice(0, 10)) {
          console.warn(`    ${v.packageName}@${v.version} — ${v.license} (${v.category})`);
        }
      }

      if (findings > 0 && supplyChainMode === 'strict') {
        console.error(`\n  ✗ Supply chain check failed in strict mode (${findings} finding(s))\n`);
        process.exit(1);
      }
    } catch (err) {
      console.warn(`  ⚠ Supply chain scan failed: ${err}`);
    }
  }

  // Purge CDN cache if configured
  if (config.cdn) {
    const paths = config.cdn.paths ?? [];
    if (paths.length === 0) {
      console.warn('  ⚠ CDN purge skipped: no cdn.paths configured');
    } else {
      try {
        const { purgeCache } = await import('pledgestack-server');
        const result = await purgeCache(paths, config.cdn);
        if (result.success) {
          console.log(`  ✓ CDN cache purged (${result.purged} path${result.purged === 1 ? '' : 's'})`);
        } else {
          console.warn(`  ⚠ CDN purge failed: ${result.errors?.join(', ') ?? 'unknown error'}`);
        }
      } catch (err) {
        console.warn(`  ⚠ CDN purge failed: ${err}`);
      }
    }
  }

  if (buildFailed) {
    console.error('\n  ✗ Build finished with errors (see failed routes above).\n');
    process.exit(1);
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
  } catch (err) {
    // A missing public directory is fine; anything else (permissions, a failed
    // copy) would silently ship a site without its assets.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
