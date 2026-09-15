import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Creates a new PledgeStack project.
 *
 * Delegates to create-pledge-app, which is the canonical scaffolder.
 * Templates live in packages/create-pledge-app/templates/ — including the
 * 'pledge' template (full-stack React + Rust backend with server/ directory).
 *
 * This thin wrapper ensures `pledge create` and `create-pledge-app` produce
 * identical output.
 */
export async function createCommand(
  projectName: string,
  options: { template?: string; framework?: string; install?: boolean } = {},
): Promise<void> {
  const args: string[] = [projectName];

  if (options.template) {
    args.push('--template', options.template);
  }

  if (options.framework) {
    args.push('--framework', options.framework);
  }

  if (options.install !== undefined) {
    args.push(options.install ? '--install' : '--no-install');
  }

  // Try to run create-pledge-app from node_modules
  const createAppBin = tryResolveCreateApp();
  if (createAppBin) {
    const child = spawn('node', [createAppBin, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    return new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`create-pledge-app exited with code ${code}`));
      });
      child.on('error', reject);
    });
  }

  // Fallback: if create-pledge-app is not installed, show a helpful message
  console.error('\n  create-pledge-app is not installed.');
  console.error('  Install it with: pnpm add -g create-pledge-app');
  console.error('  Or use: npx create-pledge-app\n');
  process.exit(1);
}

function tryResolveCreateApp(): string | null {
  try {
    const req = createRequire(import.meta.url);
    // Resolve to the bin entry of create-pledge-app
    const pkgPath = req.resolve('create-pledge-app/package.json');
    const pkgDir = dirname(pkgPath);
    const binPath = join(pkgDir, 'dist', 'index.js');
    if (existsSync(binPath)) return binPath;
    // Try alternative bin locations
    const altBinPath = join(pkgDir, 'bin', 'index.js');
    if (existsSync(altBinPath)) return altBinPath;
    return null;
  } catch {
    return null;
  }
}
