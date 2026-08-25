/**
 * pledge init — Add PledgeStack to an existing project.
 *
 * Goal #229: Detect existing framework (Next.js, Vite, CRA, Express),
 * convert routes to app/ directory, migrate config, set up tsconfig,
 * and install dependencies.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

type DetectedFramework = 'nextjs' | 'vite' | 'cra' | 'express' | 'unknown';

interface InitOptions {
  force?: boolean;
  skipInstall?: boolean;
}

async function fetchLatestVersion(pkgName: string): Promise<string> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`);
    if (!res.ok) return 'latest';
    const data = (await res.json()) as { version?: string };
    return data.version ? `^${data.version}` : 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * Detects the existing framework by checking for config files and dependencies.
 */
async function detectFramework(rootDir: string): Promise<DetectedFramework> {
  // Check for next.config.{js,ts,mjs}
  for (const ext of ['js', 'ts', 'mjs']) {
    if (existsSync(join(rootDir, `next.config.${ext}`))) return 'nextjs';
  }

  // Check package.json for framework dependencies
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) return 'nextjs';
      if (deps['vite'] && deps['@vitejs/plugin-react']) return 'vite';
      if (deps['react-scripts']) return 'cra';
      if (deps['express'] && !deps['next']) return 'express';
    } catch {
      // Fall through
    }
  }

  // Check for vite.config
  for (const ext of ['js', 'ts', 'mjs']) {
    if (existsSync(join(rootDir, `vite.config.${ext}`))) return 'vite';
  }

  // Check for public/index.html (CRA)
  if (existsSync(join(rootDir, 'public', 'index.html'))) return 'cra';

  return 'unknown';
}

/**
 * Checks if PledgeStack is already initialized.
 */
async function isAlreadyInitialized(rootDir: string): Promise<boolean> {
  return existsSync(join(rootDir, 'pledge.config.ts')) ||
         existsSync(join(rootDir, 'pledge.config.js')) ||
         existsSync(join(rootDir, 'pledgestack.config.ts'));
}

/**
 * Migrates Next.js pages/ routes to PledgeStack app/ directory.
 * Maps: pages/index.tsx → app/page.tsx, pages/[slug].tsx → app/[slug]/page.tsx
 */
async function migrateNextJsRoutes(rootDir: string): Promise<string[]> {
  const pagesDir = join(rootDir, 'pages');
  const appDir = join(rootDir, 'app');
  const migrated: string[] = [];

  if (!existsSync(pagesDir)) return migrated;

  await mkdir(appDir, { recursive: true });

  async function walk(srcDir: string, destDir: string) {
    const entries = await readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);

      if (entry.isDirectory()) {
        // Skip api routes — they become route.ts in PledgeStack
        if (entry.name === 'api') {
          const apiDest = join(destDir, 'api');
          await mkdir(apiDest, { recursive: true });
          await walk(srcPath, apiDest);
          continue;
        }

        // Convert [slug] directory names (same convention)
        const destName = entry.name;
        const destPath = join(destDir, destName);
        await mkdir(destPath, { recursive: true });
        await walk(srcPath, destPath);
      } else if (entry.isFile()) {
        const baseName = entry.name.replace(/\.(tsx|ts|jsx|js)$/, '');

        // index.tsx → page.tsx
        if (baseName === 'index') {
          const destPath = join(destDir, 'page.tsx');
          await copyAndConvertRoute(srcPath, destPath);
          migrated.push(`pages/${relativePath(rootDir, srcPath)} → app/${relativePath(rootDir, destPath)}`);
        }
        // [slug].tsx → [slug]/page.tsx
        else if (baseName.startsWith('[') && baseName.endsWith(']')) {
          const paramDir = join(destDir, baseName);
          await mkdir(paramDir, { recursive: true });
          const destPath = join(paramDir, 'page.tsx');
          await copyAndConvertRoute(srcPath, destPath);
          migrated.push(`pages/${relativePath(rootDir, srcPath)} → app/${relativePath(rootDir, destPath)}`);
        }
        // _app.tsx → layout.tsx
        else if (baseName === '_app') {
          const destPath = join(destDir, 'layout.tsx');
          await convertAppToLayout(srcPath, destPath);
          migrated.push(`pages/_app.tsx → app/layout.tsx`);
        }
        // _document.tsx → skip (PledgeStack handles HTML shell)
        else if (baseName === '_document') {
          migrated.push(`pages/_document.tsx → skipped (PledgeStack handles HTML shell)`);
        }
        // api routes: file.ts → route.ts
        else if (destDir.includes('api')) {
          const destPath = join(destDir, 'route.ts');
          await copyAndConvertRoute(srcPath, destPath);
          migrated.push(`pages/${relativePath(rootDir, srcPath)} → app/${relativePath(rootDir, destPath)}`);
        }
        // Other files: about.tsx → about/page.tsx
        else {
          const routeDir = join(destDir, baseName);
          await mkdir(routeDir, { recursive: true });
          const destPath = join(routeDir, 'page.tsx');
          await copyAndConvertRoute(srcPath, destPath);
          migrated.push(`pages/${relativePath(rootDir, srcPath)} → app/${relativePath(rootDir, destPath)}`);
        }
      }
    }
  }

  await walk(pagesDir, appDir);
  return migrated;
}

/**
 * Copies a route file and converts Next.js patterns to PledgeStack.
 */
async function copyAndConvertRoute(srcPath: string, destPath: string): Promise<void> {
  let content = await readFile(srcPath, 'utf-8');

  // Convert next/router → pledge navigation
  content = content.replace(/from\s+['"]next\/router['"]/g, "from 'pledgestack/router'");
  content = content.replace(/from\s+['"]next\/navigation['"]/g, "from 'pledgestack/router'");
  content = content.replace(/useRouter\(\)/g, 'useRouter()');

  // Convert next/image → native img
  content = content.replace(/from\s+['"]next\/image['"]/g, '');
  content = content.replace(/<Image\s/g, '<img ');

  // Convert next/link → pledge Link
  content = content.replace(/from\s+['"]next\/link['"]/g, "from 'pledgestack/router'");

  // Remove getServerSideProps/getStaticProps — PledgeStack uses server components
  content = content.replace(/export\s+(?:async\s+)?function\s+getServerSideProps[\s\S]*?\n\}/g, '// TODO: Convert to server component (data fetching in component body)');
  content = content.replace(/export\s+(?:async\s+)?function\s+getStaticProps[\s\S]*?\n\}/g, '// TODO: Convert to server component with generateStaticParams');

  await mkdir(join(destPath, '..'), { recursive: true });
  await writeFile(destPath, content, 'utf-8');
}

/**
 * Converts _app.tsx to layout.tsx format.
 */
async function convertAppToLayout(srcPath: string, destPath: string): Promise<void> {
  let content = await readFile(srcPath, 'utf-8');

  // Remove NextApp import and wrapper
  content = content.replace(/import\s+type\s*\{[^}]*AppType[^}]*\}\s+from\s+['"]next\/app['"]/g, '');
  content = content.replace(/import\s+\{[^}]*\}\s+from\s+['"]next\/app['"]/g, '');

  // Replace function signature
  content = content.replace(
    /export\s+default\s+function\s+\w+\s*\(\s*\{[^}]*\}\s*:\s*AppProps\s*\)/g,
    'export default function RootLayout({ children }: { children: React.ReactNode })',
  );

  // Remove Component prop usage
  content = content.replace(/<Component\s+\{?\.\.\.pageProps\}?\s*\/>/g, '{children}');
  content = content.replace(/<Component\s+\/>/g, '{children}');

  await mkdir(join(destPath, '..'), { recursive: true });
  await writeFile(destPath, content, 'utf-8');
}

/**
 * Migrates Vite/CRA src/ routes to app/ directory.
 */
async function migrateViteRoutes(rootDir: string): Promise<string[]> {
  const srcDir = join(rootDir, 'src');
  const appDir = join(rootDir, 'app');
  const migrated: string[] = [];

  if (!existsSync(srcDir)) return migrated;

  // Move App.tsx → app/page.tsx
  const appFiles = ['App.tsx', 'App.jsx', 'App.ts', 'App.js'];
  for (const appFile of appFiles) {
    const srcPath = join(srcDir, appFile);
    if (existsSync(srcPath)) {
      await mkdir(appDir, { recursive: true });
      await copyAndConvertRoute(srcPath, join(appDir, 'page.tsx'));
      migrated.push(`src/${appFile} → app/page.tsx`);
      break;
    }
  }

  // Move main.tsx → layout.tsx (if it wraps App)
  const mainFiles = ['main.tsx', 'main.jsx', 'index.tsx', 'index.jsx'];
  for (const mainFile of mainFiles) {
    const srcPath = join(srcDir, mainFile);
    if (existsSync(srcPath)) {
      const content = await readFile(srcPath, 'utf-8');
      if (content.includes('createRoot') || content.includes('ReactDOM.render')) {
        // Create a basic layout from the root element
        await mkdir(appDir, { recursive: true });
        await writeFile(join(appDir, 'layout.tsx'), LAYOUT_TEMPLATE, 'utf-8');
        migrated.push(`src/${mainFile} → app/layout.tsx (created from root element)`);
        break;
      }
    }
  }

  return migrated;
}

const LAYOUT_TEMPLATE = `import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`;

/**
 * Creates pledge.config.ts for the project.
 */
async function createPledgeConfig(rootDir: string, _framework: DetectedFramework): Promise<void> {
  const configPath = join(rootDir, 'pledge.config.ts');

  if (existsSync(configPath)) return;

  const config = `import { defineConfig } from 'pledgestack';

export default defineConfig({
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  rsc: true,
  tailwind: true,
});
`;

  await writeFile(configPath, config, 'utf-8');
}

/**
 * Updates package.json with PledgeStack scripts and dependencies.
 */
async function updatePackageJson(rootDir: string): Promise<void> {
  const pkgPath = join(rootDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

  // Add scripts
  pkg.scripts = pkg.scripts ?? {};
  pkg.scripts.dev = 'pledge dev';
  pkg.scripts.build = 'pledge build';
  pkg.scripts.start = 'pledge start';

  // Add dependencies
  pkg.dependencies = pkg.dependencies ?? {};
  if (!pkg.dependencies['react']) pkg.dependencies['react'] = '^19.0.0';
  if (!pkg.dependencies['react-dom']) pkg.dependencies['react-dom'] = '^19.0.0';

  // Add devDependencies
  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.devDependencies['pledgestack'] = await fetchLatestVersion('pledgestack');
  pkg.devDependencies['pledgepack'] = await fetchLatestVersion('pledgepack');
  if (!pkg.devDependencies['@types/react']) pkg.devDependencies['@types/react'] = '^19.0.0';
  if (!pkg.devDependencies['@types/react-dom']) pkg.devDependencies['@types/react-dom'] = '^19.0.0';
  if (!pkg.devDependencies['typescript']) pkg.devDependencies['typescript'] = '^5.7.0';

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

/**
 * Updates .gitignore with PledgeStack entries.
 */
async function updateGitignore(rootDir: string): Promise<void> {
  const gitignorePath = join(rootDir, '.gitignore');
  let content = '';

  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  const entries = ['.pledge/', '.pledge-cache/', '*.tsbuildinfo'];
  const missing = entries.filter((e) => !content.includes(e));

  if (missing.length > 0) {
    content += `\n# PledgeStack\n${missing.join('\n')}\n`;
    await writeFile(gitignorePath, content, 'utf-8');
  }
}

function relativePath(root: string, abs: string): string {
  // Use path.relative so this works on Windows too. The previous
  // `abs.replace(root + '/', '')` never matched on Windows, where both paths
  // use backslashes, so it printed full absolute paths in migration logs.
  return relative(root, abs).replace(/\\/g, '/');
}

/**
 * Runs the init command — adds PledgeStack to an existing project.
 */
export async function initCommand(opts: InitOptions = {}): Promise<void> {
  const rootDir = process.cwd();

  console.log('\n  PledgeStack — Initializing in existing project...\n');

  // Check if already initialized
  if (!opts.force && await isAlreadyInitialized(rootDir)) {
    console.error('  Error: PledgeStack is already initialized in this project.');
    console.error('  Use --force to reinitialize.\n');
    process.exit(1);
  }

  // Detect framework
  const framework = await detectFramework(rootDir);
  console.log(`  Detected framework: ${framework === 'unknown' ? 'none (plain project)' : framework}`);

  // Migrate routes
  let migrated: string[] = [];
  if (framework === 'nextjs') {
    console.log('  → Migrating Next.js routes...');
    migrated = await migrateNextJsRoutes(rootDir);
  } else if (framework === 'vite' || framework === 'cra') {
    console.log('  → Migrating Vite/CRA routes...');
    migrated = await migrateViteRoutes(rootDir);
  } else {
    // Create empty app/ directory
    console.log('  → Creating app/ directory...');
    await mkdir(join(rootDir, 'app'), { recursive: true });

    // Create default page if none exists
    if (!existsSync(join(rootDir, 'app', 'page.tsx'))) {
      await writeFile(join(rootDir, 'app', 'page.tsx'), `export default function HomePage() {
  return (
    <main>
      <h1>Welcome to PledgeStack</h1>
      <p>Get started by editing <code>app/page.tsx</code></p>
    </main>
  );
}
`, 'utf-8');
    }

    // Create default layout if none exists
    if (!existsSync(join(rootDir, 'app', 'layout.tsx'))) {
      await writeFile(join(rootDir, 'app', 'layout.tsx'), LAYOUT_TEMPLATE, 'utf-8');
    }
  }

  if (migrated.length > 0) {
    console.log(`\n  Migrated ${migrated.length} route${migrated.length > 1 ? 's' : ''}:`);
    for (const m of migrated) {
      console.log(`    ✓ ${m}`);
    }
  }

  // Create pledge.config.ts
  console.log('  → Creating pledge.config.ts...');
  await createPledgeConfig(rootDir, framework);
  console.log('    ✓ pledge.config.ts');

  // Update package.json
  console.log('  → Updating package.json...');
  await updatePackageJson(rootDir);
  console.log('    ✓ scripts and dependencies added');

  // Update .gitignore
  console.log('  → Updating .gitignore...');
  await updateGitignore(rootDir);
  console.log('    ✓ PledgeStack entries added');

  // Sync tsconfig aliases (#231)
  console.log('  → Syncing tsconfig.json path aliases...');
  try {
    const { syncAliasesCommand } = await import('./sync-aliases');
    const { loadConfig } = await import('../config-loader');
    const config = await loadConfig(rootDir);
    await syncAliasesCommand(config);
  } catch {
    console.log('    · skipped (no tsconfig.json found)');
  }

  // Generate route types (#221)
  console.log('  → Generating route types...');
  try {
    const { writeRouteTypes } = await import('pledgestack-core');
    const { loadConfig } = await import('../config-loader');
    const config = await loadConfig(rootDir);
    await writeRouteTypes(config);
    console.log('    ✓ Route types generated');
  } catch {
    console.log('    · skipped (no routes found yet)');
  }

  console.log('\n  ✓ PledgeStack initialized successfully!\n');

  if (!opts.skipInstall) {
    console.log('  Next steps:');
    console.log('    1. Install dependencies: pnpm install');
    console.log('    2. Start dev server: pledge dev\n');
  } else {
    console.log('  Run `pledge dev` to start developing.\n');
  }

  if (framework === 'nextjs') {
    console.log('  Note: Some Next.js patterns may need manual conversion:');
    console.log('    - getServerSideProps → server component data fetching');
    console.log('    - getStaticProps → generateStaticParams + server component');
    console.log('    - next/image → native <img> or custom component');
    console.log('    - API routes under pages/api/ → app/api/*/route.ts\n');
  }
}
