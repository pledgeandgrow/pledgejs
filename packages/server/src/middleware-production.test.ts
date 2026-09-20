import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PledgeConfig } from 'pledgestack-shared';
import { createModuleLoader } from './module-loader';
import { createRequestHandler } from './handler';
import { serverAction } from './actions';

/**
 * End-to-end behavior of `middleware.ts` across `pledge build` -> `pledge start`:
 * production must load the BUILT middleware (.pledge/server/middleware.*) and
 * must refuse to run without it rather than silently dropping auth.
 */

const AUTH_MW = `
export const matcher = ['/dashboard/:path*'];
export default async function middleware(req) {
  if (req.headers.get('authorization') === 'Bearer ok') return { next: true };
  return { redirect: { destination: '/login' } };
}
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeApp(opts: { built: boolean; sourceExt?: string; sourceBody?: string }): { root: string; config: PledgeConfig } {
  const root = mkdtempSync(join(tmpdir(), 'pledge-mw-'));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const appDir = join(root, 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'page.tsx'), 'export default function Page() { return null; }');
  // Source middleware uses TS-only syntax Node cannot import natively.
  writeFileSync(
    join(appDir, `middleware.${opts.sourceExt ?? 'ts'}`),
    opts.sourceBody ?? 'export default async function middleware(req: Request): Promise<{ next: boolean }> { return { next: true }; }',
  );
  if (opts.built) {
    mkdirSync(join(root, '.pledge', 'server'), { recursive: true });
    writeFileSync(join(root, '.pledge', 'server', 'middleware.js'), AUTH_MW);
  }
  const config = {
    rootDir: root,
    appDir: 'app',
    publicDir: 'public',
    outDir: '.pledge',
    defaultRuntime: 'node',
    rsc: false,
    tailwind: false,
    output: 'standalone',
    csrf: false,
    rateLimit: false,
  } as unknown as PledgeConfig;
  return { root, config };
}

function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return {
    url: new URL(`http://localhost:3000${path}`),
    method: init.method ?? 'GET',
    headers: { host: 'localhost:3000', ...(init.headers ?? {}) },
    body: init.body ?? null,
  };
}

describe('production middleware loading', () => {
  it('loads the BUILT middleware, not the TS source', async () => {
    const { config } = makeApp({ built: true });
    const loader = createModuleLoader(config, false);
    const mw = await loader.loadMiddleware();
    expect(mw).not.toBeNull();
    expect(mw!.matcher).toEqual(['/dashboard/:path*']);
  });

  it('fails loudly (does not fail open) when only un-built TS source exists', async () => {
    const { config } = makeApp({ built: false });
    const loader = createModuleLoader(config, false);
    await expect(loader.loadMiddleware()).rejects.toThrow(/SECURITY.*middleware/s);
  });

  it('a built-less plain middleware.js is imported directly', async () => {
    const { config } = makeApp({ built: false, sourceExt: 'js', sourceBody: AUTH_MW });
    const loader = createModuleLoader(config, false);
    const mw = await loader.loadMiddleware();
    expect(mw!.matcher).toEqual(['/dashboard/:path*']);
  });

  it('request handler enforces built middleware in production', async () => {
    const { config } = makeApp({ built: true });
    const { handler } = createRequestHandler({ config, isDev: false });
    const denied = await handler(req('/dashboard/settings'));
    expect(denied.status).toBe(307);
    expect(denied.headers.Location).toBe('/login');
  });

  it('request handler surfaces an error (not an open app) when middleware cannot load', async () => {
    const { config } = makeApp({ built: false });
    const { handler } = createRequestHandler({ config, isDev: false });
    const res = await handler(req('/dashboard/settings'));
    expect(res.status).toBe(500);
  });
});

describe('server actions run through middleware', () => {
  it('blocks action POSTs from a protected page without credentials, allows with', async () => {
    const { config } = makeApp({ built: true });
    let ran = 0;
    const act = serverAction(async () => { ran++; return 'done'; }, { id: 'mw-test#protected' }) as unknown as { __pledgeActionId: string };
    const { handler } = createRequestHandler({ config, isDev: false });
    const base = {
      'content-type': 'application/json',
      'x-pledge-action-id': act.__pledgeActionId,
      referer: 'http://localhost:3000/dashboard/settings',
    };

    const denied = await handler(req('/__pledge__/action', { method: 'POST', headers: base, body: '{"args":[]}' }));
    expect(denied.status).toBe(307);
    expect(ran).toBe(0);

    const allowed = await handler(req('/__pledge__/action', {
      method: 'POST',
      headers: { ...base, authorization: 'Bearer ok' },
      body: '{"args":[]}',
    }));
    expect(allowed.status).toBe(200);
    expect(ran).toBe(1);
  });

  it('fails closed: an action with no referer still runs the middleware', async () => {
    const { config } = makeApp({ built: true });
    const act = serverAction(async () => 'ok', { id: 'mw-test#noref' }) as unknown as { __pledgeActionId: string };
    const { handler } = createRequestHandler({ config, isDev: false });
    const res = await handler(req('/__pledge__/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pledge-action-id': act.__pledgeActionId },
      body: '{"args":[]}',
    }));
    expect(res.status).toBe(307);
  });

  it('does not run page-scoped middleware for actions issued from unmatched pages', async () => {
    const { config } = makeApp({ built: true });
    const act = serverAction(async () => 'ok', { id: 'mw-test#public' }) as unknown as { __pledgeActionId: string };
    const { handler } = createRequestHandler({ config, isDev: false });
    const res = await handler(req('/__pledge__/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pledge-action-id': act.__pledgeActionId, referer: 'http://localhost:3000/about' },
      body: '{"args":[]}',
    }));
    expect(res.status).toBe(200);
  });
});
