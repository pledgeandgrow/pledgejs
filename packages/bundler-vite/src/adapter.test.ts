import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { PledgeConfig } from 'pledgestack-shared';
import { viteAdapter } from './index';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SOURCE = 'const answer: number = 42;\nexport default function Page() { return answer; }\n';

describe('vite adapter', () => {
  let dir: string;
  let prevCwd: string;

  beforeAll(async () => {
    prevCwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'pledge-bundler-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'page.ts'), SOURCE);
    await writeFile(join(dir, 'app', 'style.css'), 'body{color:red}');
    await writeFile(join(dir, 'secret.txt'), 'top secret');
    process.chdir(dir);
  });

  afterAll(async () => {
    process.chdir(prevCwd);
    // Best-effort cleanup: Windows can briefly hold directory handles after chdir.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('identifies itself', () => {
    expect(viteAdapter.name).toBe('vite');
    expect(typeof viteAdapter.build).toBe('function');
    expect(typeof viteAdapter.startDevServer).toBe('function');
    expect(typeof viteAdapter.transformFile).toBe('function');
  });

  it('transformFile compiles TypeScript to JavaScript with an inline sourcemap', async () => {
    const { fileUrl } = await viteAdapter.transformFile(join(dir, 'app', 'page.ts'), { isDev: false });
    const out = await readFile(fileURLToPath(fileUrl), 'utf-8');
    expect(out).not.toContain(': number');
    expect(out).toMatch(/Page as default/);
    expect(out).toContain('sourceMappingURL=data:application/json');
  });

  it('caches production transforms', async () => {
    const file = join(dir, 'app', 'page.ts');
    await viteAdapter.transformFile(file, { isDev: false });
    const again = await viteAdapter.transformFile(file, { isDev: false });
    expect(again.cached).toBe(true);
  });

  it('passes non-script files through untouched', async () => {
    const css = join(dir, 'app', 'style.css');
    const { fileUrl } = await viteAdapter.transformFile(css, { isDev: false });
    expect(fileURLToPath(fileUrl)).toBe(css);
  });

  it('resolveProductionPath falls back to the source when nothing was built', () => {
    const config = { rootDir: dir, appDir: 'app', outDir: '.pledge' } as PledgeConfig;
    const src = join(dir, 'app', 'page.ts');
    expect(viteAdapter.resolveProductionPath?.(src, config)).toBe(src);
  });

  it('builds real server and client bundles from the route files (not the app directory)', async () => {
    const proj = await mkdtemp(join(tmpdir(), 'pledge-vite-build-'));
    try {
      await mkdir(join(proj, 'app', 'users'), { recursive: true });
      await writeFile(join(proj, 'app', 'page.ts'), SOURCE);
      await writeFile(join(proj, 'app', 'users', 'page.ts'), SOURCE);
      // Not routes: must not become build entries (a test file would drag in vitest).
      await writeFile(join(proj, 'app', 'page.test.ts'), "import 'vitest';\n");
      await writeFile(join(proj, 'app', 'types.d.ts'), 'export {};\n');
      const config = { rootDir: proj, appDir: 'app', outDir: '.pledge', output: 'server' } as PledgeConfig;
      const result = await viteAdapter.build(config);
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      // resolveProductionPath looks for <outDir>/server/<route>.js
      expect(existsSync(join(proj, '.pledge', 'server', 'page.js'))).toBe(true);
      expect(existsSync(join(proj, '.pledge', 'server', 'users', 'page.js'))).toBe(true);
      expect(viteAdapter.resolveProductionPath?.(join(proj, 'app', 'users', 'page.ts'), config)).toBe(
        join(proj, '.pledge', 'server', 'users', 'page.js'),
      );
      expect(existsSync(join(proj, '.pledge', 'client', 'assets'))).toBe(true);
    } finally {
      await rm(proj, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }, 60000);

  describe('dev server / HMR (vite mocked)', () => {
    it('starts the Vite dev server with HMR on and wires reload to the websocket', async () => {
      const sent: unknown[] = [];
      const invalidated: unknown[] = [];
      const listen = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const createServer = vi.fn(async () => ({
        listen,
        close,
        ws: { send: (m: unknown) => sent.push(m) },
        moduleGraph: {
          getModuleById: (id: string) => (id === '/known.ts' ? { id } : undefined),
          invalidateModule: (m: unknown) => invalidated.push(m),
        },
      }));
      vi.doMock('vite', () => ({ createServer }));
      vi.resetModules();
      const { viteAdapter } = await import('./index');

      const config = { rootDir: dir, appDir: 'app', outDir: '.pledge-out' } as PledgeConfig;
      const handle = await viteAdapter.startDevServer(config, { port: 3000, bundlerPort: 4321, hostname: '127.0.0.1' });

      expect(listen).toHaveBeenCalled();
      const opts = createServer.mock.calls[0][0] as { server: { hmr: boolean; port: number } };
      expect(opts.server.hmr).toBe(true);
      expect(opts.server.port).toBe(4321);

      // reload() of a known module invalidates it and triggers a browser reload.
      handle.reload?.('/known.ts');
      expect(invalidated).toHaveLength(1);
      expect(sent).toEqual([{ type: 'full-reload' }]);
      // reload() of an unknown module is a no-op (nothing to invalidate).
      handle.reload?.('/unknown.ts');
      expect(sent).toHaveLength(1);
      handle.reloadAll?.();
      expect(sent).toHaveLength(2);

      await handle.stop();
      expect(close).toHaveBeenCalled();
      vi.doUnmock('vite');
    });

    it('build reports failure (not a throw) when the Vite build rejects', async () => {
      vi.doMock('vite', () => ({ build: async () => { throw new Error('boom'); } }));
      vi.resetModules();
      const { viteAdapter } = await import('./index');
      const config = { rootDir: dir, appDir: 'app', outDir: '.pledge-out' } as PledgeConfig;
      const result = await viteAdapter.build(config);
      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
      vi.doUnmock('vite');
    });
  });

});
