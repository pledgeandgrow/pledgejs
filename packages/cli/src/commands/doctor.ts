import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { scanAppDir, resolveRoutes } from 'pledgestack-core';
import { FILE_CONVENTIONS } from 'pledgestack-shared';
import type { PledgeConfig, ResolvedRoute } from 'pledgestack-shared';

interface Diagnostic {
  level: 'error' | 'warning' | 'info' | 'ok';
  category: string;
  message: string;
  fix?: string;
}

/**
 * pledgestack doctor — Diagnoses and reports common PledgeStack project issues.
 *
 * With --production flag, also checks Rust toolchain, Cargo.lock,
 * debug symbols, LTO, and addon stripping for production readiness.
 */
export async function doctorCommand(config: PledgeConfig, opts?: { production?: boolean }): Promise<void> {
  const diagnostics: Diagnostic[] = [];

  // Check config file
  checkConfigFile(config, diagnostics);

  // Check app directory
  checkAppDir(config, diagnostics);

  // Check routes
  await checkRoutes(config, diagnostics);

  // Check TypeScript config
  checkTsConfig(config, diagnostics);

  // Check package.json
  checkPackageJson(config, diagnostics);

  // Check public directory
  checkPublicDir(config, diagnostics);

  // Check environment files
  checkEnvFiles(config, diagnostics);

  // Check build output
  checkBuildOutput(config, diagnostics);

  // Check dependencies
  checkDependencies(config, diagnostics);

  // Production-specific checks
  if (opts?.production) {
    checkRustToolchain(config, diagnostics);
    checkCargoLock(config, diagnostics);
    checkLtoEnabled(config, diagnostics);
    checkDebugSymbols(config, diagnostics);
    checkAddonsStripped(config, diagnostics);
    checkNoDebugEnv(config, diagnostics);
    checkProductionEnv(config, diagnostics);
  }

  // Print results
  printDiagnostics(diagnostics);

  const errors = diagnostics.filter((d) => d.level === 'error');
  const warnings = diagnostics.filter((d) => d.level === 'warning');

  if (errors.length > 0) {
    console.log(`\n${red('✗')} ${errors.length} error(s) found`);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`\n${yellow('⚠')} ${warnings.length} warning(s) found`);
  } else {
    console.log(`\n${green('✓')} All checks passed!`);
  }
}

function checkConfigFile(config: PledgeConfig, diags: Diagnostic[]): void {
  const configPaths = [
    join(config.rootDir, 'pledge.config.ts'),
    join(config.rootDir, 'pledge.config.js'),
    join(config.rootDir, 'pledge.config.mjs'),
  ];

  const found = configPaths.find((p) => existsSync(p));
  if (found) {
    diags.push({ level: 'ok', category: 'Config', message: `Found config: ${found}` });
  } else {
    diags.push({
      level: 'info',
      category: 'Config',
      message: 'No pledge.config.ts found — using defaults',
    });
  }
}

function checkAppDir(config: PledgeConfig, diags: Diagnostic[]): void {
  const appPath = join(config.rootDir, config.appDir);
  if (!existsSync(appPath)) {
    diags.push({
      level: 'error',
      category: 'App Dir',
      message: `App directory not found: ${appPath}`,
      fix: `Create the directory: mkdir -p ${config.appDir}`,
    });
    return;
  }

  const stat = statSync(appPath);
  if (!stat.isDirectory()) {
    diags.push({
      level: 'error',
      category: 'App Dir',
      message: `App path is not a directory: ${appPath}`,
    });
    return;
  }

  diags.push({ level: 'ok', category: 'App Dir', message: `App directory exists: ${appPath}` });
}

async function checkRoutes(config: PledgeConfig, diags: Diagnostic[]): Promise<void> {
  try {
    const appPath = join(config.rootDir, config.appDir);
    if (!existsSync(appPath)) return;

    const files = await scanAppDir(appPath);
    const routes = resolveRoutes(files, config);

    diags.push({ level: 'ok', category: 'Routes', message: `Found ${routes.length} route(s)` });

    // Check for root page
    const rootPage = routes.find((r: ResolvedRoute) => r.pattern === '/' || r.pattern === '');
    if (!rootPage) {
      diags.push({
        level: 'warning',
        category: 'Routes',
        message: 'No root page (app/page.tsx) found',
        fix: 'Create app/page.tsx for the home page',
      });
    }

    // Check for root layout
    const rootLayout = routes.find((r: ResolvedRoute) =>
      r.isLayout && (r.pattern === '/' || r.pattern === '' || r.filePath.endsWith('layout.tsx') && !r.pattern.includes('/'))
    );
    if (!rootLayout) {
      // Fallback: check if app/layout.tsx exists directly
      const layoutPath = join(config.rootDir, config.appDir, 'layout.tsx');
      if (!existsSync(layoutPath)) {
        diags.push({
          level: 'warning',
          category: 'Routes',
          message: 'No root layout (app/layout.tsx) found',
          fix: 'Create app/layout.tsx for the root layout',
        });
      }
    }

    // Check for not-found — a not-found.tsx grouped with a page/layout sets
    // `notFoundFilePath` on that route rather than producing a standalone
    // isNotFound route, so check the scanned files directly.
    const hasNotFound = files.some((f) => f.convention === FILE_CONVENTIONS['not-found']);
    if (!hasNotFound) {
      diags.push({
        level: 'info',
        category: 'Routes',
        message: 'No not-found.tsx found — default 404 will be used',
      });
    }
  } catch (err) {
    diags.push({
      level: 'error',
      category: 'Routes',
      message: `Failed to scan routes: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function checkTsConfig(config: PledgeConfig, diags: Diagnostic[]): void {
  const tsconfigPath = join(config.rootDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    diags.push({
      level: 'warning',
      category: 'TypeScript',
      message: 'No tsconfig.json found',
      fix: 'Run: pledgestack create to scaffold a new project with tsconfig.json',
    });
    return;
  }

  diags.push({ level: 'ok', category: 'TypeScript', message: 'tsconfig.json found' });

  try {
    const content = readFileSync(tsconfigPath, 'utf-8');
    const tsconfig = JSON.parse(content);

    if (!tsconfig.compilerOptions?.jsx) {
      diags.push({
        level: 'warning',
        category: 'TypeScript',
        message: 'jsx option not set in tsconfig.json',
        fix: 'Set "compilerOptions.jsx": "react-jsx" in tsconfig.json',
      });
    }

    if (tsconfig.compilerOptions?.moduleResolution === 'bundler') {
      diags.push({
        level: 'info',
        category: 'TypeScript',
        message: 'moduleResolution is "bundler" — may cause issues with workspace packages',
      });
    }
  } catch {
    diags.push({
      level: 'error',
      category: 'TypeScript',
      message: 'Failed to parse tsconfig.json',
    });
  }
}

function checkPackageJson(config: PledgeConfig, diags: Diagnostic[]): void {
  const pkgPath = join(config.rootDir, 'package.json');
  if (!existsSync(pkgPath)) {
    diags.push({
      level: 'error',
      category: 'Package',
      message: 'No package.json found',
      fix: 'Run: npm init -y',
    });
    return;
  }

  diags.push({ level: 'ok', category: 'Package', message: 'package.json found' });

  try {
    const content = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);

    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    // The `pledgestack` meta package bundles core — depending on it satisfies
    // this check; only flag when neither is present.
    if (!allDeps['pledgestack'] && !allDeps['pledgestack-core']) {
      diags.push({
        level: 'error',
        category: 'Package',
        message: 'pledgestack not in dependencies',
        fix: 'Run: pnpm add pledgestack',
      });
    }

    if (!allDeps['react'] || !allDeps['react-dom']) {
      diags.push({
        level: 'error',
        category: 'Package',
        message: 'react/react-dom not in dependencies',
        fix: 'Run: pnpm add react react-dom',
      });
    }

    if (!allDeps['typescript']) {
      diags.push({
        level: 'warning',
        category: 'Package',
        message: 'typescript not in devDependencies',
      });
    }
  } catch {
    diags.push({
      level: 'error',
      category: 'Package',
      message: 'Failed to parse package.json',
    });
  }
}

function checkPublicDir(config: PledgeConfig, diags: Diagnostic[]): void {
  const publicPath = join(config.rootDir, config.publicDir);
  if (existsSync(publicPath)) {
    diags.push({ level: 'ok', category: 'Public', message: `Public directory exists: ${publicPath}` });
  } else {
    diags.push({
      level: 'info',
      category: 'Public',
      message: `No public directory found at ${publicPath}`,
    });
  }
}

function checkEnvFiles(config: PledgeConfig, diags: Diagnostic[]): void {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];
  const found = envFiles.filter((f) => existsSync(join(config.rootDir, f)));

  if (found.length > 0) {
    diags.push({ level: 'ok', category: 'Env', message: `Found env files: ${found.join(', ')}` });

    // Check for PLEDGE_PUBLIC_ prefix usage
    for (const f of found) {
      const content = readFileSync(join(config.rootDir, f), 'utf-8');
      if (content.includes('PLEDGE_PUBLIC_')) {
        diags.push({
          level: 'ok',
          category: 'Env',
          message: `Found PLEDGE_PUBLIC_ variables in ${f}`,
        });
      }
    }
  } else {
    diags.push({
      level: 'info',
      category: 'Env',
      message: 'No .env files found',
    });
  }
}

function checkBuildOutput(config: PledgeConfig, diags: Diagnostic[]): void {
  const outPath = join(config.rootDir, config.outDir);
  // An existing out dir isn't proof of a build — stray files (logs, caches)
  // land there too. Look for artifacts a real `pledge build` produces.
  const hasArtifacts = existsSync(outPath) && readdirSync(outPath).some((e) =>
    e === 'index.html' || e === 'manifest.json' || e === 'server' || e === 'public' || e.endsWith('.js'),
  );
  if (hasArtifacts) {
    diags.push({ level: 'ok', category: 'Build', message: `Build output exists: ${outPath}` });
  } else if (existsSync(outPath)) {
    diags.push({
      level: 'info',
      category: 'Build',
      message: `${outPath} exists but has no build artifacts — run: pledge build`,
    });
  } else {
    diags.push({
      level: 'info',
      category: 'Build',
      message: `No build output found at ${outPath} — run: pledge build`,
    });
  }
}

function checkDependencies(config: PledgeConfig, diags: Diagnostic[]): void {
  // Check for conflicting frameworks
  const pkgPath = join(config.rootDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  try {
    const content = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content);
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    const conflicts = ['next', 'nuxt', '@remix-run/react', '@sveltejs/kit', 'astro'];
    for (const conflict of conflicts) {
      if (allDeps[conflict]) {
        diags.push({
          level: 'warning',
          category: 'Conflicts',
          message: `Found "${conflict}" in dependencies — may conflict with PledgeStack`,
          fix: `Remove ${conflict} from package.json`,
        });
      }
    }
  } catch {
    // Already reported in checkPackageJson
  }
}

// ---------------------------------------------------------------------------
// Production checks (--production flag)
// ---------------------------------------------------------------------------

function checkRustToolchain(_config: PledgeConfig, diags: Diagnostic[]): void {
  try {
    const rustcVersion = execSync('rustc --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    diags.push({ level: 'ok', category: 'Production:Rust', message: `Rust toolchain: ${rustcVersion}` });

    const cargoVersion = execSync('cargo --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    diags.push({ level: 'ok', category: 'Production:Rust', message: `Cargo: ${cargoVersion}` });

    // Check for minimum Rust version (1.70+ recommended for PledgeStack)
    const versionMatch = rustcVersion.match(/rustc (\d+)\.(\d+)/);
    if (versionMatch) {
      const major = parseInt(versionMatch[1], 10);
      const minor = parseInt(versionMatch[2], 10);
      if (major < 1 || (major === 1 && minor < 70)) {
        diags.push({
          level: 'warning',
          category: 'Production:Rust',
          message: `Rust version ${major}.${minor} is below recommended 1.70+`,
          fix: 'Run: rustup update stable',
        });
      }
    }
  } catch {
    diags.push({
      level: 'error',
      category: 'Production:Rust',
      message: 'Rust toolchain not found — required for production PSX builds',
      fix: 'Install Rust: https://rustup.rs/',
    });
  }
}

function checkCargoLock(config: PledgeConfig, diags: Diagnostic[]): void {
  const cargoLockPath = join(config.rootDir, 'Cargo.lock');
  if (!existsSync(cargoLockPath)) {
    diags.push({
      level: 'error',
      category: 'Production:Rust',
      message: 'Cargo.lock not found — must be committed for reproducible production builds',
      fix: 'Run: cargo generate-lockfile && git add Cargo.lock',
    });
    return;
  }
  diags.push({ level: 'ok', category: 'Production:Rust', message: 'Cargo.lock found' });

  // Check if Cargo.lock is up to date
  try {
    const output = execSync('cargo metadata --no-deps --format-version 1', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: config.rootDir,
    });
    const metadata = JSON.parse(output);
    if (metadata.packages && metadata.packages.length > 0) {
      diags.push({ level: 'ok', category: 'Production:Rust', message: `Cargo.lock has ${metadata.packages.length} package(s)` });
    }
  } catch {
    diags.push({
      level: 'warning',
      category: 'Production:Rust',
      message: 'Could not verify Cargo.lock is up to date',
      fix: 'Run: cargo update --lock',
    });
  }
}

function checkLtoEnabled(config: PledgeConfig, diags: Diagnostic[]): void {
  const nativeDir = join(config.rootDir, 'packages', 'core', 'native');
  const cargoTomlPath = existsSync(join(nativeDir, 'Cargo.toml'))
    ? join(nativeDir, 'Cargo.toml')
    : findCargoToml(config.rootDir);

  if (!cargoTomlPath) {
    diags.push({
      level: 'info',
      category: 'Production:Rust',
      message: 'No Cargo.toml found — LTO check skipped',
    });
    return;
  }

  const content = readFileSync(cargoTomlPath, 'utf-8');
  const hasLto = content.includes('lto = true') || content.includes('lto = "thin"');
  const hasOptLevel = content.includes('opt-level = 3') || content.includes('opt-level = "z"') || content.includes('opt-level = "s"');

  if (hasLto) {
    diags.push({ level: 'ok', category: 'Production:Rust', message: 'LTO enabled in Cargo.toml' });
  } else {
    diags.push({
      level: 'warning',
      category: 'Production:Rust',
      message: 'LTO not enabled — production binaries will be 20-30% larger',
      fix: 'Add `[profile.release]\nlto = true` to Cargo.toml',
    });
  }

  if (hasOptLevel) {
    diags.push({ level: 'ok', category: 'Production:Rust', message: 'Optimization level set in Cargo.toml' });
  } else {
    diags.push({
      level: 'info',
      category: 'Production:Rust',
      message: 'No explicit opt-level in Cargo.toml — default is 3 for release',
    });
  }

  // Check for strip = true
  if (content.includes('strip = true')) {
    diags.push({ level: 'ok', category: 'Production:Rust', message: 'Strip enabled in Cargo.toml' });
  } else {
    diags.push({
      level: 'warning',
      category: 'Production:Rust',
      message: 'Strip not enabled — debug symbols will be included in production binary',
      fix: 'Add `strip = true` to [profile.release] in Cargo.toml',
    });
  }
}

function checkDebugSymbols(config: PledgeConfig, diags: Diagnostic[]): void {
  const nativeDir = join(config.rootDir, 'packages', 'core', 'native');
  if (!existsSync(nativeDir)) {
    diags.push({
      level: 'info',
      category: 'Production:Rust',
      message: 'No native directory found — debug symbol check skipped',
    });
    return;
  }

  // Look for .node files and check for debug symbols
  let foundAddons = false;
  let foundDebugSymbols = false;

  function scanDir(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith('.node')) {
        foundAddons = true;
        const stat = statSync(fullPath);
        // Large .node files (>1MB) may contain debug symbols
        if (stat.size > 1024 * 1024) {
          // On Windows, check for .pdb files
          if (process.platform === 'win32') {
            const pdbPath = fullPath.replace(/\.node$/, '.pdb');
            if (existsSync(pdbPath)) {
              foundDebugSymbols = true;
              diags.push({
                level: 'warning',
                category: 'Production:Rust',
                message: `Debug symbols found: ${entry.name}.pdb (${formatBytes(statSync(pdbPath).size)})`,
                fix: `Delete ${entry.name}.pdb or rebuild with strip = true`,
              });
            }
          } else {
            // On Unix, use `file` command
            try {
              const output = execFileSync('file', [fullPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
              if (output.includes('not stripped') || output.includes('with debug_info')) {
                foundDebugSymbols = true;
                diags.push({
                  level: 'warning',
                  category: 'Production:Rust',
                  message: `${entry.name} is not stripped (${formatBytes(stat.size)})`,
                  fix: 'Rebuild with `strip = true` in Cargo.toml [profile.release]',
                });
              }
            } catch {
              // Can't check — skip
            }
          }
        }
      }
    }
  }

  scanDir(nativeDir);

  if (!foundAddons) {
    diags.push({
      level: 'info',
      category: 'Production:Rust',
      message: 'No .node addons found — run `pledge build` first',
    });
  } else if (!foundDebugSymbols) {
    diags.push({ level: 'ok', category: 'Production:Rust', message: 'All .node addons are stripped' });
  }
}

function checkAddonsStripped(config: PledgeConfig, diags: Diagnostic[]): void {
  // This is partially covered by checkDebugSymbols, but we also check
  // for the `strip` setting in Cargo.toml
  const nativeDir = join(config.rootDir, 'packages', 'core', 'native');
  const cargoTomlPath = existsSync(join(nativeDir, 'Cargo.toml'))
    ? join(nativeDir, 'Cargo.toml')
    : findCargoToml(config.rootDir);

  if (!cargoTomlPath) return;

  const content = readFileSync(cargoTomlPath, 'utf-8');
  if (content.includes('strip = true') || content.includes('strip = "symbols"')) {
    diags.push({ level: 'ok', category: 'Production:Rust', message: 'Strip setting enabled in Cargo.toml' });
  } else if (content.includes('strip = false')) {
    diags.push({
      level: 'error',
      category: 'Production:Rust',
      message: 'Strip explicitly disabled in Cargo.toml — production binary will contain debug symbols',
      fix: 'Remove `strip = false` or set `strip = true` in [profile.release]',
    });
  }
}

function checkNoDebugEnv(_config: PledgeConfig, diags: Diagnostic[]): void {
  // Check that NODE_ENV is not "development" in production
  if (process.env.NODE_ENV === 'development') {
    diags.push({
      level: 'warning',
      category: 'Production:Env',
      message: 'NODE_ENV is "development" — should be "production" for production builds',
      fix: 'Set NODE_ENV=production before running pledge doctor --production',
    });
  } else if (process.env.NODE_ENV === 'production') {
    diags.push({ level: 'ok', category: 'Production:Env', message: 'NODE_ENV=production' });
  } else {
    diags.push({
      level: 'info',
      category: 'Production:Env',
      message: `NODE_ENV is "${process.env.NODE_ENV ?? 'unset'}" — recommend setting to "production"`,
    });
  }

  // Check for debug env vars
  const debugVars = ['DEBUG', 'PLEDGE_DEBUG', 'RUST_BACKTRACE', 'RUST_LOG'];
  for (const varName of debugVars) {
    const value = process.env[varName];
    if (value && value !== '0' && value !== 'false' && value !== 'off') {
      diags.push({
        level: 'warning',
        category: 'Production:Env',
        message: `${varName}=${value} — debug logging enabled in production`,
        fix: `Unset ${varName} or set to 0/off for production`,
      });
    }
  }
}

function checkProductionEnv(config: PledgeConfig, diags: Diagnostic[]): void {
  // Check for .env.production
  const envProdPath = join(config.rootDir, '.env.production');
  if (existsSync(envProdPath)) {
    diags.push({ level: 'ok', category: 'Production:Env', message: '.env.production found' });

    const content = readFileSync(envProdPath, 'utf-8');
    // Check for common production settings
    if (!content.includes('DATABASE_URL') && !content.includes('DB_URL')) {
      diags.push({
        level: 'info',
        category: 'Production:Env',
        message: 'No DATABASE_URL in .env.production — ensure database is configured',
      });
    }
    // Check for secrets in .env.production (should not be committed)
    const secretPatterns = ['SECRET=', 'PASSWORD=', 'PRIVATE_KEY='];
    for (const pattern of secretPatterns) {
      if (content.includes(pattern)) {
        diags.push({
          level: 'warning',
          category: 'Production:Env',
          message: `Secret found in .env.production matching "${pattern}" — ensure this file is in .gitignore`,
          fix: 'Add .env.production to .gitignore',
        });
        break;
      }
    }
  } else {
    diags.push({
      level: 'info',
      category: 'Production:Env',
      message: 'No .env.production found — production env vars must be set externally',
    });
  }

  // Check .gitignore for .env files
  const gitignorePath = join(config.rootDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    if (!gitignore.includes('.env') && !gitignore.includes('*.env')) {
      diags.push({
        level: 'warning',
        category: 'Production:Env',
        message: '.gitignore does not exclude .env files — secrets may be committed',
        fix: 'Add .env* to .gitignore',
      });
    } else {
      diags.push({ level: 'ok', category: 'Production:Env', message: '.gitignore excludes .env files' });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCargoToml(dir: string): string | null {
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(current, 'Cargo.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function printDiagnostics(diags: Diagnostic[]): void {

  const categories = new Set(diags.map((d) => d.category));
  for (const category of categories) {
    const catDiags = diags.filter((d) => d.category === category);
    console.log(bold(`\n[${category}]`));
    for (const d of catDiags) {
      const icon = d.level === 'error' ? red('✗') : d.level === 'warning' ? yellow('⚠') : d.level === 'ok' ? green('✓') : blue('ℹ');
      console.log(`  ${icon} ${d.message}`);
      if (d.fix) {
        console.log(`    ${dim('Fix:')} ${d.fix}`);
      }
    }
  }
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function blue(s: string): string {
  return `\x1b[34m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
