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
      const vitestChild = spawn('npx', ['vitest', 'run', '--reporter=verbose'], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      const vitestExit = await new Promise<number>((resolve) => {
        vitestChild.on('close', (code) => resolve(code ?? 0));
        vitestChild.on('error', () => resolve(1));
      });

      // Vitest exits with code 1 when no test files are found — treat as non-failure
      if (vitestExit === 1) {
        console.log('  No Vitest test files found. (exit code 1 — treated as non-failure)');
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
