/**
 * pledge sync-aliases — Auto-configure tsconfig.json paths from pledge.config.ts.
 *
 * Goal #231: Sync @/app/*, @/lib/*, @/components/* path aliases from
 * pledge.config.ts `alias` field into tsconfig.json compilerOptions.paths.
 * Also syncs with PledgePack resolve aliases.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

/**
 * Generates tsconfig.json paths from the config alias map.
 *
 * e.g. { "@/app/*": "app/*" } → { "@/app/*": ["./app/*"] }
 */
function aliasToTsPaths(alias: Record<string, string>, _rootDir: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(alias)) {
    paths[key] = [`./${value}`];
  }
  return paths;
}

/**
 * Reads, updates, and writes tsconfig.json with the alias paths.
 * Preserves all existing tsconfig fields — only updates `compilerOptions.paths`.
 */
export async function syncAliasesCommand(config: PledgeConfig): Promise<void> {
  const tsconfigPath = join(config.rootDir, 'tsconfig.json');

  if (!config.alias || Object.keys(config.alias).length === 0) {
    console.log('\n  No aliases configured in pledge.config.ts — nothing to sync.\n');
    return;
  }

  let tsconfig: Record<string, unknown>;
  let existingContent = '';

  if (existsSync(tsconfigPath)) {
    existingContent = await readFile(tsconfigPath, 'utf-8');
    try {
      tsconfig = JSON.parse(existingContent);
    } catch {
      console.error('  Error: tsconfig.json is not valid JSON');
      process.exit(1);
    }
  } else {
    tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    };
  }

  // Ensure compilerOptions exists
  if (!tsconfig.compilerOptions || typeof tsconfig.compilerOptions !== 'object') {
    tsconfig.compilerOptions = {};
  }
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;

  // Generate paths from alias config
  const paths = aliasToTsPaths(config.alias, config.rootDir);

  // Merge into existing paths — unrelated mappings (e.g. workspace package
  // aliases in a monorepo tsconfig) must be preserved, not clobbered.
  const existingPaths = (compilerOptions.paths ?? {}) as Record<string, string[]>;
  const merged = { ...existingPaths, ...paths };
  const pathsMatch = JSON.stringify(existingPaths) === JSON.stringify(merged);

  if (pathsMatch) {
    console.log('\n  ✓ tsconfig.json paths already up to date.\n');
    return;
  }

  // Update paths
  compilerOptions.paths = merged;
  compilerOptions.baseUrl = '.';

  // Write back with 2-space indentation
  const output = JSON.stringify(tsconfig, null, 2) + '\n';
  await writeFile(tsconfigPath, output, 'utf-8');

  const aliasCount = Object.keys(paths).length;
  console.log(`\n  ✓ Synced ${aliasCount} path alias${aliasCount > 1 ? 'es' : ''} to tsconfig.json\n`);

  for (const [key, value] of Object.entries(paths)) {
    console.log(`    ${key} → ${value[0]}`);
  }
  console.log();
}
