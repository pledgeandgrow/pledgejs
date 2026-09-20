import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  analyzeBundle,
  formatBundleReport,
  formatBytes,
  parseCargoDependencies,
  loadBundleReport,
  saveBundleReport,
  type BundleAnalysisResult,
} from './bundle-analysis';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('PSX Bundle Analysis', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pledge-bundle-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('formatBytes', () => {
    it('formats bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
      expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
    });
  });

  describe('parseCargoDependencies', () => {
    it('parses simple version deps', () => {
      const cargoToml = join(tempDir, 'Cargo.toml');
      writeFileSync(cargoToml, `
[package]
name = "test"
version = "0.1.0"

[dependencies]
serde = "1"
tokio = { version = "1", features = ["full"] }
napi = { version = "2", features = ["napi8", "async"] }
`);
      const crates = parseCargoDependencies(cargoToml);
      expect(crates.length).toBeGreaterThanOrEqual(3);

      const serde = crates.find((c) => c.name === 'serde');
      expect(serde).toBeDefined();
      expect(serde!.version).toBe('1');

      const tokio = crates.find((c) => c.name === 'tokio');
      expect(tokio).toBeDefined();
      expect(tokio!.features).toContain('full');
      expect(tokio!.suggestion).toBeDefined();
    });

    it('returns empty array for missing file', () => {
      const crates = parseCargoDependencies(join(tempDir, 'nonexistent.toml'));
      expect(crates).toEqual([]);
    });
  });

  describe('analyzeBundle', () => {
    it('analyzes .node files in a directory', () => {
      const nativeDir = join(tempDir, 'native');
      mkdirSync(nativeDir, { recursive: true });

      // Create fake .node files
      writeFileSync(join(nativeDir, 'rust-html.node'), Buffer.alloc(1024));
      writeFileSync(join(nativeDir, 'rust-ssr.node'), Buffer.alloc(2048));

      // Create a Cargo.toml
      writeFileSync(join(nativeDir, 'Cargo.toml'), `
[package]
name = "test-native"
version = "0.1.0"

[dependencies]
serde = "1"

[profile.release]
lto = true
strip = true
`);

      const result = analyzeBundle(tempDir, nativeDir);

      expect(result.addons.length).toBe(2);
      expect(result.totalSizeBytes).toBe(3072);
      expect(result.addons[0].name).toBe('rust-ssr.node');
      expect(result.addons[0].sizeBytes).toBe(2048);
      expect(result.addons[1].sizeBytes).toBe(1024);
    });

    it('handles empty directory', () => {
      const nativeDir = join(tempDir, 'native');
      mkdirSync(nativeDir, { recursive: true });

      const result = analyzeBundle(tempDir, nativeDir);

      expect(result.addons).toEqual([]);
      expect(result.totalSizeBytes).toBe(0);
    });

    it('handles missing directory', () => {
      const result = analyzeBundle(tempDir, join(tempDir, 'nonexistent'));

      expect(result.addons).toEqual([]);
      expect(result.totalSizeBytes).toBe(0);
    });

    it('generates warnings for large addons', () => {
      const nativeDir = join(tempDir, 'native');
      mkdirSync(nativeDir, { recursive: true });

      // Create a large fake .node file (>2MB)
      writeFileSync(join(nativeDir, 'big-addon.node'), Buffer.alloc(3 * 1024 * 1024));

      const result = analyzeBundle(tempDir, nativeDir);
      const largeWarnings = result.warnings.filter((w) => w.message.includes('exceeds'));
      expect(largeWarnings.length).toBeGreaterThan(0);
    });

    it('includes timestamp and project root', () => {
      const result = analyzeBundle(tempDir);
      expect(result.timestamp).toBeDefined();
      expect(result.projectRoot).toBe(tempDir);
    });

    it('calculates size delta when previous report provided', () => {
      const nativeDir = join(tempDir, 'native');
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, 'test.node'), Buffer.alloc(2048));

      const previous: BundleAnalysisResult = {
        totalSizeBytes: 1024,
        addons: [{
          name: 'test.node',
          path: join(nativeDir, 'test.node'),
          sizeBytes: 1024,
          stripped: true,
          ltoEnabled: false,
        }],
        crates: [],
        warnings: [],
        timestamp: '2024-01-01T00:00:00.000Z',
        projectRoot: tempDir,
      };

      const result = analyzeBundle(tempDir, nativeDir, previous);

      expect(result.sizeDelta).toBeDefined();
      expect(result.sizeDelta!.length).toBe(1);
      expect(result.sizeDelta![0].previousSize).toBe(1024);
      expect(result.sizeDelta![0].currentSize).toBe(2048);
      expect(result.sizeDelta![0].deltaBytes).toBe(1024);
    });
  });

  describe('formatBundleReport', () => {
    it('formats a report as a string', () => {
      const result: BundleAnalysisResult = {
        totalSizeBytes: 3072,
        addons: [
          { name: 'a.node', path: '/tmp/a.node', sizeBytes: 2048, stripped: true, ltoEnabled: true },
          { name: 'b.node', path: '/tmp/b.node', sizeBytes: 1024, stripped: false, ltoEnabled: false },
        ],
        crates: [
          { name: 'serde', version: '1', estimatedSizeBytes: 100000, features: [] },
        ],
        warnings: [],
        timestamp: '2024-01-01T00:00:00.000Z',
        projectRoot: '/tmp',
      };

      const report = formatBundleReport(result);
      expect(report).toContain('PSX Bundle Analysis');
      expect(report).toContain('a.node');
      expect(report).toContain('b.node');
      expect(report).toContain('serde');
    });

    it('includes warnings in the report', () => {
      const result: BundleAnalysisResult = {
        totalSizeBytes: 0,
        addons: [],
        crates: [],
        warnings: [
          { addon: 'test.node', message: 'LTO not enabled', severity: 'info', suggestion: 'Add lto = true' },
        ],
        timestamp: '2024-01-01T00:00:00.000Z',
        projectRoot: '/tmp',
      };

      const report = formatBundleReport(result);
      expect(report).toContain('Warnings');
      expect(report).toContain('LTO not enabled');
    });
  });

  describe('saveBundleReport / loadBundleReport', () => {
    it('saves and loads a report', async () => {
      const reportPath = join(tempDir, 'report.json');
      const result: BundleAnalysisResult = {
        totalSizeBytes: 1024,
        addons: [{ name: 'test.node', path: '/tmp/test.node', sizeBytes: 1024, stripped: true, ltoEnabled: true }],
        crates: [],
        warnings: [],
        timestamp: '2024-01-01T00:00:00.000Z',
        projectRoot: '/tmp',
      };

      await saveBundleReport(result, reportPath);
      expect(existsSync(reportPath)).toBe(true);

      const loaded = loadBundleReport(reportPath);
      expect(loaded).not.toBeNull();
      expect(loaded!.totalSizeBytes).toBe(1024);
      expect(loaded!.addons[0].name).toBe('test.node');
    });

    it('returns null for missing file', () => {
      const loaded = loadBundleReport(join(tempDir, 'nonexistent.json'));
      expect(loaded).toBeNull();
    });
  });
});

import { isStrippedFileOutput } from './bundle-analysis';
describe('isStrippedFileOutput', () => {
  it('reports "not stripped" binaries as NOT stripped', () => {
    expect(isStrippedFileOutput('x.node: ELF 64-bit LSB shared object, x86-64, not stripped')).toBe(false);
    expect(isStrippedFileOutput('x.node: ELF 64-bit LSB shared object, x86-64, with debug_info, not stripped')).toBe(false);
  });
  it('reports "stripped" binaries as stripped', () => {
    expect(isStrippedFileOutput('x.node: ELF 64-bit LSB shared object, x86-64, stripped')).toBe(true);
  });
});
