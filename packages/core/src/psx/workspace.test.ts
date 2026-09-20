import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCrate, removeCrate, listCrates, generateRootCargoToml } from './workspace';

describe('Cargo.toml crate management', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-cargo-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cargo = () => join(dir, 'Cargo.toml');

  it('adds, lists and removes crates in a CRLF Cargo.toml (Windows checkouts)', async () => {
    writeFileSync(cargo(), generateRootCargoToml({ serde: '"1"' }).replace(/\n/g, '\r\n'));

    await addCrate(dir, 'zzz-crate', '"2"');
    expect(readFileSync(cargo(), 'utf-8')).toContain('zzz-crate = "2"');

    const crates = await listCrates(dir);
    expect(crates['zzz-crate']).toBe('"2"');
    expect(crates.serde).toBe('"1"');

    await removeCrate(dir, 'zzz-crate');
    expect(readFileSync(cargo(), 'utf-8')).not.toContain('zzz-crate');
  });

  it('does not mistake a longer crate name for an existing install', async () => {
    writeFileSync(cargo(), generateRootCargoToml({ mysqlx: '"1"' }));
    await addCrate(dir, 'sqlx', '"0.8"');
    expect(readFileSync(cargo(), 'utf-8')).toMatch(/^sqlx = "0\.8"$/m);
  });

  it('rejects crate names that could inject TOML', async () => {
    writeFileSync(cargo(), generateRootCargoToml({ serde: '"1"' }));
    await expect(addCrate(dir, 'evil"\n[profile.release]\nx', '"1"')).rejects.toThrow(/Invalid crate name/);
  });

  it('fails loudly when there is no [workspace.dependencies] section', async () => {
    writeFileSync(cargo(), '[package]\nname = "x"\n');
    await expect(addCrate(dir, 'serde', '"1"')).rejects.toThrow(/workspace\.dependencies/);
  });
});
