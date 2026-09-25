import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { finalizeTypes } from './finalize-types.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const outDir = join(__dirname, '..', 'dist');

const entryPoints = [
  { in: join(srcDir, 'bin.ts'), out: 'bin' },
  { in: join(srcDir, 'index.ts'), out: 'index' },
  { in: join(srcDir, 'server.ts'), out: 'server' },
  { in: join(srcDir, 'client.ts'), out: 'client' },
  { in: join(srcDir, 'auth.ts'), out: 'auth' },
  { in: join(srcDir, 'state.ts'), out: 'state' },
  { in: join(srcDir, 'api.ts'), out: 'api' },
  { in: join(srcDir, 'a11y.ts'), out: 'a11y' },
  { in: join(srcDir, 'overlay.ts'), out: 'overlay' },
  { in: join(srcDir, 'seo.ts'), out: 'seo' },
  { in: join(srcDir, 'image.ts'), out: 'image' },
  { in: join(srcDir, 'font.ts'), out: 'font' },
  { in: join(srcDir, 'mdx.ts'), out: 'mdx' },
  { in: join(srcDir, 'og.ts'), out: 'og' },
  { in: join(srcDir, 'sitemap.ts'), out: 'sitemap' },
  { in: join(srcDir, 'rss.ts'), out: 'rss' },
  { in: join(srcDir, 'ws.ts'), out: 'ws' },
  { in: join(srcDir, 'adapters.ts'), out: 'adapters' },
  { in: join(srcDir, 'privacy.ts'), out: 'privacy' },
];

const commonOptions = {
  bundle: true,
  format: 'esm',
  target: 'node20',
  platform: 'node',
  // Enable source maps for production debugging — previously disabled, making
  // CLI stack traces un-actionable in published npm installs.
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-dom/client',
    'react-server-dom-webpack',
    'esbuild',
    'jiti',
    'tailwindcss',
    '@tailwindcss/postcss',
    'postcss',
    'autoprefixer',
    'lightningcss',
    'pledgepack',
    // Optional database adapters (dynamically imported)
    'drizzle-orm/node-postgres',
    'drizzle-orm/mysql2',
    'drizzle-orm/better-sqlite3',
    'pg',
    'mysql2/promise',
    'better-sqlite3',
    'kysely',
    // Optional remote cache backends (dynamically imported)
    'redis',
    '@aws-sdk/client-s3',
    // Native addons (compiled at runtime by cargo)
    '*.node',
  ],
  alias: {
    'pledgestack-shared': join(__dirname, '..', '..', 'shared', 'src', 'index.ts'),
    'pledgestack-core': join(__dirname, '..', '..', 'core', 'src', 'index.ts'),
    'pledgestack-server': join(__dirname, '..', '..', 'server', 'src', 'index.ts'),
    'pledgestack-client': join(__dirname, '..', '..', 'client', 'src', 'index.ts'),
    'pledgestack-auth': join(__dirname, '..', '..', 'auth', 'src', 'index.ts'),
    'pledgestack-state': join(__dirname, '..', '..', 'state', 'src', 'index.ts'),
    'pledgestack-api': join(__dirname, '..', '..', 'api', 'src', 'index.ts'),
    'pledgestack-a11y': join(__dirname, '..', '..', 'a11y', 'src', 'index.ts'),
    'pledgestack-overlay': join(__dirname, '..', '..', 'overlay', 'src', 'index.ts'),
    'pledgestack-seo': join(__dirname, '..', '..', 'seo', 'src', 'index.ts'),
    'pledgestack-image': join(__dirname, '..', '..', 'image', 'src', 'index.ts'),
    'pledgestack-font': join(__dirname, '..', '..', 'font', 'src', 'index.ts'),
    'pledgestack-mdx': join(__dirname, '..', '..', 'mdx', 'src', 'index.ts'),
    'pledgestack-og': join(__dirname, '..', '..', 'og', 'src', 'index.ts'),
    'pledgestack-sitemap': join(__dirname, '..', '..', 'sitemap', 'src', 'index.ts'),
    'pledgestack-rss': join(__dirname, '..', '..', 'rss', 'src', 'index.ts'),
    'pledgestack-ws': join(__dirname, '..', '..', 'ws', 'src', 'index.ts'),
    'pledgestack-adapters': join(__dirname, '..', '..', 'adapters', 'src', 'index.ts'),
    'pledgestack-privacy': join(__dirname, '..', '..', 'privacy', 'src', 'index.ts'),
    // Renderer adapters — inlined (src/renderers.ts imports them for
    // side-effect registration) so user apps don't need unpublished
    // `pledgestack-renderer-*` packages installed.
    'pledgestack-renderer-react': join(__dirname, '..', '..', 'renderer-react', 'src', 'index.ts'),
    'pledgestack-renderer-vue': join(__dirname, '..', '..', 'renderer-vue', 'src', 'index.ts'),
    'pledgestack-renderer-solid': join(__dirname, '..', '..', 'renderer-solid', 'src', 'index.ts'),
    'pledgestack-renderer-svelte': join(__dirname, '..', '..', 'renderer-svelte', 'src', 'index.ts'),
    // Bundler adapters — inlined so they work without separate npm packages
    'pledgestack-bundler-pledgepack': join(__dirname, '..', '..', 'bundler-pledgepack', 'src', 'index.ts'),
    'pledgestack-bundler-vite': join(__dirname, '..', '..', 'bundler-vite', 'src', 'index.ts'),
  },
};

async function main() {
  // Clean dist
  await rm(outDir, { recursive: true, force: true });

  const { execSync } = await import('node:child_process');
  // Workspace packages are bundled from source via the aliases below, so their own
  // dist builds are NOT needed here. `pnpm build:packages` builds every public library
  // package (in dependency order) before this one, for publishing.

  // Bundle JS with esbuild (bundles from source via aliases)
  await build({
    ...commonOptions,
    entryPoints: entryPoints.map((e) => e.in),
    outdir: outDir,
    entryNames: '[name]',
  });

  // Generate type declarations (best-effort)
  try {
    execSync('tsc -p tsconfig.emit.json', {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
    });
  } catch {
    console.warn('Type declaration generation had errors — dist JS is still valid.');
  }

  // Make the declarations consumable: relative workspace imports + entry .d.ts files.
  finalizeTypes(outDir, entryPoints.map((e) => e.out));

  console.log('Build complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
