/**
 * pledge upgrade — Check for new PledgeStack versions and update dependencies.
 *
 * Goal #232: One-command upgrade experience:
 * 1. Check current vs latest PledgeStack version on npm
 * 2. Show changelog highlights between versions
 * 3. Update package.json dependencies and install
 * 4. Regenerate route types and sync aliases
 *
 * There is intentionally no automatic codemod step: PledgeStack has not
 * shipped a version-to-version breaking change that needs a source rewrite.
 * The Next.js-migration codemods live behind the explicit `pledge codemod`
 * command and must never run implicitly against user source on an upgrade.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { detectPackageManager } from './init';

interface UpgradeOptions {
  /** Check for updates without applying */
  check?: boolean;
  /** @deprecated No-op: `pledge upgrade` no longer runs codemods. Kept so existing scripts don't break. */
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
  const match = version.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : '0.0.0';
}

/**
 * Gets the latest published PledgeStack version from npm. Returns null when
 * the registry cannot be reached (offline, npm missing, package not found) —
 * callers must not treat that as version 0.0.0, which previously made
 * `pledge upgrade --force` write "^0.0.0" into package.json.
 */
export function getLatestVersion(): string | null {
  try {
    const output = execSync('npm view pledgestack version', {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output || null;
  } catch {
    // npm not available or package not found — check local monorepo
    try {
      const output = execSync('pnpm view pledgestack version', {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return output || null;
    } catch {
      return null;
    }
  }
}

/**
 * Compares two semver versions (including prerelease tags per semver §11:
 * `1.0.0-rc.1 < 1.0.0`, numeric identifiers compare numerically).
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, ...pre] = v.replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.join('-') };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    const va = pa.nums[i] ?? 0;
    const vb = pb.nums[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1; // a release outranks any prerelease of the same version
  if (!pb.pre) return -1;
  const ia = pa.pre.split('.');
  const ib = pb.pre.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
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

  console.log(`  Current version: ${current}`);
  if (latest === null) {
    console.error('  Latest version:  unknown\n');
    console.error('  ✖ Could not determine the latest version (is the npm registry reachable?).');
    console.error('    Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }
  const updateAvailable = compareVersions(latest, current) > 0;
  console.log(`  Latest version:  ${latest}\n`);

  if (!updateAvailable && !opts.force) {
    console.log('  ✓ You are on the latest version!\n');
    return;
  }

  if (opts.check) {
    console.log('  Update available! Run `pledge upgrade` (without --check) to apply.\n');
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

  if (opts.skipCodemods) {
    console.log('  Note: --skip-codemods is deprecated and has no effect (upgrade no longer runs codemods).\n');
  }

  // 2. Install dependencies
  if (!opts.skipInstall) {
    console.log('  → Installing dependencies...');
    try {
      const pm = await detectPackageManager(rootDir);
      execSync(`${pm} install`, { cwd: rootDir, stdio: 'inherit', timeout: 120000 });
      console.log('    ✓ Dependencies installed\n');
    } catch {
      console.log('    ⚠ Failed to install dependencies automatically');
      console.log('    Please run your package manager install manually.\n');
    }
  }

  // 3. Sync aliases and regenerate route types
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
  console.log('    1. Review the package.json changes with `git diff`');
  console.log('    2. Run `pledge build` to verify the upgrade');
  console.log('    3. Run `pledge dev` to test in development\n');
}
