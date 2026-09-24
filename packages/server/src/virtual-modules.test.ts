import { describe, it, expect } from 'vitest';
import { tryServeRouterModule, computeAssetIntegrity, generateClientScriptCode } from './virtual-modules';
import type { PledgeConfig } from 'pledgestack-shared';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('tryServeRouterModule', () => {
  let tempDir: string;

  function createTempApp(files: Record<string, string>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'pledge-test-'));
    const appDir = join(tempDir, 'app');
    mkdirSync(appDir, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(appDir, path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
    return tempDir;
  }

  function mockConfig(rootDir: string): PledgeConfig {
    return {
      rootDir,
      appDir: 'app',
      publicDir: 'public',
      outDir: '.pledge',
      defaultRuntime: 'node',
      rsc: false,
      tailwind: false,
      output: 'standalone',
    } as PledgeConfig;
  }

  function mockReqRes(pathname: string) {
    const req = { url: pathname } as any;
    const state = { sentCode: 0, sentBody: '' };
    const res = {
      writeHead: (code: number, _headers?: Record<string, string>) => { state.sentCode = code; },
      end: (body?: string) => { state.sentBody = body ?? ''; },
    } as any;
    return { req, res, state };
  }

  it('returns false for non-router paths', () => {
    const dir = createTempApp({});
    try {
      const { req, res } = mockReqRes('/some-page');
      const result = tryServeRouterModule(req as any, res as any, mockConfig(dir));
      expect(result).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serves router module for /__pledge_router', () => {
    const dir = createTempApp({
      'page.tsx': 'export default function Page() { return null; }',
      'about/page.tsx': 'export default function About() { return null; }',
    });
    try {
      const { req, res, state } = mockReqRes('/__pledge_router');
      const result = tryServeRouterModule(req as any, res as any, mockConfig(dir));
      expect(result).toBe(true);
      expect(state.sentCode).toBe(200);
      expect(state.sentBody).toContain('export const routes');
      expect(state.sentBody).toContain('import');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('imports API routes with named exports', () => {
    const dir = createTempApp({
      'api/users/route.ts': 'export async function GET() { return Response.json({}); }',
    });
    try {
      const { req, res, state } = mockReqRes('/__pledge_router');
      tryServeRouterModule(req as any, res as any, mockConfig(dir));
      expect(state.sentCode).toBe(200);
      expect(state.sentBody).toContain('import * as');
      expect(state.sentBody).toContain("type: 'api'");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('imports page routes with default export', () => {
    const dir = createTempApp({
      'page.tsx': 'export default function Page() { return null; }',
    });
    try {
      const { req, res, state } = mockReqRes('/__pledge_router');
      tryServeRouterModule(req as any, res as any, mockConfig(dir));
      expect(state.sentCode).toBe(200);
      expect(state.sentBody).toContain('import mod_');
      expect(state.sentBody).toContain('component:');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('tryServeRouterModule route-map keys', () => {
  it('does not collide layout and page at the same pattern', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pledge-keys-'));
    const appDir = join(tempDir, 'app');
    mkdirSync(join(appDir, 'blog'), { recursive: true });
    writeFileSync(join(appDir, 'layout.tsx'), 'export default function L(){return null}');
    writeFileSync(join(appDir, 'page.tsx'), 'export default function P(){return null}');
    writeFileSync(join(appDir, 'blog', 'layout.tsx'), 'export default function L(){return null}');
    writeFileSync(join(appDir, 'blog', 'page.tsx'), 'export default function P(){return null}');
    try {
      let body = '';
      const res = { writeHead() {}, end(b: string) { body = b; } } as any;
      tryServeRouterModule({ url: '/__pledge_router' } as any, res, {
        rootDir: tempDir, appDir: 'app',
      } as PledgeConfig);
      const keys = [...body.matchAll(/^ {2}("[^"]+"): \{ type/gm)].map((m) => m[1]);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain('"layout:/"');
      expect(keys).toContain('"layout:/blog"');
      expect(keys).toContain('"/"');
      expect(keys).toContain('"/blog"');
      expect(body).toContain('resolveRouteChain');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('computeAssetIntegrity (SRI)', () => {
  const config = {
    rootDir: '/nonexistent-test-root',
    appDir: 'app',
    publicDir: 'public',
    outDir: '.pledge',
    defaultRuntime: 'node',
    rsc: false,
    tailwind: false,
    output: 'standalone',
  } as PledgeConfig;

  it('produces sha384 hashes for emitted client scripts', async () => {
    const integrity = await computeAssetIntegrity(config, false);
    expect(integrity['/__pledge__/client.js']).toMatch(/^sha384-[A-Za-z0-9+/]+={0,2}$/);
    expect(integrity['/__pledge__/rsc-client.js']).toMatch(/^sha384-/);
  });

  it('hash matches the exact bytes served for client.js', async () => {
    const integrity = await computeAssetIntegrity(config, false);
    const served = generateClientScriptCode(config, false);
    const digest = await crypto.subtle.digest('SHA-384', new TextEncoder().encode(served));
    const expected = `sha384-${Buffer.from(digest).toString('base64')}`;
    expect(integrity['/__pledge__/client.js']).toBe(expected);
  });

  it('omits client.css when no stylesheet was emitted', async () => {
    const integrity = await computeAssetIntegrity(config, false);
    expect(integrity['/__pledge__/client.css']).toBeUndefined();
  });
});

describe('image endpoint file restrictions', () => {
  it('does not serve dotfiles or non-image files from public/', async () => {
    const { tryServePledgeVirtual } = await import('./virtual-modules');
    const root = mkdtempSync(join(tmpdir(), 'pledge-img-'));
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'public', '.env'), 'SECRET=1');
    writeFileSync(join(root, 'public', 'notes.txt'), 'private');
    writeFileSync(join(root, 'public', 'a.png'), 'png');
    const config = { rootDir: root, appDir: 'app', publicDir: 'public', outDir: '.pledge' } as PledgeConfig;
    const call = async (url: string) => {
      const out = { code: 0, body: '' };
      const res = { writeHead: (c: number) => { out.code = c; }, end: (b?: string) => { out.body = String(b ?? ''); } } as any;
      await tryServePledgeVirtual({ url } as any, res, config, false);
      return out;
    };
    expect((await call('/__pledge__/image/.env')).code).toBe(404);
    expect((await call('/_pledge/image?src=notes.txt')).code).toBe(404);
    expect((await call('/__pledge__/image/a.png')).code).toBe(200);
    rmSync(root, { recursive: true, force: true });
  });
});
