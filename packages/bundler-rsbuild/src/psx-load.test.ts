import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psxRsbuildTransform } from './index';

describe('rsbuild plugin .psx transform', () => {
  it('compiles Rust (mocked cargo), writes the wrapper and returns the expanded module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rsbuild-psx-'));
    try {
      const file = join(dir, 'w.psx');
      await writeFile(file, ['<rust>', 'pub fn add(a: i32, b: i32) -> i32 { a + b }', '</rust>', 'export default function W() { return <div/>; }', ''].join('\n'));
      const built: string[] = [];
      const out = await psxRsbuildTransform(file, { rootDir: dir }, {
        build: async (req) => {
          built.push(req.crateId);
          await writeFile(req.addonPath, 'fake');
          return true;
        },
      });
      expect(built).toHaveLength(1);
      expect(out).toContain('import { rust } from "./.pledge-cache/w.napi.js";');
      expect(await readFile(join(dir, '.pledge-cache', 'w.napi.js'), 'utf-8')).toContain('addon.add_napi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
