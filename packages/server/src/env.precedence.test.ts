import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadEnv precedence', () => {
  it('lets .env.local override .env, but never real process.env', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'pledge-env-'));
    writeFileSync(join(dir, '.env'), 'PLEDGE_T_A=base\nPLEDGE_T_B=base\n');
    writeFileSync(join(dir, '.env.local'), 'PLEDGE_T_A=local\n');
    process.env.PLEDGE_T_B = 'real';
    try {
      const { loadEnv } = await import('./env');
      loadEnv(dir, 'test');
      expect(process.env.PLEDGE_T_A).toBe('local');
      expect(process.env.PLEDGE_T_B).toBe('real');
    } finally {
      delete process.env.PLEDGE_T_A;
      delete process.env.PLEDGE_T_B;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
