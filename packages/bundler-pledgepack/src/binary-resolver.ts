import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);

/**
 * Resolves the native pledgepack binary for the current platform.
 * Checks local binaries and postinstall-downloaded binaries under the
 * resolved `pledgepack` package.
 */
export function resolveBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  // Explicit override — lets users point at a locally-built or newer binary
  // (e.g. when the published binary has a platform-specific bug) without
  // patching node_modules.
  const override = process.env.PLEDGEPACK_BINARY;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PLEDGEPACK_BINARY is set to "${override}" but that file does not exist.`);
    }
    return override;
  }

  // Note: there used to be a lookup here for scoped per-platform packages
  // (`@pledgepack/darwin-arm64` etc.), mirroring the esbuild/swc pattern. That
  // family of packages has never been published — pledgepack ships one
  // package whose postinstall downloads a prebuilt binary from GitHub
  // Releases (see pledgepack/bin/postinstall.js and pledgepack/platforms.json
  // for the full, current platform list) — so the lookup always failed and
  // silently fell through to the logic below. Removed rather than "fixed"
  // (e.g. by adding the missing linux-arm64/win32-arm64 entries) since
  // patching a list for packages that don't exist wouldn't have made binary
  // resolution work on any more platforms. See PRODUCTION-READINESS-100.md
  // goals 8-9.

  // Try resolving via the pledgepack package
  // Use package.json as the entry point since it's always published
  // (index.js may not be included in all published versions)
  const resolvePaths = ['pledgepack/package.json', 'pledgepack'];
  for (const resolvePath of resolvePaths) {
    try {
      const pkgPath = require.resolve(resolvePath);
      const pledgepackDir = dirname(pkgPath);

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

      // Check root-level binary (some published packages include it at root)
      const rootBinaryName = platform === 'win32' ? 'pledge.exe' : 'pledge';
      const rootBinary = join(pledgepackDir, rootBinaryName);
      if (existsSync(rootBinary)) return rootBinary;
    } catch {
      // Try next resolve path
    }
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
