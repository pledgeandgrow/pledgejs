/**
 * `pledge test` — Run Rust tests from .psx/.ps files alongside Vitest.
 *
 * Goal #215: Auto-discovers #[test] and #[tokio::test] functions in
 * .psx/.ps files, runs them via cargo test, and merges results with
 * Vitest for a unified test report.
 *
 * Usage:
 *   pledge test              Run all tests (Rust + Vitest)
 *   pledge test --rust-only  Run only Rust tests
 *   pledge test --vitest     Run only Vitest tests
 */

import {
  discoverTests,
  generateTestHarness,
  runRustTests,
  formatTestResults,
} from 'pledgestack-core';

export interface TestOptions {
  /** Run only Rust tests, skip Vitest */
  rustOnly?: boolean;
  /** Run only Vitest tests, skip Rust */
  vitestOnly?: boolean;
  /** Specific directory to search for tests */
  dir?: string;
  /** Watch mode — re-run tests on file change */
  watch?: boolean;
}

export async function testCommand(opts: TestOptions): Promise<void> {
  const rootDir = opts.dir ?? process.cwd();
  const runRust = !opts.vitestOnly;
  const runVitest = !opts.rustOnly;

  let rustFailed = false;
  let vitestFailed = false;

  // ── Run Rust tests ──────────────────────────────────────────────────
  if (runRust) {
    console.log('\n\x1b[1m\x1b[36mRunning Rust tests...\x1b[0m\n');

    const tests = await discoverTests(rootDir);

    if (tests.length === 0) {
      console.log('  No Rust tests found in .psx/.ps files.');
    } else {
      console.log(`  Discovered ${tests.length} Rust test${tests.length !== 1 ? 's' : ''}.`);
      const harnessDir = await generateTestHarness(tests, rootDir);
      const results = await runRustTests(harnessDir, tests);
      console.log(formatTestResults(results));

      if (results.failed > 0) {
        rustFailed = true;
      }
    }
  }

  // ── Run Vitest tests ────────────────────────────────────────────────
  if (runVitest) {
    console.log('\n\x1b[1m\x1b[36mRunning Vitest tests...\x1b[0m\n');

    try {
      const { spawn } = await import('node:child_process');
      // `--passWithNoTests` makes Vitest exit 0 when there are no test files, so
      // a non-zero exit now unambiguously means a REAL test failure. Previously
      // every exit code 1 was treated as "no tests found", silently hiding
      // actual failures. In watch mode, run the interactive watcher instead.
      const vitestArgs = opts.watch
        ? ['vitest', '--reporter=verbose', '--passWithNoTests']
        : ['vitest', 'run', '--reporter=verbose', '--passWithNoTests'];
      const vitestChild = spawn('npx', vitestArgs, {
        cwd: rootDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      const vitestExit = await new Promise<number>((resolve) => {
        // null means Vitest was killed by a signal — report that as a failure.
        vitestChild.on('close', (code) => resolve(code ?? 1));
        vitestChild.on('error', () => resolve(-1));
      });

      if (vitestExit === -1) {
        console.log('  Vitest not available. Install with: npm install -D vitest');
      } else {
        vitestFailed = vitestExit !== 0;
      }
    } catch {
      console.log('  Vitest not available. Install with: npm install -D vitest');
    }
  }

  // ── Exit with appropriate code ──────────────────────────────────────
  if (rustFailed || vitestFailed) {
    process.exit(1);
  }
}
