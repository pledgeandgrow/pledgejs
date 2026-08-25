/**
 * `pledge lint` — Lint .psx/.ps files for common Rust issues.
 *
 * Goal #217: ESLint-compatible rules for .psx files.
 * Detects unused Rust functions, unwrap() usage, missing Result returns,
 * and NAPI signature issues.
 *
 * Usage:
 *   pledge lint              Lint all .psx/.ps files
 *   pledge lint app/users    Lint specific directory
 *   pledge lint --fix        Not yet supported — shows suggestions only
 */

import { lintDirectory, formatLintResults, analyzeDeadCode, formatDeadCodeResult } from 'pledgestack-core';

export interface LintOptions {
  /** Specific directory to lint */
  dir?: string;
  /** Show suggestions (always on for now) */
  fix?: boolean;
  /** Run dead code analysis (#219) */
  deadCode?: boolean;
}

export async function lintCommand(opts: LintOptions): Promise<void> {
  const rootDir = opts.dir ?? process.cwd();

  // `--fix` is accepted but auto-fixing isn't implemented yet. Say so explicitly
  // rather than silently ignoring the flag (the previous behavior).
  if (opts.fix) {
    console.log('\x1b[33m  ⚠ --fix is not yet supported; showing suggestions only.\x1b[0m');
  }

  const results = await lintDirectory(rootDir);
  const output = formatLintResults(results);
  console.log(output);

  // Run dead code analysis if requested (#219)
  if (opts.deadCode) {
    console.log('\n\x1b[1m\x1b[36mDead code analysis...\x1b[0m');
    const deadCodeResult = await analyzeDeadCode(rootDir);
    console.log(formatDeadCodeResult(deadCodeResult));
  }

  // Exit with error code if there are any errors
  const hasErrors = results.some((r) =>
    r.messages.some((m) => m.severity === 'error'),
  );

  if (hasErrors) {
    process.exit(1);
  }
}
