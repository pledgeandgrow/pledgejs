import type { PledgeConfig } from 'pledgestack-shared';
import { resolveBundlerAdapter } from '../bundler-resolver';
import { startNodeServer, loadEnv } from 'pledgestack-server';
import { processTailwind } from '../tailwind';

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

  console.log(`  → ${bundlerName} dev server: http://${hostname}:${devServer.port}`);
  console.log(`  → PledgeStack SSR server:   http://${hostname}:${port}\n`);

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
