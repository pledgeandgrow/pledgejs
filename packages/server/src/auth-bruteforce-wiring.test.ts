import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PledgeConfig } from 'pledgestack-shared';
import { createRequestHandler } from './handler';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('brute-force guard is fed by 401s from auth endpoints', () => {
  it('locks out a client after repeated failed logins without app code calling recordFailedAttempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-bf-'));
    dirs.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    mkdirSync(join(root, 'app', 'login'), { recursive: true });
    writeFileSync(join(root, 'app', 'login', 'route.ts'), 'export async function POST() { return new Response("no", { status: 401 }); }');
    mkdirSync(join(root, '.pledge', 'server', 'login'), { recursive: true });
    writeFileSync(join(root, '.pledge', 'server', 'login', 'route.js'), 'export async function POST() { return new Response("no", { status: 401 }); }');
    const config = {
      rootDir: root, appDir: 'app', publicDir: 'public', outDir: '.pledge',
      defaultRuntime: 'node', rsc: false, tailwind: false, output: 'standalone',
      csrf: false, rateLimit: false,
    } as unknown as PledgeConfig;
    const { handler } = createRequestHandler({ config, isDev: false });
    const attempt = () => handler({
      url: new URL('http://localhost:3000/login'),
      method: 'POST',
      headers: { host: 'localhost:3000' },
      body: null,
      remoteAddress: '203.0.113.77',
    });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[6]).toBe(429);
  });
});
