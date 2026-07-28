// PledgePack — Rust-based build compiler and orchestrator for PledgeStack
// This is a JavaScript shim that delegates to the native Rust binary.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Resolves the native pledgepack binary for the current platform.
 */
function resolveBinary() {
  const platform = process.platform;
  const arch = process.arch;

  const platformPackages = {
    'darwin': {
      'arm64': '@pledgepack/darwin-arm64',
      'x64': '@pledgepack/darwin-x64',
    },
    'linux': {
      'x64': '@pledgepack/linux-x64-gnu',
    },
    'win32': {
      'x64': '@pledgepack/win32-x64-msvc',
    },
  };

  const platformEntry = platformPackages[platform];
  const packageName = platformEntry?.[arch];

  if (packageName) {
    try {
      const pkgPath = require.resolve(packageName);
      const pkgDir = dirname(pkgPath);
      // Check for .exe on Windows, no extension on Unix
      const candidates = process.platform === 'win32'
        ? [join(pkgDir, 'bin', 'pledgepack.exe'), join(pkgDir, 'bin', 'pledgepack')]
        : [join(pkgDir, 'bin', 'pledgepack'), join(pkgDir, 'bin', 'pledgepack.exe')];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Platform package not installed
    }
  }

  // Fallback to local binary
  const localBinary = join(__dirname, 'bin', 'pledgepack');
  if (existsSync(localBinary)) return localBinary;

  // Fallback to local binary with .exe extension on Windows
  if (platform === 'win32') {
    const localExe = join(__dirname, 'bin', 'pledgepack.exe');
    if (existsSync(localExe)) return localExe;
  }

  // Check platform-specific subdirectory (where postinstall downloads)
  const platformKey = `${platform}-${arch}`;
  const platformBinaryName = platform === 'win32' ? 'pledge.exe' : 'pledge';
  const platformBinary = join(__dirname, 'bin', platformKey, platformBinaryName);
  if (existsSync(platformBinary)) return platformBinary;

  return null;
}

/**
 * Runs the pledgepack binary with the given arguments.
 */
export function runPledgepack(args = []) {
  const binary = resolveBinary();
  if (!binary) {
    throw new Error(
      'pledgepack binary not found. Run "pnpm build" in the pledgepack package first, ' +
      'or install the platform-specific package for your system.'
    );
  }

  const { spawn } = require('node:child_process');
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

export { resolveBinary };
