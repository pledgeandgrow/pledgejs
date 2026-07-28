import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  sourcemap: false,
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
    // Bundler adapters — inlined so they work without separate npm packages
    'pledgestack-bundler-pledgepack': join(__dirname, '..', '..', 'bundler-pledgepack', 'src', 'index.ts'),
    'pledgestack-bundler-vite': join(__dirname, '..', '..', 'bundler-vite', 'src', 'index.ts'),
    'pledgestack-bundler-rollup': join(__dirname, '..', '..', 'bundler-rollup', 'src', 'index.ts'),
    'pledgestack-bundler-turbopack': join(__dirname, '..', '..', 'bundler-turbopack', 'src', 'index.ts'),
    'pledgestack-bundler-rsbuild': join(__dirname, '..', '..', 'bundler-rsbuild', 'src', 'index.ts'),
    'pledgestack-bundler-webpack': join(__dirname, '..', '..', 'bundler-webpack', 'src', 'index.ts'),
  },
};

async function main() {
  // Clean dist
  await rm(outDir, { recursive: true, force: true });

  const { execSync } = await import('node:child_process');
  const packagesRoot = join(__dirname, '..', '..');

  // Build sub-packages (best-effort — esbuild bundles from source anyway)
  try {
    execSync('pnpm --filter pledgestack-shared --filter pledgestack-core --filter pledgestack-server --filter pledgestack-client --filter pledgestack-auth --filter pledgestack-state --filter pledgestack-api --filter pledgestack-a11y --filter pledgestack-overlay --filter pledgestack-seo --filter pledgestack-image --filter pledgestack-font --filter pledgestack-mdx --filter pledgestack-og --filter pledgestack-sitemap --filter pledgestack-rss --filter pledgestack-ws --filter pledgestack-adapters --filter pledgestack-privacy run build', {
      cwd: packagesRoot,
      stdio: 'inherit',
    });
  } catch {
    console.warn('Sub-package tsc build had errors — continuing with esbuild bundle (uses source aliases).');
  }

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

  console.log('Build complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
