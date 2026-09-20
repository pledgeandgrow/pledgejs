import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand, detectPackageManager } from './init';

// The alias-sync / route-type steps pull in the whole framework; they are
// best-effort in init and irrelevant to install behaviour, so stub them.
vi.mock('../config-loader', () => ({ loadConfig: vi.fn(async () => ({})) }));
vi.mock('./sync-aliases', () => ({ syncAliasesCommand: vi.fn(async () => {}) }));
vi.mock('pledgestack-core', () => ({ writeRouteTypes: vi.fn(async () => {}) }));

describe('pledge init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-init-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    // Never touch the network in tests.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('--skip-install scaffolds the project but never invokes the package manager', async () => {
    const installer = vi.fn(async () => 0);
    await initCommand({ rootDir: dir, skipInstall: true, installer });

    expect(installer).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'pledge.config.ts'))).toBe(true);
    expect(existsSync(join(dir, 'app', 'page.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'app', 'layout.tsx'))).toBe(true);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    expect(pkg.scripts.dev).toBe('pledge dev');
    expect(pkg.devDependencies.pledgestack).toBeDefined();
  });

  it('without --skip-install it runs the detected package manager in the project dir', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const installer = vi.fn(async () => 0);
    await initCommand({ rootDir: dir, installer });

    expect(installer).toHaveBeenCalledTimes(1);
    expect(installer).toHaveBeenCalledWith('pnpm', dir);
  });

  it('a failing install does not fail the init and leaves the scaffold in place', async () => {
    const installer = vi.fn(async () => 1);
    await expect(initCommand({ rootDir: dir, installer })).resolves.toBeUndefined();
    expect(existsSync(join(dir, 'pledge.config.ts'))).toBe(true);
  });

  it('skips installing when there is no package.json', async () => {
    await rm(join(dir, 'package.json'));
    const installer = vi.fn(async () => 0);
    await initCommand({ rootDir: dir, installer });
    expect(installer).not.toHaveBeenCalled();
  });
});

describe('detectPackageManager', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pledge-pm-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads lockfiles, then the packageManager field, then falls back to npm', async () => {
    expect(await detectPackageManager(dir)).toBe('npm');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    expect(await detectPackageManager(dir)).toBe('yarn');
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });
});
