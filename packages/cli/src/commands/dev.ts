import type { PledgeConfig } from 'pledgestack-shared';
import { resolveBundlerAdapter } from '../bundler-resolver';
import { startNodeServer, loadEnv } from 'pledgestack-server';
import { processTailwind } from '../tailwind';
import { assertEnv } from 'pledgestack-shared';

const DEFAULT_BUNDLER_PORT = 3001;

/**
 * Starts the development server.
 *
 * The configured bundler's dev server handles:
 *   - Module transformation (TSX→JS)
 *   - HMR via WebSocket with error overlay
 *   - CSS HMR
 *   - Import maps for bare specifiers
 *   - CJS→ESM interop for node_modules
 *   - File watching and incremental rebuilds
 *
 * PledgeStack's Node.js server handles:
 *   - SSR (React renderToString)
 *   - API routes
 *   - Middleware execution
 *   - Server actions
 *
 * Module/asset/HMR requests are proxied to the bundler's dev server.
 */
export async function devCommand(options: { port?: number; hostname?: string } = {}): Promise<void> {
  const { loadConfig } = await import('../config-loader');
  let config: PledgeConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('\n  ✖ Failed to load configuration:\n');
    console.error(`    ${err}\n`);
    process.exit(1);
  }

  loadEnv(config.rootDir, 'development');

  // Validate required env vars before starting dev — fail fast with a clear
  // error instead of crashing on the first request that needs a missing var (#49).
  if (config.envSchema) {
    try {
      assertEnv(config.envSchema);
    } catch (err) {
      console.error('\n  ✖ Environment validation failed:\n');
      console.error(`    ${err}\n`);
      process.exit(1);
    }
  }

  const port = options.port ?? 3000;
  const hostname = options.hostname ?? 'localhost';
  const bundlerPort = config.pledgepack?.devServer?.port ?? DEFAULT_BUNDLER_PORT;

  console.log('\n  PledgeStack — Starting dev server...\n');

  if (config.tailwind) {
    await processTailwind({ config });
  }

  // Start the configured bundler's dev server
  const bundlerName = config.bundler ?? 'pledgepack';
  console.log(`  → Starting ${bundlerName} dev server...`);

  const adapter = await resolveBundlerAdapter(bundlerName);
  const devServer = await adapter.startDevServer(config, {
    port,
    bundlerPort,
    hostname,
  });

  // The bundler port is internal (module transforms/HMR only) — opening it in
  // a browser shows a bare client-only shell, so don't present it as a URL.
  console.log(`  → ${bundlerName} ready (internal port ${devServer.port})`);

  // Start PledgeStack's Node.js SSR server
  startNodeServer({
    config,
    port,
    hostname,
    isDev: true,
    pledgepackPort: devServer.port,
    adapter,
  });
}

export type { PledgeConfig };
