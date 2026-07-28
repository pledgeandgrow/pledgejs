import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

/**
 * Resolves the native pledgepack binary for the current platform.
 * Checks platform-specific packages, local binaries, and postinstall-downloaded binaries.
 */
export function resolveBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  const platformPackages: Record<string, Record<string, string>> = {
    darwin: { arm64: '@pledgepack/darwin-arm64', x64: '@pledgepack/darwin-x64' },
    linux: { x64: '@pledgepack/linux-x64-gnu' },
    win32: { x64: '@pledgepack/win32-x64-msvc' },
  };

  const packageName = platformPackages[platform]?.[arch];

  if (packageName) {
    try {
      const pkgPath = require.resolve(packageName);
      const pkgDir = dirname(pkgPath);
      const candidates =
        platform === 'win32'
          ? [join(pkgDir, 'bin', 'pledgepack.exe'), join(pkgDir, 'bin', 'pledgepack')]
          : [join(pkgDir, 'bin', 'pledgepack'), join(pkgDir, 'bin', 'pledgepack.exe')];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Platform package not installed
    }
  }

  // Try resolving via the pledgepack package's own index.js
  try {
    const pledgepackPath = require.resolve('pledgepack');
    const pledgepackDir = dirname(pledgepackPath);

    // Check bin/pledgepack or bin/pledgepack.exe
    const localBinary = join(pledgepackDir, 'bin', 'pledgepack');
    if (existsSync(localBinary)) return localBinary;

    if (platform === 'win32') {
      const localExe = join(pledgepackDir, 'bin', 'pledgepack.exe');
      if (existsSync(localExe)) return localExe;
    }

    // Check platform-specific subdirectory (where postinstall downloads)
    const platformKey = `${platform}-${arch}`;
    const platformBinaryName = platform === 'win32' ? 'pledge.exe' : 'pledge';
    const platformBinary = join(pledgepackDir, 'bin', platformKey, platformBinaryName);
    if (existsSync(platformBinary)) return platformBinary;
  } catch {
    // pledgepack package not installed
  }

  return null;
}

/**
 * Runs the pledgepack binary with the given arguments.
 */
export function runPledgepack(args: string[] = []): Promise<void> {
  const binary = resolveBinary();
  if (!binary) {
    throw new Error(
      'pledgepack binary not found. The native binary may not have been downloaded. ' +
        'Try running "pnpm rebuild pledgepack" or install the platform-specific package.',
    );
  }

  const child = spawn(binary, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`pledgepack exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
