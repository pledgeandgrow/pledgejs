import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock child_process.execSync so deploy() doesn't actually run pledge build
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import {
  cloudflareAdapter,
  vercelAdapter,
  netlifyAdapter,
  detectTarget,
  deploy,
  type DeployTarget,
} from './index';
import type { PledgeConfig } from 'pledgestack-shared';

const tmpDir = join(process.cwd(), '.test-deploy-tmp');

function makeConfig(overrides: Partial<PledgeConfig> = {}): PledgeConfig {
  return {
    rootDir: tmpDir,
    appDir: 'app',
    publicDir: 'public',
    outDir: '.pledge',
    defaultRuntime: 'node',
    rsc: true,
    tailwind: true,
    output: 'standalone',
    ...overrides,
  };
}

describe('Deploy Adapters', () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('cloudflareAdapter', () => {
    it('detects wrangler.toml', () => {
      writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "test"');
      expect(cloudflareAdapter.detect(makeConfig())).toBe(true);
    });

    it('detects config.edge.target = cloudflare', () => {
      expect(cloudflareAdapter.detect(makeConfig({ pledgepack: { edge: { target: 'cloudflare' } } }))).toBe(true);
    });

    it('returns false when no cloudflare config', () => {
      expect(cloudflareAdapter.detect(makeConfig())).toBe(false);
    });

    it('generates wrangler.toml with correct structure', () => {
      const config = makeConfig();
      const toml = cloudflareAdapter.generateConfig(config);
      expect(toml).toContain('compatibility_date');
      expect(toml).toContain('.pledge/public');
      expect(toml).toContain('pledge build');
    });

    it('dry run returns success without deploying', async () => {
      const result = await cloudflareAdapter.deploy(makeConfig(), { dryRun: true });
      expect(result.success).toBe(true);
      expect(result.target).toBe('cloudflare');
      expect(result.message).toContain('Dry run');
    });

    it('generates wrangler.toml if missing during deploy', async () => {
      const config = makeConfig();
      const result = await cloudflareAdapter.deploy(config, { dryRun: true });
      expect(result.success).toBe(true);
    });
  });

  describe('vercelAdapter', () => {
    it('detects vercel.json', () => {
      writeFileSync(join(tmpDir, 'vercel.json'), '{}');
      expect(vercelAdapter.detect(makeConfig())).toBe(true);
    });

    it('generates vercel.json', () => {
      const json = vercelAdapter.generateConfig(makeConfig());
      const parsed = JSON.parse(json);
      expect(parsed.buildCommand).toBe('pledge build');
      expect(parsed.outputDirectory).toContain('.pledge');
    });

    it('dry run returns success', async () => {
      const result = await vercelAdapter.deploy(makeConfig(), { dryRun: true });
      expect(result.success).toBe(true);
      expect(result.target).toBe('vercel');
    });
  });

  describe('netlifyAdapter', () => {
    it('detects netlify.toml', () => {
      writeFileSync(join(tmpDir, 'netlify.toml'), '[build]');
      expect(netlifyAdapter.detect(makeConfig())).toBe(true);
    });

    it('generates netlify.toml', () => {
      const toml = netlifyAdapter.generateConfig(makeConfig());
      expect(toml).toContain('pledge build');
      expect(toml).toContain('.pledge/public');
    });

    it('dry run returns success', async () => {
      const result = await netlifyAdapter.deploy(makeConfig(), { dryRun: true });
      expect(result.success).toBe(true);
      expect(result.target).toBe('netlify');
    });
  });

  describe('detectTarget', () => {
    it('detects cloudflare from wrangler.toml', () => {
      writeFileSync(join(tmpDir, 'wrangler.toml'), 'name = "test"');
      expect(detectTarget(makeConfig())).toBe('cloudflare');
    });

    it('detects vercel from vercel.json', () => {
      writeFileSync(join(tmpDir, 'vercel.json'), '{}');
      expect(detectTarget(makeConfig())).toBe('vercel');
    });

    it('detects netlify from netlify.toml', () => {
      writeFileSync(join(tmpDir, 'netlify.toml'), '[build]');
      expect(detectTarget(makeConfig())).toBe('netlify');
    });

    it('uses config.edge.target when set', () => {
      expect(detectTarget(makeConfig({ pledgepack: { edge: { target: 'vercel' } } }))).toBe('vercel');
    });

    it('defaults to cloudflare when nothing detected', () => {
      expect(detectTarget(makeConfig())).toBe('cloudflare');
    });
  });

  describe('deploy (integration)', () => {
    it('returns error for unknown target', async () => {
      const result = await deploy(makeConfig(), { target: 'unknown' as DeployTarget });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown deploy target');
    });

    it('dry run builds and reports target', async () => {
      const result = await deploy(makeConfig(), { target: 'cloudflare', dryRun: true });
      expect(result.success).toBe(true);
      expect(result.target).toBe('cloudflare');
    });

    it('passes project name to cloudflare adapter in dry run', async () => {
      const result = await deploy(makeConfig(), {
        target: 'cloudflare',
        dryRun: true,
        project: 'my-custom-app',
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain('my-custom-app');
    });

    it('passes project name to vercel adapter in dry run', async () => {
      const result = await deploy(makeConfig(), {
        target: 'vercel',
        dryRun: true,
        project: 'vercel-app',
      });
      expect(result.success).toBe(true);
      expect(result.target).toBe('vercel');
    });

    it('passes project name to netlify adapter in dry run', async () => {
      const result = await deploy(makeConfig(), {
        target: 'netlify',
        dryRun: true,
        project: 'netlify-site',
      });
      expect(result.success).toBe(true);
      expect(result.target).toBe('netlify');
    });
  });
});
