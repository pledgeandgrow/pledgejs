import { describe, it, expect } from 'vitest';
import { tryServeRouterModule } from './virtual-modules';
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
