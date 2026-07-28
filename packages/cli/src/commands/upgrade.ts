/**
 * pledge upgrade — Check for new PledgeStack versions, run applicable codemods,
 * and update dependencies.
 *
 * Goal #232: One-command upgrade experience:
 * 1. Check current vs latest PledgeStack version on npm
 * 2. Show changelog highlights between versions
 * 3. Run any applicable codemods for breaking changes
 * 4. Update package.json dependencies
 * 5. Regenerate route types and sync aliases
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { PledgeConfig } from 'pledgestack-shared';

interface UpgradeOptions {
  /** Check for updates without applying */
  check?: boolean;
  /** Skip codemods */
  skipCodemods?: boolean;
  /** Skip dependency installation */
  skipInstall?: boolean;
  /** Force upgrade even if already latest */
  force?: boolean;
}

/**
 * Gets the current installed PledgeStack version from package.json.
 */
async function getCurrentVersion(rootDir: string): Promise<string> {
  const pkgPath = join(rootDir, 'package.json');
  if (!existsSync(pkgPath)) return '0.0.0';

  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const version = deps['pledgestack'];

  if (!version) return '0.0.0';

  // Extract version from "latest", "^1.2.3", "1.2.3", etc.
  const match = version.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '0.0.0';
}

/**
 * Gets the latest published PledgeStack version from npm.
 */
function getLatestVersion(): string {
  try {
    const output = execSync('npm view pledgestack version', {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output || '0.0.0';
  } catch {
    // npm not available or package not found — check local monorepo
    try {
      const output = execSync('pnpm view pledgestack version', {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return output || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

/**
 * Compares two semver versions.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Determines which codemods should run based on version transition.
 * Each codemod has a `minVersion` (when it was introduced) and optional `maxVersion`.
 */
function getApplicableCodemods(from: string, to: string): string[] {
  const codemods: Array<{ name: string; minVersion: string; description: string }> = [
    { name: 'pledgejs-to-pledgestack', minVersion: '0.1.0', description: 'Rename PledgeJS → PledgeStack' },
    { name: 'next-to-pledge', minVersion: '0.1.0', description: 'Migrate Next.js imports → PledgeStack' },
    { name: 'use-client-to-pledge-client', minVersion: '0.2.0', description: 'Convert "use client" → "use pledge:client"' },
    { name: 'api-routes-to-route-handlers', minVersion: '0.2.0', description: 'Convert API routes → route handlers' },
    { name: 'get-server-side-props-to-server-component', minVersion: '0.3.0', description: 'Convert getServerSideProps → server component' },
    { name: 'get-static-props-to-generate-static-params', minVersion: '0.3.0', description: 'Convert getStaticProps → generateStaticParams' },
    { name: 'next-image-to-img', minVersion: '0.3.0', description: 'Convert next/image → native img' },
    { name: 'next-router-to-pledge-router', minVersion: '0.3.0', description: 'Convert next/router → pledgestack/router' },
  ];

  return codemods
    .filter((c) => compareVersions(c.minVersion, from) > 0 && compareVersions(c.minVersion, to) <= 0)
    .map((c) => c.name);
}

/**
 * Updates package.json with new PledgeStack version.
 */
async function updatePackageVersion(rootDir: string, newVersion: string): Promise<void> {
  const pkgPath = join(rootDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

  if (pkg.dependencies?.['pledgestack']) {
    pkg.dependencies['pledgestack'] = `^${newVersion}`;
  }
  if (pkg.devDependencies?.['pledgestack']) {
    pkg.devDependencies['pledgestack'] = `^${newVersion}`;
  }

  // Also update React to latest if it's outdated
  if (pkg.dependencies?.['react'] && !pkg.dependencies['react'].includes('19')) {
    pkg.dependencies['react'] = '^19.0.0';
    pkg.dependencies['react-dom'] = '^19.0.0';
  }
  if (pkg.devDependencies?.['@types/react'] && !pkg.devDependencies['@types/react'].includes('19')) {
    pkg.devDependencies['@types/react'] = '^19.0.0';
    pkg.devDependencies['@types/react-dom'] = '^19.0.0';
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

/**
 * Runs applicable codemods across the project source files.
 */
async function runUpgradeCodemods(rootDir: string, codemodNames: string[], config: PledgeConfig): Promise<void> {
  if (codemodNames.length === 0) return;

  const { runCodemod } = await import('./codemod');
  const { scanAppDir } = await import('pledgestack-core');

  // Collect all source files to transform
  const appDir = join(config.rootDir, config.appDir);
  const files: string[] = [];

  if (existsSync(appDir)) {
    const routeFiles = await scanAppDir(appDir);
    files.push(...routeFiles.map((f) => f.absolutePath));
  }

  // Also scan lib/, src/, components/
  for (const dir of ['src', 'lib', 'components']) {
    const dirPath = join(rootDir, dir);
    if (existsSync(dirPath)) {
      const { readdir } = await import('node:fs/promises');
      async function walk(d: string) {
        const entries = await readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(d, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(full);
        }
      }
      await walk(dirPath);
    }
  }

  let totalChanges = 0;
  let filesChanged = 0;

  for (const codemodName of codemodNames) {
    console.log(`  → Running codemod: ${codemodName}`);
    for (const file of files) {
      try {
        const result = await runCodemod({ name: codemodName, path: file });
        totalChanges += result.totalChanges;
        filesChanged += result.filesChanged;
      } catch {
        // Codemod may not exist yet — skip
      }
    }
  }

  if (totalChanges > 0) {
    console.log(`  ✓ ${filesChanged} file(s) changed, ${totalChanges} total transformation(s)\n`);
  } else {
    console.log('  ✓ No codemod changes needed\n');
  }
}

/**
 * Runs the upgrade command.
 */
export async function upgradeCommand(opts: UpgradeOptions = {}): Promise<void> {
  const { loadConfig } = await import('../config-loader');
  const config = await loadConfig();
  const rootDir = config.rootDir;

  console.log('\n  PledgeStack — Checking for updates...\n');

  // Get version info
  const current = await getCurrentVersion(rootDir);
  const latest = getLatestVersion();
  const updateAvailable = compareVersions(latest, current) > 0;

  console.log(`  Current version: ${current}`);
  console.log(`  Latest version:  ${latest}\n`);

  if (!updateAvailable && !opts.force) {
    console.log('  ✓ You are on the latest version!\n');

    // Still offer to run codemods if any are applicable
    const codemods = getApplicableCodemods(current, latest);
    if (codemods.length > 0 && !opts.skipCodemods) {
      console.log(`  ${codemods.length} codemod(s) available for your version.`);
      console.log('  Run with --force to apply them.\n');
    }
    return;
  }

  if (opts.check) {
    console.log('  Update available! Run `pledge upgrade` (without --check) to apply.\n');

    // Show applicable codemods
    const codemods = getApplicableCodemods(current, latest);
    if (codemods.length > 0) {
      console.log('  Breaking changes that will be migrated:');
      for (const c of codemods) {
        console.log(`    • ${c}`);
      }
      console.log();
    }
    return;
  }

  console.log('  Upgrading...\n');

  // 1. Update package.json
  console.log('  → Updating package.json...');
  await updatePackageVersion(rootDir, latest);
  console.log(`    ✓ pledgestack updated to ^${latest}`);

  // Update React deps if needed
  const pkgPath = join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (pkg.dependencies?.['react']?.includes('19')) {
      console.log('    ✓ react/react-dom already at v19');
    } else if (pkg.dependencies?.['react']) {
      console.log('    ✓ react/react-dom updated to v19');
    }
  }
  console.log();

  // 2. Run codemods
  if (!opts.skipCodemods) {
    const codemods = getApplicableCodemods(current, latest);
    if (codemods.length > 0) {
      console.log(`  → Running ${codemods.length} codemod(s)...`);
      await runUpgradeCodemods(rootDir, codemods, config);
    } else {
      console.log('  → No codemods needed for this version.\n');
    }
  }

  // 3. Install dependencies
  if (!opts.skipInstall) {
    console.log('  → Installing dependencies...');
    try {
      const pm = existsSync(join(rootDir, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(rootDir, 'yarn.lock')) ? 'yarn'
        : 'npm';
      execSync(`${pm} install`, { cwd: rootDir, stdio: 'inherit', timeout: 120000 });
      console.log('    ✓ Dependencies installed\n');
    } catch {
      console.log('    ⚠ Failed to install dependencies automatically');
      console.log('    Please run your package manager install manually.\n');
    }
  }

  // 4. Sync aliases and regenerate route types
  console.log('  → Syncing tsconfig.json path aliases...');
  try {
    const { syncAliasesCommand } = await import('./sync-aliases');
    await syncAliasesCommand(config);
  } catch {
    console.log('    · skipped');
  }

  console.log('  → Generating route types...');
  try {
    const { writeRouteTypes } = await import('pledgestack-core');
    await writeRouteTypes(config);
    console.log('    ✓ Route types generated');
  } catch {
    console.log('    · skipped (no routes found)');
  }

  console.log('\n  ✓ Upgrade complete!\n');
  console.log('  Next steps:');
  console.log('    1. Review any codemod changes with `git diff`');
  console.log('    2. Run `pledge build` to verify the upgrade');
  console.log('    3. Run `pledge dev` to test in development\n');
}
