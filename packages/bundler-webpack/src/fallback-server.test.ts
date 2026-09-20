import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';
import type { PledgeConfig } from 'pledgestack-shared';
import { webpackAdapter } from './index';

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

function get(port: number, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Deliberately does NOT chdir: the fallback server must use config.rootDir, not process.cwd().
describe('webpack dev-server fallback: rootDir + content types', () => {
  let dir: string;
  let handle: Awaited<ReturnType<typeof webpackAdapter.startDevServer>>;
  let port: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-fb-'));
    await mkdir(join(dir, 'app'), { recursive: true });
    await writeFile(join(dir, 'app', 'page.ts'), 'export default function P() { return 1; }\n');
    await writeFile(join(dir, 'app', 'style.css'), 'body{color:red}');
    await writeFile(join(dir, 'app', 'data.json'), '{"a":1}');
    port = await freePort();
    const config = { rootDir: dir, appDir: 'app', outDir: '.pledge-out' } as PledgeConfig;
    handle = await webpackAdapter.startDevServer(config, { port: 3000, bundlerPort: port, hostname: '127.0.0.1' });
  });
  afterAll(async () => {
    await handle?.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('resolves files against rootDir instead of the process cwd', async () => {
    const res = await get(port, '/app/page.ts');
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/javascript');
  });

  it('serves CSS as text/css, untouched', async () => {
    const res = await get(port, '/app/style.css');
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/css');
    expect(res.body).toBe('body{color:red}');
  });

  it('serves JSON as application/json', async () => {
    const res = await get(port, '/app/data.json');
    expect(res.type).toContain('application/json');
  });
});
