import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFmtOptions } from './fmt';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pledge-fmt-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('resolveFmtOptions', () => {
  it('passes --edition through and rejects invalid ones', () => {
    expect(resolveFmtOptions(root, { edition: '2018' }).edition).toBe('2018');
    expect(() => resolveFmtOptions(root, { edition: '1999' })).toThrow(/Invalid --edition/);
  });

  it('discovers rustfmt.toml / .rustfmt.toml upward and reads its edition', () => {
    writeFileSync(join(root, '.rustfmt.toml'), 'edition = "2024"\n');
    const sub = join(root, 'app', 'users');
    mkdirSync(sub, { recursive: true });
    const r = resolveFmtOptions(sub, {});
    expect(r.configFile).toBe(join(root, '.rustfmt.toml'));
    expect(r.edition).toBe('2024');
  });

  it('lets --edition override the config file edition', () => {
    writeFileSync(join(root, 'rustfmt.toml'), 'edition = "2024"\n');
    expect(resolveFmtOptions(root, { edition: '2018' }).edition).toBe('2018');
  });

  it('honors an explicit --config-file and errors when it is missing', () => {
    const cfg = join(root, 'custom.toml');
    writeFileSync(cfg, 'max_width = 80\n');
    const r = resolveFmtOptions(root, { configFile: cfg });
    expect(r.configFile).toBe(cfg);
    expect(r.edition).toBeUndefined();
    expect(() => resolveFmtOptions(root, { configFile: join(root, 'nope.toml') })).toThrow(/not found/);
  });
});
