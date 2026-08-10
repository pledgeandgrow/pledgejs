import { startNodeServer } from 'pledgestack-server';
import { resolveBundlerAdapter } from '../bundler-resolver';

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

  console.log('\n  PledgeStack — Starting production server...\n');

  const bundlerName = config.bundler ?? 'pledgepack';

  // For pledgepack, try the native Rust production server first
  if (bundlerName === 'pledgepack') {
    const { resolveBinary, runPledgepack } = await import('pledgestack-bundler-pledgepack');
    const binary = resolveBinary();
    if (binary) {
      console.log('  → Using PledgePack Rust production server (axum/hyper)\n');
      await runPledgepack([
        'serve',
        '--port', String(port),
        '--host', hostname,
        '--out-dir', config.outDir,
      ]);
      return;
    }
    console.warn('  ⚠ PledgePack binary not found — falling back to Node.js server');
    console.warn('  For best performance, install pledgepack: npm install pledgepack\n');
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
