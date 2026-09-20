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
 *
 * There is no --fix: none of the current rules has a semantics-preserving
 * mechanical fix (e.g. unwrap() -> ? is only valid in Result-returning fns),
 * so autofixing is intentionally not offered.
 */

import { lintDirectory, formatLintResults, analyzeDeadCode, formatDeadCodeResult } from 'pledgestack-core';

export interface LintOptions {
  /** Specific directory to lint */
  dir?: string;
  /** Run dead code analysis (#219) */
  deadCode?: boolean;
}

export async function lintCommand(opts: LintOptions): Promise<void> {
  const rootDir = opts.dir ?? process.cwd();

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
