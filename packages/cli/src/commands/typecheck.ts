/**
 * `pledge typecheck` — Run TypeScript type checking (tsc --noEmit).
 *
 * Wraps `tsc --noEmit` to provide a unified CLI experience.
 * Exits with code 1 if type errors are found.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TypecheckOptions {
  /** Specific directory to typecheck (defaults to cwd) */
  dir?: string;
}

export async function typecheckCommand(opts: TypecheckOptions): Promise<void> {
  const rootDir = opts.dir ?? process.cwd();

  console.log('\n\x1b[1m\x1b[36mRunning TypeScript type checking...\x1b[0m\n');

  const tsconfigPath = join(rootDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    console.error('  \x1b[31m✗\x1b[0m No tsconfig.json found in project root.');
    console.error('    Run `pledge init` to scaffold a project, or create a tsconfig.json manually.');
    process.exit(1);
  }

  const child = spawn('npx', ['tsc', '--noEmit', '-p', tsconfigPath], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => {
      console.error('  \x1b[31m✗\x1b[0m TypeScript (tsc) not found. Install with: npm install -D typescript');
      resolve(1);
    });
  });

  if (exitCode === 0) {
    console.log('  \x1b[32m✓\x1b[0m No type errors found.\n');
  } else {
    console.error(`\n  \x1b[31m✗\x1b[0m Type checking failed with exit code ${exitCode}.\n`);
    process.exit(exitCode);
  }
}
