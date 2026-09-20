import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const loadersDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'loaders');
const nodeRequire = createRequire(import.meta.url);

/** Runs a webpack loader function the way webpack does (`this` = loader context). */
function runLoader(file: string, source: string, resourcePath: string, options: Record<string, unknown> = {}): Promise<string> {
  const loader = nodeRequire(join(loadersDir, file)) as (this: unknown, source: string) => void;
  return new Promise((resolve, reject) => {
    loader.call(
      {
        async: () => (err: Error | null, code?: string) => (err ? reject(err) : resolve(code ?? '')),
        resourcePath,
        getOptions: () => options,
      },
      source,
    );
  });
}

describe('webpack loaders', () => {
  // The package is "type": "module": a `.js` loader would be evaluated as ESM
  // and fail with "require is not defined", so loaders must be `.cjs`.
  it('the esbuild loader loads as CommonJS and compiles TSX', async () => {
    const out = await runLoader('webpack-esbuild-loader.cjs', 'export const A = () => <div>{1 as number}</div>;', '/x/a.tsx', { isDev: false });
    expect(out).not.toContain('as number');
    expect(out).toContain('react/jsx-runtime');
  });

  it('the esbuild loader can be told to treat a non-ts extension as tsx', async () => {
    const out = await runLoader('webpack-esbuild-loader.cjs', 'export const A = () => <b>x</b>;', '/x/a.psx', { loader: 'tsx' });
    expect(out).toContain('react/jsx-runtime');
  });

  it('the psx loader compiles Rust, writes the wrapper next to the source and expands PSX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'psx-loader-'));
    try {
      const file = join(dir, 'w.psx');
      const psx = ["<rust>", "pub fn add(a: i32, b: i32) -> i32 { a + b }", "</rust>", "export default function W() { return <div>w</div>; }", ""].join(String.fromCharCode(10));
      await writeFile(file, psx);
      const built: string[] = [];
      const out = await runLoader('webpack-psx-loader.cjs', psx, file, {
        isDev: false,
        config: { rootDir: dir },
        // Mocked cargo step: the test must not need a Rust toolchain.
        build: async (req: { addonPath: string; crateId: string }) => {
          built.push(req.crateId);
          await writeFile(req.addonPath, 'fake');
          return true;
        },
      });
      expect(out).toContain('import { rust } from "./.pledge-cache/w.napi.js";');
      expect(out).not.toContain('<rust>');
      expect(built).toHaveLength(1);
      // The wrapper the import points at actually exists and is the real one.
      expect(await readFile(join(dir, '.pledge-cache', 'w.napi.js'), 'utf-8')).toContain('addon.add_napi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
