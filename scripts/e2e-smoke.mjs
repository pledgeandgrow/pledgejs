#!/usr/bin/env node
/**
 * End-to-end smoke test: scaffold → install → build → serve → curl.
 *
 * Packs the CLI into a tarball, scaffolds a real app with the workspace
 * create-pledge-app, installs the tarball into it, runs `pledge build`,
 * boots `pledge start` and `pledge dev`, and asserts real HTTP responses.
 * This exercises the same artifact users install from npm — the failure
 * modes it catches (unpublished deps, broken bin wiring, boot crashes)
 * are invisible to the unit suite.
 *
 * Usage: node scripts/e2e-smoke.mjs [--keep]
 * Requires: `pnpm build:packages` + `pnpm --filter create-pledge-app run build`
 * to have run first (CI does this in the e2e job).
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const keep = process.argv.includes('--keep');
const APP_NAME = 'smoke-app';
const START_PORT = 4130;
const DEV_PORT = 4131;

function run(cmd, args, cwd, opts = {}) {
  console.log(`\n\x1b[36m$\x1b[0m ${cmd} ${args.join(' ')}  \x1b[90m(cwd: ${cwd})\x1b[0m`);
  const result = spawn(cmd, args, {
    cwd,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  return new Promise((res, rej) => {
    result.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
    result.on('error', rej);
  });
}

/** Spawn a long-lived server, poll `url` until it responds or the deadline passes. */
async function waitForServer(cmd, args, cwd, url, { timeoutMs = 120_000, env = {} } = {}) {
  console.log(`\n\x1b[36m$\x1b[0m ${cmd} ${args.join(' ')}  \x1b[90m(background)\x1b[0m`);
  const child = spawn(cmd, args, {
    cwd,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  let stderrTail = '';
  child.stderr?.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  let stdoutTail = '';
  child.stdout?.on('data', (d) => {
    stdoutTail = (stdoutTail + d).slice(-4000);
  });

  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server exited early (code ${child.exitCode}).\nstdout:\n${stdoutTail}\nstderr:\n${stderrTail}`,
      );
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { child, res };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  child.kill('SIGKILL');
  throw new Error(
    `Timed out waiting for ${url} (${lastErr}).\nstdout:\n${stdoutTail}\nstderr:\n${stderrTail}`,
  );
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // /T kills the process tree — dev/start spawn child servers
    // (the PledgePack dev server) that outlive the parent. Must be awaited:
    // on Windows the killed processes keep file locks on the workspace until
    // they actually exit, and an async taskkill races the rmdir cleanup.
    await new Promise((res) => {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
      tk.on('close', res);
      tk.on('error', res);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

async function main() {
  const cliDist = join(repoRoot, 'packages/cli/dist/bin.js');
  const createAppBin = join(repoRoot, 'packages/create-pledge-app/bin/create-pledge-app.js');
  if (!existsSync(cliDist)) throw new Error('packages/cli/dist missing — run `pnpm build:packages` first');
  if (!existsSync(createAppBin)) throw new Error('create-pledge-app not built — run `pnpm --filter create-pledge-app run build`');

  const workDir = mkdtempSync(join(tmpdir(), 'pledge-e2e-'));
  console.log(`\x1b[36mSmoke workspace:\x1b[0m ${workDir}`);

  // ── 1. Pack the CLI into a real tarball (tests the published artifact) ──
  console.log('\n\x1b[1m[1/6] Pack CLI tarball\x1b[0m');
  const packOut = execSync('npm pack --pack-destination .', {
    cwd: join(repoRoot, 'packages/cli'),
    encoding: 'utf8',
  }).trim();
  const tgzName = packOut.split('\n').pop().trim();
  const tgzPath = join(repoRoot, 'packages/cli', tgzName);
  if (!existsSync(tgzPath)) throw new Error(`npm pack did not produce ${tgzName}`);
  console.log(`  → ${tgzName}`);

  try {
    // ── 2. Scaffold a real app (non-interactive) ──────────────────────────
    console.log('\n\x1b[1m[2/6] Scaffold app\x1b[0m');
    await run('node', [
      createAppBin, APP_NAME,
      '--template', 'default', '--framework', 'react', '--no-install',
    ], workDir);
    const appDir = join(workDir, APP_NAME);

    // Point `pledgestack` at the packed tarball — exercises the artifact,
    // not the workspace source.
    const appPkgPath = join(appDir, 'package.json');
    const appPkg = JSON.parse(readFileSync(appPkgPath, 'utf8'));
    appPkg.dependencies.pledgestack = `file:${tgzPath.replace(/\\/g, '/')}`;
    writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2));

    // ── 3. Install ────────────────────────────────────────────────────────
    console.log('\n\x1b[1m[3/6] Install dependencies\x1b[0m');
    try {
      await run('pnpm', ['install'], appDir);
    } catch {
      await run('npm', ['install', '--no-audit', '--no-fund'], appDir);
    }
    const appBin = join(appDir, 'node_modules', 'pledgestack', 'dist', 'bin.js');
    if (!existsSync(appBin)) throw new Error(`Installed pledgestack has no dist/bin.js at ${appBin}`);

    // Optional: override the installed pledgepack binary with a local build.
    // Needed on Windows until a release ships the relative-path resolver fix
    // (published 0.3.3 resolves `./x` to `base/./x`, which fails exists() on
    // verbatim \\?\ paths). CI on Linux exercises the published artifact.
    const ppBinOverride = process.env.PLEDGEPACK_BINARY;
    if (ppBinOverride) {
      const platformKey = `${platform()}-${arch()}`;
      const binName = platform() === 'win32' ? 'pledge.exe' : 'pledge';
      const destDir = join(appDir, 'node_modules', 'pledgepack', 'bin', platformKey);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(ppBinOverride, join(destDir, binName));
      console.log(`  → pledgepack binary overridden with ${ppBinOverride}`);
    }

    // ── 4. Build ──────────────────────────────────────────────────────────
    console.log('\n\x1b[1m[4/6] pledge build\x1b[0m');
    await run('node', [appBin, 'build'], appDir, { env: { NODE_ENV: 'production' } });

    // ── 5. pledge start → curl ────────────────────────────────────────────
    console.log('\n\x1b[1m[5/6] pledge start → curl\x1b[0m');
    const start = await waitForServer(
      'node', [appBin, 'start', '--port', String(START_PORT), '--hostname', '127.0.0.1'],
      appDir,
      `http://127.0.0.1:${START_PORT}/`,
      { env: { NODE_ENV: 'production' } },
    );
    const homeHtml = await start.res.text();
    const health = await fetch(`http://127.0.0.1:${START_PORT}/api/health`).catch(() => null);
    await killTree(start.child);
    assertContains(homeHtml, 'Build faster with PledgeStack', 'GET / (start)');
    console.log('  ✓ GET / → 200 HTML');
    if (!health?.ok) {
      throw new Error(`/api/health returned ${health?.status ?? 'no response'}`);
    }
    console.log('  ✓ GET /api/health → 200 JSON');

    // ── 6. pledge dev → curl ──────────────────────────────────────────────
    console.log('\n\x1b[1m[6/6] pledge dev → curl\x1b[0m');
    const dev = await waitForServer(
      'node', [appBin, 'dev', '--port', String(DEV_PORT), '--hostname', '127.0.0.1'],
      appDir,
      `http://127.0.0.1:${DEV_PORT}/`,
      { timeoutMs: 180_000 },
    );
    const devHtml = await dev.res.text();
    await killTree(dev.child);
    assertContains(devHtml, 'Build faster with PledgeStack', 'GET / (dev)');
    console.log('  ✓ GET / → 200 HTML (dev server)');

    console.log('\n\x1b[32m✓ E2E smoke passed\x1b[0m — scaffold → install → build → start → dev all serve real responses\n');
  } finally {
    rmSync(tgzPath, { force: true });
    if (keep) {
      console.log(`  (kept workspace: ${workDir})`);
    } else {
      // Windows file locks linger briefly after taskkill exits — retry the
      // rmdir, and never let a cleanup failure mask the real test error.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(workDir, { recursive: true, force: true });
          break;
        } catch (e) {
          if (attempt === 4) {
            console.warn(`  ⚠ could not remove ${workDir}: ${e.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    }
  }
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: response did not contain ${JSON.stringify(needle)}\n---\n${haystack.slice(0, 2000)}`);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m✖ E2E smoke failed:\x1b[0m ${err.message}\n`);
  process.exit(1);
});
