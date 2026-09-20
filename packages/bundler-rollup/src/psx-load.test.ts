import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pledgeStackRollupPlugin } from './index';

const PSX = [
  '<rust>',
  'pub fn add(a: i32, b: i32) -> i32 { a + b }',
  '</rust>',
  'export default function W() { return <div>w</div>; }',
  '',
].join('\n');

describe('rollup plugin .psx/.ps load hook', () => {
  it('compiles Rust (mocked cargo), writes the wrapper and returns the expanded module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rollup-psx-'));
    try {
      const file = join(dir, 'w.psx');
      await writeFile(file, PSX);
      const built: string[] = [];
      const plugin = pledgeStackRollupPlugin({ rootDir: dir } as never, {
        build: async (req) => {
          built.push(req.crateId);
          await writeFile(req.addonPath, 'fake');
          return true;
        },
      });
      const out = (await plugin.load(file)) as string;
      expect(built).toHaveLength(1);
      expect(out).toContain('import { rust } from "./.pledge-cache/w.napi.js";');
      expect(await readFile(join(dir, '.pledge-cache', 'w.napi.js'), 'utf-8')).toContain('addon.add_napi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('.ps files re-export the written wrapper; failed builds get the fallback stub', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rollup-ps-'));
    try {
      const file = join(dir, 'm.ps');
      await writeFile(file, 'pub fn add(a: i32, b: i32) -> i32 { a + b }');
      const plugin = pledgeStackRollupPlugin({ rootDir: dir } as never, { build: async () => false });
      const out = (await plugin.load(file)) as string;
      expect(out).toMatch(/^export \{ rust \} from ".*m\.napi\.js";/);
      expect(await readFile(join(dir, '.pledge-cache', 'm.napi.js'), 'utf-8')).toContain('Rust addon not compiled');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-psx ids', async () => {
    const plugin = pledgeStackRollupPlugin({ rootDir: process.cwd() } as never);
    expect(await plugin.load('/x/a.css')).toBeNull();
  });
});
