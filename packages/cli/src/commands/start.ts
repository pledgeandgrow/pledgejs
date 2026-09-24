import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startNodeServer, loadEnv, reportProductionPosture } from 'pledgestack-server';
import { resolveBundlerAdapter } from '../bundler-resolver';
import { assertEnv } from 'pledgestack-shared';

/**
 * Starts the production server.
 *
 * For the default 'pledgepack' bundler, tries PledgePack's Rust production
 * server (`pledge serve`) first — it's an Axum/Hyper-based HTTP server with
 * high throughput, gzip/brotli compression, and static file serving.
 *
 * For other bundlers (vite, rollup, turbopack, rsbuild, webpack) or when the PledgePack binary
 * is not available, falls back to PledgeStack's Node.js server with the
 * configured bundler adapter for module resolution.
 */
export async function startCommand(options: { port?: number; hostname?: string } = {}): Promise<void> {
  const { loadConfig } = await import('../config-loader');
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('\n  ✖ Failed to load configuration:\n');
    console.error(`    ${err}\n`);
    process.exit(1);
  }

  const port = options.port ?? 3000;
  const hostname = options.hostname ?? 'localhost';

  loadEnv(config.rootDir, 'production');

  // `pledge start` is production context by definition — default NODE_ENV so
  // error pages and security checks don't fall back to dev behavior.
  process.env.NODE_ENV ||= 'production';

  // Fail-loud on production-unsafe config (disabled CSRF/headers, wildcard
  // CORS with credentials, …). Warnings only — never blocks startup.
  reportProductionPosture(config);

  // Validate required env vars before starting — fail fast with a clear error
  // instead of crashing at the first request that needs a missing var (#49).
  if (config.envSchema) {
    try {
      assertEnv(config.envSchema);
    } catch (err) {
      console.error('\n  ✖ Environment validation failed:\n');
      console.error(`    ${err}\n`);
      process.exit(1);
    }
  }

  console.log('\n  PledgeStack — Starting production server...\n');

  const bundlerName = config.bundler ?? 'pledgepack';

  // For pledgepack, try the native Rust production server first — but only
  // when the app has no API routes: `pledge serve` is a static file server
  // and cannot execute route handlers.
  if (bundlerName === 'pledgepack') {
    const { resolveBinary, runPledgepack } = await import('pledgestack-bundler-pledgepack');
    const binary = resolveBinary();

    let hasApiRoutes = false;
    try {
      const { scanAppDir, resolveRoutes } = await import('pledgestack-core');
      const appPath = join(config.rootDir, config.appDir);
      if (existsSync(appPath)) {
        const routes = resolveRoutes(await scanAppDir(appPath), config);
        hasApiRoutes = routes.some((r) => r.mode === 'api');
      }
    } catch {
      // Scan failure shouldn't block startup — assume API routes may exist
      hasApiRoutes = true;
    }

    if (binary && hasApiRoutes) {
      console.log('  → API routes detected — using Node.js server (PledgePack serve is static-only)\n');
    } else if (binary) {
      console.log('  → Using PledgePack Rust production server (axum/hyper)\n');
      await runPledgepack([
        'serve',
        '--port', String(port),
        '--host', hostname,
        '--out-dir', config.outDir,
      ]);
      return;
    } else {
      console.warn('  ⚠ PledgePack binary not found — falling back to Node.js server');
      console.warn('  For best performance, install pledgepack: npm install pledgepack\n');
    }
  } else {
    console.log(`  → Using ${bundlerName} bundler with Node.js server\n`);
  }

  // Resolve the adapter for module loading
  const adapter = await resolveBundlerAdapter(bundlerName);

  startNodeServer({
    config,
    port,
    hostname,
    isDev: false,
    adapter,
  });
}
