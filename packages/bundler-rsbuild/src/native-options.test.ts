import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

const calls: Array<Record<string, any>> = [];
vi.mock('@rsbuild/core', () => ({
  createRsbuild: async (opts: Record<string, any>) => {
    calls.push(opts);
    return {
      build: async () => {},
      startDevServer: async () => ({ port: 1234 }),
      close: async () => {},
    };
  },
}));

import { rsbuildAdapter } from './index';

describe('rsbuild native createRsbuild options', () => {
  let dir: string;
  let config: PledgeConfig;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-rsb-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'page.ts'), 'export default 1');
    config = { rootDir: dir, appDir: 'app', outDir: '.pledge', alias: { '@lib/*': 'lib/*' } } as PledgeConfig;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('build passes entry/output/tools under `config`, not at top level', async () => {
    calls.length = 0;
    const result = await rsbuildAdapter.build(config);
    expect(result.success).toBe(true);
    const opts = calls[0];
    expect(opts.entry).toBeUndefined();
    expect(opts.output).toBeUndefined();
    expect(opts.tools).toBeUndefined();
    expect(opts.cwd).toBe(dir);
    expect(opts.config.source.entry).toEqual({ page: join(dir, 'app', 'page.ts') });
    expect(opts.config.output.distPath.root).toBe(join(dir, '.pledge'));
    expect(opts.config.tools.rspack.resolve.alias['@lib']).toBe(join(dir, 'lib'));
  });

  it('dev server passes entry/server/hmr under `config`', async () => {
    calls.length = 0;
    const handle = await rsbuildAdapter.startDevServer(config, { port: 3000, bundlerPort: 1234, hostname: '127.0.0.1' });
    const opts = calls[0];
    expect(opts.entry).toBeUndefined();
    expect(opts.server).toBeUndefined();
    expect(opts.config.source.entry).toEqual({ page: join(dir, 'app', 'page.ts') });
    expect(opts.config.server).toEqual({ port: 1234, host: '127.0.0.1' });
    expect(opts.config.dev.hmr).toBe(true);
    await handle.stop();
  });
});
