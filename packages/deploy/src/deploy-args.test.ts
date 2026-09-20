import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';
import { cloudflareAdapter, vercelAdapter, netlifyAdapter } from './index';

describe('deploy adapters reject shell metacharacters in project/branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'pledge-deploy-'));
  const config = { rootDir: root, outDir: '.pledge' } as unknown as PledgeConfig;

  for (const [name, adapter] of [['cloudflare', cloudflareAdapter], ['vercel', vercelAdapter], ['netlify', netlifyAdapter]] as const) {
    it(`${name}: refuses a hostile project name`, async () => {
      const r = await adapter.deploy(config, { dryRun: true, project: 'x"; touch pwned; "' });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/invalid/i);
    });
    it(`${name}: refuses a hostile branch name`, async () => {
      const r = await adapter.deploy(config, { dryRun: true, project: 'ok-app', branch: 'main$(id)' });
      expect(r.success).toBe(false);
    });
    it(`${name}: accepts normal names`, async () => {
      const r = await adapter.deploy(config, { dryRun: true, project: 'my-app.v2', branch: 'feature/x-1' });
      expect(r.success).toBe(true);
    });
  }
  afterAll(() => rmSync(root, { recursive: true, force: true }));
});
