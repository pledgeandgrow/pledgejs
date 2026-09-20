import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compilePSXModule,
  compileRustAddon,
  psxCrateId,
  psxLoadOutput,
  resetCompilationState,
  type RustBuildFn,
} from './compile-module';

const PSX = (n: number) => `<rust>
pub fn add(a: i32, b: i32) -> i32 { a + b + ${n} }
</rust>
export default function P() { return <div/>; }
`;

let root: string;

/** A build that "compiles" by writing the addon file (no cargo needed). */
const okBuild = (log: string[] = []): RustBuildFn => async (req) => {
  log.push(req.crateId);
  await writeFile(req.addonPath, 'fake-addon');
  return true;
};

beforeEach(async () => {
  resetCompilationState();
  root = await mkdtemp(join(tmpdir(), 'psx-compile-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('compilePSXModule', () => {
  it('writes artifacts, builds, and writes the real wrapper', async () => {
    const dir = join(root, 'app', 'a');
    await mkdir(dir, { recursive: true });
    const src = join(dir, 'page.psx');
    await writeFile(src, PSX(0));

    const log: string[] = [];
    const out = await compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build: okBuild(log) });

    expect(out.addonReady).toBe(true);
    expect(log).toEqual([psxCrateId(src, root)]);
    expect(await readFile(out.wrapperPath, 'utf-8')).toContain('addon.add_napi');
    expect(existsSync(join(dir, '.pledge-cache', 'page.d.ts'))).toBe(true);
    expect(existsSync(join(dir, '.pledge-cache', 'rust', 'page', 'lib.rs'))).toBe(true);
    // The emitted TSX imports the wrapper relative to the source file.
    expect(out.result.tsx).toContain('import { rust } from "./.pledge-cache/page.napi.js";');
    // Cargo.toml uses the unique crate id.
    const toml = await readFile(join(dir, '.pledge-cache', 'rust', 'page', 'Cargo.toml'), 'utf-8');
    expect(toml).toContain(`name = "pledge-${psxCrateId(src, root)}"`);
  });

  it('writes the fallback stub (not the real wrapper) when the build fails', async () => {
    const src = join(root, 'x.psx');
    await writeFile(src, PSX(0));
    const out = await compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build: async () => false });
    expect(out.addonReady).toBe(false);
    expect(await readFile(out.wrapperPath, 'utf-8')).toContain('Rust addon not compiled');
  });

  it('.ps files load as a re-export of the wrapper', async () => {
    const src = join(root, 'math.ps');
    await writeFile(src, 'pub fn add(a: i32, b: i32) -> i32 { a + b }');
    const out = await compilePSXModule({ sourcePath: src, isDev: false, projectRoot: root, build: okBuild() });
    const code = psxLoadOutput(out, 'ps');
    expect(code).toMatch(/^export \{ rust \} from ".*math\.napi\.js";/);
  });
});

describe('two page.psx files in different directories do not collide', () => {
  it('get distinct crate names, addons, hashes and compile state', async () => {
    const a = join(root, 'app', 'a', 'page.psx');
    const b = join(root, 'app', 'b', 'page.psx');
    await mkdir(join(root, 'app', 'a'), { recursive: true });
    await mkdir(join(root, 'app', 'b'), { recursive: true });
    await writeFile(a, PSX(1));
    await writeFile(b, PSX(2));

    expect(psxCrateId(a, root)).not.toBe(psxCrateId(b, root));

    const log: string[] = [];
    const [ra, rb] = await Promise.all([
      compilePSXModule({ sourcePath: a, isDev: true, projectRoot: root, build: okBuild(log) }),
      compilePSXModule({ sourcePath: b, isDev: true, projectRoot: root, build: okBuild(log) }),
    ]);

    // Both were built (neither was skipped as "already compiling"/up to date).
    expect(new Set(log).size).toBe(2);
    expect(ra.addonReady && rb.addonReady).toBe(true);
    expect(ra.cacheDir).not.toBe(rb.cacheDir);
    const ta = await readFile(join(ra.cacheDir, 'rust', 'page', 'Cargo.toml'), 'utf-8');
    const tb = await readFile(join(rb.cacheDir, 'rust', 'page', 'Cargo.toml'), 'utf-8');
    expect(ta).not.toBe(tb);
    expect(await readFile(join(ra.cacheDir, 'rust', 'page', 'lib.rs'), 'utf-8')).toContain('+ 1 }');
    expect(await readFile(join(rb.cacheDir, 'rust', 'page', 'lib.rs'), 'utf-8')).toContain('+ 2 }');
  });
});

describe('pendingRecompile', () => {
  it('re-runs the build after the in-flight one when the source changed meanwhile', async () => {
    const src = join(root, 'page.psx');
    await writeFile(src, PSX(1));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const builtSources: string[] = [];
    let calls = 0;
    const build: RustBuildFn = async (req) => {
      calls++;
      builtSources.push(await readFile(join(req.rustDir, 'lib.rs'), 'utf-8'));
      if (calls === 1) await gate; // hold the first build open
      await writeFile(req.addonPath, 'x');
      return true;
    };

    const p1 = compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build });
    await vi.waitFor(() => expect(calls).toBe(1));

    // Edit the file and request a compile while the first build is in flight.
    await writeFile(src, PSX(2));
    const p2 = compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1); // still serialized, not started concurrently

    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(2); // pending recompile ran
    expect(builtSources[0]).toContain('+ 1 }');
    expect(builtSources[1]).toContain('+ 2 }');
    expect(r1.addonReady && r2.addonReady).toBe(true);
    // The saved hash matches the latest source, so a further request is a no-op.
    await compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build });
    expect(calls).toBe(2);
  });

  it('does not rebuild when the in-flight build already has the same source', async () => {
    const src = join(root, 'page.psx');
    await writeFile(src, PSX(1));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const build: RustBuildFn = async (req) => {
      calls++;
      await gate;
      await writeFile(req.addonPath, 'x');
      return true;
    };
    const p1 = compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build });
    await vi.waitFor(() => expect(calls).toBe(1));
    const p2 = compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build });
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('notifies onAddonBuilt for each successful build', async () => {
    const src = join(root, 'page.psx');
    await writeFile(src, PSX(1));
    const built = vi.fn();
    await compilePSXModule({ sourcePath: src, isDev: true, projectRoot: root, build: okBuild(), onAddonBuilt: built });
    expect(built).toHaveBeenCalledWith({ moduleName: 'page', sourcePath: src });
  });
});

describe('compileRustAddon', () => {
  it('a throwing build resolves false and clears the compiling flag', async () => {
    const dir = join(root, '.pledge-cache', 'rust', 'm');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lib.rs'), '// x');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = {
      rustDir: dir, crateId: 'm_1', moduleName: 'm', cacheDir: join(root, '.pledge-cache'),
      addonPath: join(root, '.pledge-cache', 'm.node'), isDev: true, sourceFilePath: join(root, 'm.psx'),
      projectRoot: root, sourceMap: [],
    };
    expect(await compileRustAddon(req, async () => { throw new Error('boom'); })).toBe(false);
    // Not stuck "compiling": a following call runs the build again.
    const build = vi.fn(async (r: typeof req) => { await writeFile(r.addonPath, 'x'); return true; });
    expect(await compileRustAddon(req, build)).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
