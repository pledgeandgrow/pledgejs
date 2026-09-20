import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

// The real adapter shells out to the native pledgepack binary. Replace the
// resolver so tests exercise adapter logic (failure reporting, production path
// resolution) without spawning processes.
vi.mock('./binary-resolver', () => ({
  resolveBinary: vi.fn(() => null),
  runPledgepack: vi.fn(() => { throw new Error('pledgepack binary not found (mocked)'); }),
}));

import { pledgepackAdapter, pledgepackAliasArgs, buildPledgepackAliasMap } from './index';
import { runPledgepack } from './binary-resolver';
import { readFile } from 'node:fs/promises';

describe('pledgepack adapter', () => {
  let dir: string;
  let config: PledgeConfig;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-pp-'));
    config = { rootDir: dir, appDir: 'app', outDir: '.pledge' } as PledgeConfig;
    await mkdir(join(dir, 'app'), { recursive: true });
    await mkdir(join(dir, '.pledge', 'server'), { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('identifies itself as pledgepack', () => {
    expect(pledgepackAdapter.name).toBe('pledgepack');
  });

  it('build returns a failed BuildResult (does not throw) when the binary is missing', async () => {
    const result = await pledgepackAdapter.build(config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('binary not found');
    expect(result.outDir).toBe(join(dir, '.pledge'));
  });

  it('startDevServer throws an actionable error when the binary cannot be resolved', async () => {
    await expect(
      pledgepackAdapter.startDevServer(config, { port: 3000, bundlerPort: 4999, hostname: '127.0.0.1' }),
    ).rejects.toThrow(/PledgePack binary not found/);
  });

  describe('resolveProductionPath', () => {
    it('maps a source file to its built .js module', async () => {
      await mkdir(join(dir, '.pledge', 'server', 'about'), { recursive: true });
      const built = join(dir, '.pledge', 'server', 'about', 'page.js');
      await writeFile(built, 'export default 1');
      expect(pledgepackAdapter.resolveProductionPath!(join(dir, 'app', 'about', 'page.tsx'), config)).toBe(built);
    });

    it('falls back to .mjs when only that exists', async () => {
      await mkdir(join(dir, '.pledge', 'server', 'blog'), { recursive: true });
      const built = join(dir, '.pledge', 'server', 'blog', 'page.mjs');
      await writeFile(built, 'export default 1');
      expect(pledgepackAdapter.resolveProductionPath!(join(dir, 'app', 'blog', 'page.tsx'), config)).toBe(built);
    });

    it('prefers the route manifest when it names the file', async () => {
      await mkdir(join(dir, '.pledge', 'server', 'shop'), { recursive: true });
      const built = join(dir, '.pledge', 'server', 'shop', 'page.js');
      await writeFile(built, 'export default 1');
      await writeFile(
        join(dir, '.pledge', '__pledge_ps_manifest.json'),
        JSON.stringify({ schema_version: 1, frontend: [{ file: 'shop/page.tsx' }], api: [], backend: [] }),
      );
      expect(pledgepackAdapter.resolveProductionPath!(join(dir, 'app', 'shop', 'page.tsx'), config)).toBe(built);
    });

    it('throws a descriptive error when nothing was built', () => {
      expect(() => pledgepackAdapter.resolveProductionPath!(join(dir, 'app', 'missing', 'page.tsx'), config)).toThrow(
        /Production module not found[\s\S]*Did you run "pledge build"/,
      );
    });
  });

  describe('config.alias', () => {
    it('builds root-anchored plain-prefix aliases', () => {
      const c = { ...config, alias: { '@lib/*': 'lib/*' } } as PledgeConfig;
      expect(buildPledgepackAliasMap(c)).toEqual({ '@lib': join(dir, 'lib') });
    });

    it('returns no flags when no aliases are configured', async () => {
      expect(await pledgepackAliasArgs(config)).toEqual([]);
    });

    it('writes a merged pledgepack config and points the binary at it', async () => {
      await writeFile(join(dir, 'pledge.json'), JSON.stringify({ resolve: { alias: { old: '/x' }, extensions: ['.ts'] }, mode: 'production' }));
      const c = { ...config, alias: { '@lib/*': 'lib/*' } } as PledgeConfig;
      const args = await pledgepackAliasArgs(c);
      expect(args[0]).toBe('--root');
      const cfgPath = args[args.indexOf('--config') + 1];
      const written = JSON.parse(await readFile(cfgPath, 'utf-8'));
      expect(written.mode).toBe('production');
      expect(written.resolve.extensions).toEqual(['.ts']);
      expect(written.resolve.alias).toEqual({ old: '/x', '@lib': join(dir, 'lib') });
      await rm(join(dir, 'pledge.json'));
    });

    it('build passes the alias config flags to the binary', async () => {
      const c = { ...config, alias: { '@lib/*': 'lib/*' } } as PledgeConfig;
      vi.mocked(runPledgepack).mockClear();
      await pledgepackAdapter.build(c);
      const args = vi.mocked(runPledgepack).mock.calls[0][0] as string[];
      expect(args).toContain('--config');
      expect(args).toContain('build');
    });
  });
});
