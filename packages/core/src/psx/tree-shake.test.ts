import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeCargoFeatures, detectUnusedCrates } from './tree-shake';
import { treeShakeAnalysis, formatTreeShakeResult } from './tree-shake';

describe('PSX Tree Shaking', () => {
  describe('analyzeCargoFeatures', () => {
    it('returns empty for nonexistent file', () => {
      const result = analyzeCargoFeatures('/nonexistent/Cargo.toml');
      expect(result).toEqual([]);
    });
  });

  describe('treeShakeAnalysis', () => {
    it('returns result with warnings array', () => {
      const result = treeShakeAnalysis('/nonexistent');
      expect(result.warnings).toBeDefined();
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.totalPotentialSavingsKB).toBeGreaterThanOrEqual(0);
    });
  });

  describe('formatTreeShakeResult', () => {
    it('formats result with no warnings', () => {
      const result = {
        crateUsages: [],
        unusedCrates: [],
        totalPotentialSavingsKB: 0,
        optimizedCargoToml: '',
        warnings: [],
      };
      const formatted = formatTreeShakeResult(result);
      expect(formatted).toContain('Tree Shaking');
    });

    it('formats result with warnings', () => {
      const result = {
        crateUsages: [{
          crate: 'tokio',
          allFeatures: ['full'],
          usedFeatures: ['rt', 'macros', 'net', 'io-util', 'time'],
          unusedFeatures: ['full'],
          defaultFeatures: true,
          recommendedFeatures: ['rt', 'macros', 'net', 'io-util', 'time'],
          potentialSizeSavingsKB: 50,
        }],
        unusedCrates: ['unused-crate'],
        totalPotentialSavingsKB: 50,
        optimizedCargoToml: '',
        warnings: ['tokio: 1 unused feature(s): full'],
      };
      const formatted = formatTreeShakeResult(result);
      expect(formatted).toContain('tokio');
      expect(formatted).toContain('unused-crate');
    });
  });
});

describe('detectUnusedCrates', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-shake-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const CARGO = `[package]
name = "demo"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = "2"
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
chrono.workspace = true
left-pad = "1"

[profile.release]
lto = true
opt-level = 3
`;

  it('only reports real dependencies, not [package]/[lib]/[profile] keys', () => {
    writeFileSync(join(dir, 'Cargo.toml'), CARGO);
    writeFileSync(join(dir, 'src', 'lib.rs'), 'fn main() { let _ = serde_json::json!({}); let _ = uuid::Uuid::new_v4(); }');
    expect(detectUnusedCrates(join(dir, 'Cargo.toml'), join(dir, 'src')).sort()).toEqual(['chrono', 'left-pad']);
  });

  it('recognises crates used by path or macro without a `use` statement', () => {
    writeFileSync(join(dir, 'Cargo.toml'), CARGO);
    writeFileSync(join(dir, 'src', 'lib.rs'), 'fn a() -> serde_json::Value { serde_json::json!(1) }');
    writeFileSync(join(dir, 'src', 'nested.rs'), 'fn b() { chrono::Utc::now(); left_pad::pad(); uuid::Uuid::nil(); }');
    expect(detectUnusedCrates(join(dir, 'Cargo.toml'), join(dir, 'src'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not run a shell, so odd directory names cannot inject commands', () => {
    const evil = join(dir, 'src"; touch pwned; echo "');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'lib.rs'), 'fn main() { serde_json::json!(1); }');
    writeFileSync(join(dir, 'Cargo.toml'), CARGO);
    detectUnusedCrates(join(dir, 'Cargo.toml'), evil);
    expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false);
    expect(existsSync(join(evil, 'pwned'))).toBe(false);
  });
});
