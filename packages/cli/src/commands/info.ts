import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLEDGE_VERSION } from 'pledgestack-shared';

interface InfoOptions {
  verbose?: boolean;
}

/**
 * Prints diagnostics about the current PledgeStack project.
 * Shows framework version, config, routes, dependencies, and environment.
 */
export async function infoCommand(options: InfoOptions = {}): Promise<void> {
  const verbose = options.verbose ?? false;

  console.log('\n  PledgeStack — Project Diagnostics\n');
  console.log(`  Framework version: ${PLEDGE_VERSION}`);
  console.log(`  Node.js version: ${process.version}`);
  console.log(`  Platform: ${process.platform} ${process.arch}`);

  // Load config
  const configPath = join(process.cwd(), 'pledge.config.ts');
  if (existsSync(configPath)) {
    console.log(`  Config: pledge.config.ts found`);
  } else {
    console.log(`  Config: pledge.config.ts NOT found (using defaults)`);
  }

  // Check for app directory
  const appDir = join(process.cwd(), 'app');
  if (existsSync(appDir)) {
    const routeCount = await countRoutes(appDir);
    console.log(`  App directory: app/ (${routeCount} routes)`);
  } else {
    console.log(`  App directory: NOT found`);
  }

  // Check for public directory
  const publicDir = join(process.cwd(), 'public');
  console.log(`  Public directory: ${existsSync(publicDir) ? 'public/' : 'NOT found'}`);

  // Check for .pledge output
  const outDir = join(process.cwd(), '.pledge');
  console.log(`  Build output: ${existsSync(outDir) ? '.pledge/ (built)' : 'NOT built'}`);

  // Check for env files
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production']
    .filter((f) => existsSync(join(process.cwd(), f)));
  console.log(`  Env files: ${envFiles.length > 0 ? envFiles.join(', ') : 'none'}`);

  // Check package.json
  const pkgPath = join(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`  Project name: ${pkg.name ?? 'unnamed'}`);
    console.log(`  Project version: ${pkg.version ?? '0.0.0'}`);

    if (verbose) {
      const deps = pkg.dependencies ?? {};
      const devDeps = pkg.devDependencies ?? {};
      const pledgeDeps = Object.entries({ ...deps, ...devDeps })
        .filter(([k]) => k === 'pledgestack' || k === 'pledgepack' || k.startsWith('pledgestack-') || k.startsWith('pledgepack-'));
      console.log(`\n  PledgeStack dependencies:`);
      for (const [name, version] of pledgeDeps) {
        console.log(`    ${name}: ${version}`);
      }
    }
  }

  // Check TypeScript
  const tsconfigPath = join(process.cwd(), 'tsconfig.json');
  console.log(`\n  TypeScript: ${existsSync(tsconfigPath) ? 'tsconfig.json found' : 'NOT configured'}`);

  // Check Tailwind
  const tailwindConfigPaths = [
    join(process.cwd(), 'tailwind.config.js'),
    join(process.cwd(), 'tailwind.config.ts'),
    join(process.cwd(), 'postcss.config.js'),
  ];
  const tailwindFound = tailwindConfigPaths.some((p) => existsSync(p));
  console.log(`  Tailwind CSS: ${tailwindFound ? 'configured' : 'not configured'}`);

  console.log('\n');
}

async function countRoutes(appDir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let count = 0;

  async function scan(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await scan(join(dir, entry.name));
      } else if (entry.name === 'page.tsx' || entry.name === 'page.ts' || entry.name === 'route.ts') {
        count++;
      }
    }
  }

  await scan(appDir);
  return count;
}
