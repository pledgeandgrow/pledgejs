import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { PledgeConfig } from 'pledgestack-shared';
import { rsbuildAdapter, buildAliasMap } from './index';

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

describe('rsbuild adapter', () => {
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
    expect(rsbuildAdapter.name).toBe('rsbuild');
    expect(typeof rsbuildAdapter.build).toBe('function');
    expect(typeof rsbuildAdapter.startDevServer).toBe('function');
    expect(typeof rsbuildAdapter.transformFile).toBe('function');
  });

  it('transformFile compiles TypeScript to JavaScript with an inline sourcemap', async () => {
    const { fileUrl } = await rsbuildAdapter.transformFile(join(dir, 'app', 'page.ts'), { isDev: false });
    const out = await readFile(fileURLToPath(fileUrl), 'utf-8');
    expect(out).not.toContain(': number');
    expect(out).toMatch(/Page as default/);
    expect(out).toContain('sourceMappingURL=data:application/json');
  });

  it('caches production transforms', async () => {
    const file = join(dir, 'app', 'page.ts');
    await rsbuildAdapter.transformFile(file, { isDev: false });
    const again = await rsbuildAdapter.transformFile(file, { isDev: false });
    expect(again.cached).toBe(true);
  });

  it('passes non-script files through untouched', async () => {
    const css = join(dir, 'app', 'style.css');
    const { fileUrl } = await rsbuildAdapter.transformFile(css, { isDev: false });
    expect(fileURLToPath(fileUrl)).toBe(css);
  });

  it('resolveProductionPath falls back to the source when nothing was built', () => {
    const config = { rootDir: dir, appDir: 'app', outDir: '.pledge' } as PledgeConfig;
    const src = join(dir, 'app', 'page.ts');
    expect(rsbuildAdapter.resolveProductionPath?.(src, config)).toBe(src);
  });

  it('build (esbuild fallback) emits compiled server modules', async () => {
    const config = { rootDir: dir, appDir: 'app', outDir: '.pledge-out' } as PledgeConfig;
    const result = await rsbuildAdapter.build(config);
    expect(result.success).toBe(true);
    const emitted = join(dir, '.pledge-out', 'server', 'page.js');
    expect(existsSync(emitted)).toBe(true);
    expect(await readFile(emitted, 'utf-8')).not.toContain(': number');
  });

  describe('dev server (esbuild fallback)', () => {
    let port: number;
    let handle: Awaited<ReturnType<typeof rsbuildAdapter.startDevServer>>;

    beforeAll(async () => {
      port = await freePort();
      const config = { rootDir: dir, appDir: 'app', outDir: '.pledge-out' } as PledgeConfig;
      handle = await rsbuildAdapter.startDevServer(config, { port: 3000, bundlerPort: port, hostname: '127.0.0.1' });
    });
    afterAll(async () => { await handle?.stop(); });

    it('serves transformed modules', async () => {
      const res = await get(port, '/app/page.ts');
      expect(res.status).toBe(200);
      expect(res.body).toMatch(/Page as default/);
      expect(res.body).not.toContain(': number');
    });

    it('404s unknown files', async () => {
      expect((await get(port, '/app/nope.ts')).status).toBe(404);
    });

    it('rejects path traversal outside the project root', async () => {
      const res = await get(port, '/%2e%2e/%2e%2e/etc/passwd');
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('root:');
    });

    it('does not leak files through encoded traversal to a sibling secret', async () => {
      const res = await get(port, '/app/%2e%2e/%2e%2e/secret.txt');
      expect(res.status).toBe(403);
    });
  });

});

describe('rsbuild alias map', () => {
  it('turns tsconfig-style wildcard aliases into plain prefixes', () => {
    const map = buildAliasMap({ rootDir: '/proj', appDir: 'app', alias: { '@/lib/*': 'lib/*', '~': 'src' } } as unknown as PledgeConfig);
    expect(map['@/lib']?.replace(/\\/g, '/')).toBe('/proj/lib');
    expect(map['@/lib/*']).toBeUndefined();
    expect(map['~']?.replace(/\\/g, '/')).toBe('/proj/src');
    expect(map['@']?.replace(/\\/g, '/')).toBe('/proj/app');
  });
});
