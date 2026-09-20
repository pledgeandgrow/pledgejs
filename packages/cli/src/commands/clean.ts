/**
 * pledge clean — Remove all generated artifacts.
 *
 * Goal #225: One command to clean .pledge/, .pledge-cache/, target/,
 * PledgePack disk cache, and all generated files.
 */

import { rm, access } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import type { PledgeConfig } from 'pledgestack-shared';

interface CleanResult {
  path: string;
  removed: boolean;
  error?: string;
}

/**
 * Paths to clean, in order.
 */
/**
 * A clean target must never be the project root itself, one of its parents, or
 * the home directory. `outDir: '.'` (or '' / '..') in a config would otherwise
 * make `pledge clean` recursively delete the whole project.
 */
export function isSafeToRemove(target: string, rootDir: string): boolean {
  const t = resolve(target);
  const root = resolve(rootDir);
  if (t === root) return false;
  if (root.startsWith(t.endsWith(sep) ? t : t + sep)) return false; // ancestor of root
  if (t === resolve(homedir())) return false;
  return true;
}

export function getCleanPaths(config: PledgeConfig): string[] {
  const root = config.rootDir;
  const paths: string[] = [
    // Build output
    join(root, config.outDir),
    // PSX/Rust cache
    join(root, '.pledge-cache'),
    // Cargo target directory
    config.cargo?.targetDir ?? join(root, 'target'),
    // Generated route types
    join(root, config.outDir, '__pledge_route_types.d.ts'),
    // TypeScript build info
    join(root, '.tsbuildinfo'),
    join(root, 'tsconfig.tsbuildinfo'),
    // PledgePack cache
    join(root, '.pledgepack-cache'),
    // Vitest cache
    join(root, 'node_modules', '.vite'),
    // ESLint cache
    join(root, '.eslintcache'),
  ];

  // OS-specific PledgePack cache
  const home = homedir();
  const osCacheDir = platform() === 'win32'
    ? join(home, 'AppData', 'Local', 'pledgepack')
    : join(home, '.cache', 'pledgepack');
  paths.push(osCacheDir);

  return paths.filter((p) => isSafeToRemove(p, root));
}

/**
 * Removes a path if it exists, returns whether it was removed.
 */
async function removePath(path: string): Promise<CleanResult> {
  try {
    await access(path);
    await rm(path, { recursive: true, force: true });
    return { path, removed: true };
  } catch {
    return { path, removed: false };
  }
}

/**
 * Runs the clean command — removes all generated artifacts.
 */
export async function cleanCommand(config: PledgeConfig, opts?: { verbose?: boolean }): Promise<void> {
  const paths = getCleanPaths(config);
  const verbose = opts?.verbose ?? false;

  console.log('\n  Cleaning generated artifacts...\n');

  let removedCount = 0;
  let skippedCount = 0;
  for (const path of paths) {
    const result = await removePath(path);
    if (result.removed) {
      removedCount++;
      console.log(`  ${'✓'} removed  ${path}`);
    } else {
      skippedCount++;
      if (verbose) {
        console.log(`  ${'·'} skipped   ${path} (not found)`);
      }
    }
  }

  // Also clean node_modules/.pledge if it exists
  const pledgeNodeModules = join(config.rootDir, 'node_modules', '.pledge');
  const nmResult = await removePath(pledgeNodeModules);
  if (nmResult.removed) {
    removedCount++;
    console.log(`  ${'✓'} removed  ${pledgeNodeModules}`);
  }

  console.log(`\n  Done: ${removedCount} removed, ${skippedCount} skipped.\n`);
}
