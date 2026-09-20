import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { getCleanPaths, isSafeToRemove } from './clean';
import type { PledgeConfig } from 'pledgestack-shared';

const root = resolve('/tmp/some-project');
const cfg = (outDir: string, extra: Partial<PledgeConfig> = {}) => ({ rootDir: root, outDir, ...extra }) as PledgeConfig;

describe('pledge clean safety', () => {
  it('never targets the project root or its ancestors', () => {
    expect(isSafeToRemove(root, root)).toBe(false);
    expect(isSafeToRemove(resolve(root, '..'), root)).toBe(false);
    expect(isSafeToRemove(join(root, '.pledge'), root)).toBe(true);
  });

  it('drops an outDir that resolves to the project root', () => {
    for (const outDir of ['.', '', './', '..']) {
      const paths = getCleanPaths(cfg(outDir)).map((p) => resolve(p));
      expect(paths).not.toContain(root);
      expect(paths).not.toContain(resolve(root, '..'));
    }
  });

  it('still cleans the normal build output', () => {
    expect(getCleanPaths(cfg('.pledge')).map((p) => resolve(p))).toContain(join(root, '.pledge'));
  });
});
