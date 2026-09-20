import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkProductionPosture } from './safety-net';
import type { PledgeConfig } from 'pledgestack-shared';

const baseConfig: PledgeConfig = {
  rootDir: '/test', appDir: 'app', publicDir: 'public', outDir: '.pledge',
  framework: 'react', bundler: 'pledgepack', defaultRuntime: 'node',
  output: 'standalone', rsc: false, tailwind: false, securityHeaders: true,
};

describe('checkProductionPosture', () => {
  it('flags disabled security headers as an error', () => {
    const issues = checkProductionPosture({ ...baseConfig, securityHeaders: false });
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('securityHeaders'))).toBe(true);
  });

  it('flags disabled CSRF as an error', () => {
    const issues = checkProductionPosture({ ...baseConfig, csrf: false });
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('CSRF'))).toBe(true);
  });

  it('flags wildcard CORS with credentials as an error', () => {
    const issues = checkProductionPosture({
      ...baseConfig,
      cors: { origins: ['*'], credentials: true },
    });
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('credentials'))).toBe(true);
  });

  it('flags wildcard CORS without credentials as a warning', () => {
    const issues = checkProductionPosture({
      ...baseConfig,
      cors: { origins: ['*'], credentials: false },
    });
    expect(issues.some((i) => i.severity === 'warn' && i.message.includes('CORS'))).toBe(true);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('CORS'))).toBe(false);
  });

  it('flags disabled rate limiting', () => {
    const issues = checkProductionPosture({ ...baseConfig, rateLimit: false });
    expect(issues.some((i) => i.message.includes('rateLimit'))).toBe(true);
  });

  it('produces no config issues for a hardened config', () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-posture-'));
    mkdirSync(join(root, 'public', '.well-known'), { recursive: true });
    writeFileSync(join(root, 'public', '.well-known', 'security.txt'), 'Contact: mailto:sec@example.com\n');
    const prev = process.env.PLEDGE_SECRET;
    process.env.PLEDGE_SECRET = 'test-secret';
    try {
      const issues = checkProductionPosture({ ...baseConfig, rootDir: root });
      // Only possible finding is the NODE_ENV check, which depends on the test
      // runner environment — assert no config-derived issues regardless.
      expect(issues.filter((i) => !i.message.includes('NODE_ENV'))).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.PLEDGE_SECRET;
      else process.env.PLEDGE_SECRET = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns when no stable signing secret is configured', () => {
    const prevP = process.env.PLEDGE_SECRET;
    const prevS = process.env.SESSION_SECRET;
    delete process.env.PLEDGE_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      const issues = checkProductionPosture(baseConfig);
      expect(issues.some((i) => i.severity === 'warn' && i.message.includes('PLEDGE_SECRET'))).toBe(true);
    } finally {
      if (prevP !== undefined) process.env.PLEDGE_SECRET = prevP;
      if (prevS !== undefined) process.env.SESSION_SECRET = prevS;
    }
  });

  it('warns when security.txt is missing', () => {
    const issues = checkProductionPosture(baseConfig);
    expect(issues.some((i) => i.severity === 'warn' && i.message.includes('security.txt'))).toBe(true);
  });

  it('warns when .map files are publicly reachable', () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-posture-map-'));
    mkdirSync(join(root, 'public', 'assets'), { recursive: true });
    writeFileSync(join(root, 'public', 'assets', 'app.js.map'), '{}');
    try {
      const issues = checkProductionPosture({ ...baseConfig, rootDir: root });
      expect(issues.some((i) => i.severity === 'warn' && i.message.includes('.map'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not warn about .map files outside public/', () => {
    const root = mkdtempSync(join(tmpdir(), 'pledge-posture-nomap-'));
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'private.js.map'), '{}');
    try {
      const issues = checkProductionPosture({ ...baseConfig, rootDir: root });
      expect(issues.some((i) => i.message.includes('.map'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
