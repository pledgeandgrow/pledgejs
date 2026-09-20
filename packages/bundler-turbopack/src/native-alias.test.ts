import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

const calls: Array<{ kind: string; opts: any }> = [];
vi.mock('@utoo/pack', () => ({
  build: async (opts: unknown) => { calls.push({ kind: 'build', opts }); },
  dev: async (opts: unknown) => { calls.push({ kind: 'dev', opts }); return { stop: async () => {} }; },
}));

import { turbopackAdapter, buildAliasMap } from './index';

describe('turbopack config.alias', () => {
  let dir: string;
  let config: PledgeConfig;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-tp-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'page.ts'), 'export default 1');
    config = { rootDir: dir, appDir: 'app', outDir: '.pledge', alias: { '@lib/*': 'lib/*', '~': 'src' } } as PledgeConfig;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('buildAliasMap strips wildcards and anchors to rootDir', () => {
    expect(buildAliasMap(config)).toEqual({
      '@lib': join(dir, 'lib'),
      '~': join(dir, 'src'),
      '@': join(dir, 'app'),
    });
  });

  it('native build forwards aliases as resolve.alias', async () => {
    calls.length = 0;
    const result = await turbopackAdapter.build(config);
    expect(result.success).toBe(true);
    expect(calls[0].opts.config.resolve.alias['@lib']).toBe(join(dir, 'lib'));
  });

  it('native dev server forwards aliases as resolve.alias', async () => {
    calls.length = 0;
    const handle = await turbopackAdapter.startDevServer(config, { port: 3000, bundlerPort: 4000, hostname: '127.0.0.1' });
    expect(calls[0].kind).toBe('dev');
    expect(calls[0].opts.config.resolve.alias['~']).toBe(join(dir, 'src'));
    await handle.stop();
  });
});
