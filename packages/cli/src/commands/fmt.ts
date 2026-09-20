/**
 * `pledge fmt` — Format Rust code in .psx/.ps files using rustfmt.
 *
 * Goal #220: Runs `cargo fmt` on all .ps/.psx Rust blocks, ensuring
 * consistent formatting across the project. Supports `--check` for CI.
 *
 * Usage:
 *   pledge fmt              Format all .psx/.ps files
 *   pledge fmt --check      Check if files need formatting (CI mode)
 *   pledge fmt app/users    Format only files in specific directory
 *   pledge fmt --edition 2018 --config-file ci/rustfmt.toml
 *
 * Without --config-file, rustfmt.toml / .rustfmt.toml is discovered from the target directory upward.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { formatDirectory, checkFormatting } from 'pledgestack-core';

export interface FmtOptions {
  /** Check mode — don't modify files, just report which need formatting */
  check?: boolean;
  /** Specific directory to format (default: project root) */
  dir?: string;
  /** Rust edition (default: 2021) */
  edition?: string;
  /** Path to rustfmt.toml config file */
  configFile?: string;
}

export async function fmtCommand(opts: FmtOptions): Promise<void> {
  const rootDir = opts.dir ?? process.cwd();
  let resolved: { edition?: string; configFile?: string };
  try {
    resolved = resolveFmtOptions(rootDir, opts);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (opts.check) {
    // CI mode — check without modifying
    const needsFormat = await checkFormatting(rootDir, resolved);

    if (needsFormat.length === 0) {
      console.log('All .psx/.ps files are properly formatted.');
      return;
    }

    console.error('The following files need formatting:');
    for (const result of needsFormat) {
      console.error(`  ${result.file}`);
    }
    console.error(`\nRun \`pledge fmt\` to fix.`);
    process.exit(1);
  }

  // Format mode
  const results = await formatDirectory(rootDir, resolved);

  const changed = results.filter((r) => r.changed);
  const errors = results.filter((r) => r.error);

  if (changed.length === 0 && errors.length === 0) {
    console.log('All .psx/.ps files are already properly formatted.');
    return;
  }

  for (const result of changed) {
    const blocks = result.blocksFormatted ? ` (${result.blocksFormatted} block${result.blocksFormatted > 1 ? 's' : ''})` : '';
    console.log(`  formatted  ${result.file}${blocks}`);
  }

  for (const result of errors) {
    console.error(`  error      ${result.file}: ${result.error}`);
  }

  console.log(`\nFormatted ${changed.length} file${changed.length !== 1 ? 's' : ''}.`);
  if (errors.length > 0) {
    console.error(`${errors.length} error${errors.length !== 1 ? 's' : ''}.`);
  }
}

const VALID_EDITIONS = ['2015', '2018', '2021', '2024'];
const CONFIG_NAMES = ['rustfmt.toml', '.rustfmt.toml'];

/**
 * Resolve the rustfmt edition and config file for a run.
 *
 * - `--config-file` must exist (relative paths resolve against the cwd).
 * - Otherwise `rustfmt.toml` / `.rustfmt.toml` is searched for in `rootDir` and its ancestors.
 * - `--edition` wins; else an `edition = "..."` key in the config file; else the core default.
 */
export function resolveFmtOptions(
  rootDir: string,
  opts: Pick<FmtOptions, 'edition' | 'configFile'>,
): { edition?: string; configFile?: string } {
  if (opts.edition !== undefined && !VALID_EDITIONS.includes(opts.edition)) {
    throw new Error(`Invalid --edition "${opts.edition}" (expected one of ${VALID_EDITIONS.join(', ')})`);
  }

  let configFile: string | undefined;
  if (opts.configFile) {
    configFile = resolve(opts.configFile);
    if (!existsSync(configFile)) throw new Error(`Config file not found: ${opts.configFile}`);
  } else {
    let dir = resolve(rootDir);
    for (;;) {
      const hit = CONFIG_NAMES.map((n) => join(dir, n)).find((p) => existsSync(p));
      if (hit) { configFile = hit; break; }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let edition = opts.edition;
  if (edition === undefined && configFile) {
    const m = readFileSync(configFile, 'utf-8').match(/^\s*edition\s*=\s*["']?(\d{4})["']?/m);
    if (m && VALID_EDITIONS.includes(m[1])) edition = m[1];
  }
  return { edition, configFile };
}
