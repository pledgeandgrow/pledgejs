import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareVersions } from './upgrade';

describe('pledge upgrade — compareVersions', () => {
  it('orders plain versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('orders prereleases below their release and numerically among themselves', () => {
    expect(compareVersions('1.0.0-rc.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-rc.1')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '0.1.12')).toBe(1);
  });
});

describe('pledge upgrade — no dead codemod path', () => {
  it('does not contain the removed implicit codemod stage', () => {
    const src = readFileSync(new URL('./upgrade.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/getApplicableCodemods|runUpgradeCodemods|runCodemod\(/);
  });
});

describe('pledge upgrade — getLatestVersion', () => {
  it('returns null (not "0.0.0") when the registry is unreachable', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execSync: () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      },
    }));
    const { getLatestVersion } = await import('./upgrade');
    expect(getLatestVersion()).toBeNull();
    vi.doUnmock('node:child_process');
  });

  it('returns the trimmed version from npm', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ execSync: () => '1.2.3\n' }));
    const { getLatestVersion } = await import('./upgrade');
    expect(getLatestVersion()).toBe('1.2.3');
    vi.doUnmock('node:child_process');
  });
});
