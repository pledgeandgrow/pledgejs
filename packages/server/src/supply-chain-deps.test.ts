import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSBOM, checkLicenseCompliance, scanForSecrets } from './supply-chain';

const PNPM_LOCK_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.2.3(react@19.0.0)
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-aaa}

  left-pad@1.3.0:
    resolution: {integrity: sha512-bbb}

  gpl-thing@2.0.0:
    resolution: {integrity: sha512-ccc}

snapshots:

  '@scope/pkg@1.2.3(react@19.0.0)':
    dependencies:
      left-pad: 1.3.0

  left-pad@1.3.0: {}

  gpl-thing@2.0.0: {}
`;

describe('SBOM dependency extraction', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-sbom-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const libs = () =>
    generateSBOM(dir)
      .components.filter((c) => c.type === 'library')
      .map((c) => `${c.name}@${c.version}`)
      .sort();

  it('parses a pnpm v9 lockfile into clean, de-duplicated name@version pairs', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), PNPM_LOCK_V9);
    expect(libs()).toEqual(['@scope/pkg@1.2.3', 'gpl-thing@2.0.0', 'left-pad@1.3.0']);
  });

  it('parses the older /name@version pnpm key style', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '6.0'\n\npackages:\n\n  /@a/b@1.0.0:\n    resolution: {}\n\n  /c@2.0.0(x@1.0.0):\n    resolution: {}\n");
    expect(libs()).toEqual(['@a/b@1.0.0', 'c@2.0.0']);
  });

  it('reads package-lock.json (npm) with licences', () => {
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/left-pad': { version: '1.3.0', license: 'MIT' },
          'node_modules/a/node_modules/@s/b': { version: '2.0.0', license: 'GPL-3.0-only' },
        },
      }),
    );
    expect(libs()).toEqual(['@s/b@2.0.0', 'left-pad@1.3.0']);
    const result = checkLicenseCompliance(dir);
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.packageName)).toEqual(['@s/b']);
  });

  it('actually finds copyleft licences from installed package metadata (was always "unknown")', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), PNPM_LOCK_V9);
    const gplDir = join(dir, 'node_modules', '.pnpm', 'gpl-thing@2.0.0', 'node_modules', 'gpl-thing');
    mkdirSync(gplDir, { recursive: true });
    writeFileSync(join(gplDir, 'package.json'), JSON.stringify({ name: 'gpl-thing', version: '2.0.0', license: 'GPL-3.0-or-later' }));
    const mitDir = join(dir, 'node_modules', 'left-pad');
    mkdirSync(mitDir, { recursive: true });
    writeFileSync(join(mitDir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'MIT' }));

    const result = checkLicenseCompliance(dir);
    expect(result.violations.map((v) => `${v.packageName}:${v.category}`)).toEqual(['gpl-thing:copyleft']);
    expect(checkLicenseCompliance(dir, { allowList: ['gpl-thing'] }).passed).toBe(true);
  });

  it('treats an SPDX "OR" expression as satisfiable by its most permissive option', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "packages:\n\n  dual@1.0.0:\n    resolution: {}\n\n  both@1.0.0:\n    resolution: {}\n");
    for (const [name, license] of [['dual', '(MIT OR GPL-3.0)'], ['both', 'MIT AND GPL-3.0']] as const) {
      const d = join(dir, 'node_modules', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }));
    }
    expect(checkLicenseCompliance(dir).violations.map((v) => v.packageName)).toEqual(['both']);
  });
});

describe('secret scanning robustness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not throw for a directory that does not exist', () => {
    const result = scanForSecrets(join(dir, 'missing'));
    expect(result.passed).toBe(true);
    expect(result.scannedFiles).toBe(0);
  });

  it('does not copy the secret itself into the finding snippet', () => {
    const secret = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    writeFileSync(join(dir, 'config.ts'), `export const key = "${secret}";\n`);
    const result = scanForSecrets(dir);
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) expect(f.snippet).not.toContain(secret.slice(0, 20));
  });
});
