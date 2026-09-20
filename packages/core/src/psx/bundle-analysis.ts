/**
 * #281 — PSX Bundle Analysis.
 *
 * Per-module Rust binary size breakdown, identify large crates,
 * suggest alternatives, and track `.node` addon size across builds.
 *
 * Analyzes compiled `.node` addon files and their Cargo dependencies
 * to provide actionable insights on binary size optimization.
 */

import { statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddonSizeInfo {
  /** Addon file name (e.g., `rust-html.node`) */
  name: string;
  /** Absolute path to the .node file */
  path: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Whether the addon is stripped (no debug symbols) */
  stripped: boolean;
  /** Whether LTO is enabled in the Cargo.toml */
  ltoEnabled: boolean;
}

export interface CrateSizeInfo {
  /** Crate name */
  name: string;
  /** Version */
  version: string;
  /** Estimated contribution to binary size (bytes) */
  estimatedSizeBytes: number;
  /** Features enabled */
  features: string[];
  /** Whether a lighter alternative exists */
  alternative?: string;
  /** Suggestion for reducing size */
  suggestion?: string;
}

export interface BundleAnalysisResult {
  /** Total size of all .node addons */
  totalSizeBytes: number;
  /** Per-addon breakdown */
  addons: AddonSizeInfo[];
  /** Per-crate estimated sizes */
  crates: CrateSizeInfo[];
  /** Warnings for oversized addons */
  warnings: BundleWarning[];
  /** Size comparison with previous build (if available) */
  sizeDelta?: SizeDelta[];
  /** Timestamp of analysis */
  timestamp: string;
  /** Project root path */
  projectRoot: string;
}

export interface BundleWarning {
  addon: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}

export interface SizeDelta {
  addon: string;
  previousSize: number;
  currentSize: number;
  deltaBytes: number;
  deltaPercent: number;
}

// ---------------------------------------------------------------------------
// Known large crates and their lighter alternatives
// ---------------------------------------------------------------------------

const CRATE_ALTERNATIVES: Record<string, { alternative: string; suggestion: string }> = {
  'tokio': {
    alternative: 'tokio (with minimal features)',
    suggestion: 'Use `tokio = { version = "1", features = ["rt", "macros"] }` instead of `features = ["full"]` to reduce binary size by ~500KB',
  },
  'reqwest': {
    alternative: 'ureq',
    suggestion: 'Consider `ureq` (~100KB) instead of `reqwest` (~800KB) for simple HTTP clients. Reqwest pulls in tokio, hyper, and h2.',
  },
  'sqlx': {
    alternative: 'rusqlite',
    suggestion: 'For SQLite-only projects, `rusqlite` (~200KB) is much smaller than `sqlx` (~1.5MB). Only use sqlx if you need compile-time verification.',
  },
  'serde_json': {
    alternative: 'serde_json (no preserve_order)',
    suggestion: "Disable `preserve_order` feature if you don't need key ordering. Saves ~50KB.",
  },
  'image': {
    alternative: 'image (with minimal formats)',
    suggestion: 'Enable only the formats you need: `image = { version = "0.24", default-features = false, features = ["jpeg", "png"] }`',
  },
  'openssl': {
    alternative: 'rustls',
    suggestion: 'Use `rustls` instead of `openssl` to avoid linking against system OpenSSL. Smaller binary, no native deps.',
  },
  'lettre': {
    alternative: 'smtp library with minimal features',
    suggestion: "Disable `lettre` features you don't use (e.g., `tokio1-rustls-tls` vs `tokio1-native-tls`). Saves ~300KB.",
  },
  'puppeteer': {
    alternative: 'chromiumoxide',
    suggestion: "If using headless Chrome, `chromiumoxide` is lighter. Better yet, generate PDFs server-side with `printpdf` (~200KB).",
  },
};

// ---------------------------------------------------------------------------
// Size thresholds
// ---------------------------------------------------------------------------

const SIZE_THRESHOLDS = {
  /** Addon is considered large above this size */
  largeAddon: 2 * 1024 * 1024, // 2MB
  /** Addon is considered very large above this size */
  veryLargeAddon: 5 * 1024 * 1024, // 5MB
  /** Per-crate estimated size warning */
  largeCrate: 500 * 1024, // 500KB
};

// ---------------------------------------------------------------------------
// Core analysis functions
// ---------------------------------------------------------------------------

/**
 * Analyzes a single .node addon file for size and properties.
 */
export function analyzeAddon(filePath: string): AddonSizeInfo {
  const stat = statSync(filePath);
  const name = basename(filePath);
  const stripped = checkStripped(filePath);
  const ltoEnabled = checkLtoEnabled(filePath);

  return {
    name,
    path: filePath,
    sizeBytes: stat.size,
    stripped,
    ltoEnabled,
  };
}

/**
 * Checks if a binary is stripped (no debug symbols).
 * On Unix, uses `file` command. On Windows, checks for .pdb files.
 */
/**
 * Interpret `file(1)` output. Note "not stripped" also contains the substring
 * "stripped", so the previous `includes('stripped') || ...` check reported
 * every binary as stripped.
 */
export function isStrippedFileOutput(output: string): boolean {
  return !output.includes('not stripped');
}

function checkStripped(filePath: string): boolean {
  try {
    if (process.platform === 'win32') {
      // On Windows, check if a .pdb file exists alongside
      const pdbPath = filePath.replace(/\.node$/, '.pdb');
      return !existsSync(pdbPath);
    }

    // On Unix, use `file` command
    // execFileSync (no shell): filePath comes from directory contents and may
    // contain shell metacharacters.
    const output = execFileSync('file', [filePath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return isStrippedFileOutput(output);
  } catch {
    // If we can't check, assume stripped (optimistic)
    return true;
  }
}

/**
 * Checks if LTO is enabled by looking at the Cargo.toml in the addon's directory.
 */
function checkLtoEnabled(filePath: string): boolean {
  try {
    const dir = dirname(filePath);
    const cargoTomlPath = findCargoToml(dir);
    if (!cargoTomlPath) return false;

    const content = readFileSync(cargoTomlPath, 'utf-8');
    return content.includes('lto = true') || content.includes('lto = "thin"');
  } catch {
    return false;
  }
}

/**
 * Walks up the directory tree to find a Cargo.toml.
 */
function findCargoToml(dir: string): string | null {
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = join(current, 'Cargo.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Parses Cargo.toml to extract crate dependencies with versions and features.
 */
export function parseCargoDependencies(cargoTomlPath: string): CrateSizeInfo[] {
  try {
    const content = readFileSync(cargoTomlPath, 'utf-8');
    const crates: CrateSizeInfo[] = [];

    // Simple regex-based parsing (the PSX parser already uses this approach)
    const depRegex = /^(\w[\w-]*)\s*=\s*(?:\{\s*version\s*=\s*"([^"]+)"(?:.*?features\s*=\s*\[([^\]]+)\])?|"?([^"]+)"?)/gm;
    let match: RegExpExecArray | null;

    while ((match = depRegex.exec(content)) !== null) {
      const name = match[1];
      const version = match[2] ?? match[4] ?? 'unknown';
      const featuresStr = match[3] ?? '';
      const features = featuresStr
        .split(',')
        .map((f) => f.trim().replace(/"/g, ''))
        .filter(Boolean);

      const alt = CRATE_ALTERNATIVES[name];
      crates.push({
        name,
        version,
        estimatedSizeBytes: estimateCrateSize(name, features),
        features,
        alternative: alt?.alternative,
        suggestion: alt?.suggestion,
      });
    }

    return crates;
  } catch {
    return [];
  }
}

/**
 * Estimates a crate's contribution to binary size based on known sizes.
 */
function estimateCrateSize(name: string, features: string[]): number {
  const baseSizes: Record<string, number> = {
    'tokio': features.includes('full') ? 800_000 : 150_000,
    'reqwest': 800_000,
    'sqlx': 1_500_000,
    'serde': 100_000,
    'serde_json': 200_000,
    'napi': 300_000,
    'napi-derive': 0,
    'image': features.length > 0 ? 1_200_000 : 600_000,
    'argon2': 300_000,
    'lettre': 500_000,
    'redis': 200_000,
    'sha2': 100_000,
    'aes-gcm': 80_000,
    'rand': 60_000,
    'uuid': 40_000,
    'chrono': 200_000,
    'tracing': 150_000,
    'tracing-subscriber': 200_000,
  };

  return baseSizes[name] ?? 100_000; // Default estimate for unknown crates
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

/**
 * Analyzes all .node addons in a project.
 *
 * @param projectRoot Root directory of the PledgeStack project
 * @param nativeDir Directory containing .node files (default: packages/core/native)
 * @param previousReport Previous analysis report for size comparison (optional)
 */
export function analyzeBundle(
  projectRoot: string,
  nativeDir?: string,
  previousReport?: BundleAnalysisResult,
): BundleAnalysisResult {
  const addonDir = nativeDir ?? join(projectRoot, 'packages', 'core', 'native');
  const addons: AddonSizeInfo[] = [];
  const warnings: BundleWarning[] = [];

  // Find all .node files
  if (existsSync(addonDir)) {
    const entries = readdirSync(addonDir, { recursive: true }) as string[];
    for (const entry of entries) {
      if (entry.endsWith('.node')) {
        const fullPath = join(addonDir, entry);
        const info = analyzeAddon(fullPath);
        addons.push(info);

        // Check for size warnings
        if (info.sizeBytes > SIZE_THRESHOLDS.veryLargeAddon) {
          warnings.push({
            addon: info.name,
            message: `Addon is ${formatBytes(info.sizeBytes)} — exceeds 5MB limit`,
            severity: 'error',
            suggestion: 'Enable LTO, strip debug symbols, and reduce Cargo features. See `pledge analyze --suggestions`',
          });
        } else if (info.sizeBytes > SIZE_THRESHOLDS.largeAddon) {
          warnings.push({
            addon: info.name,
            message: `Addon is ${formatBytes(info.sizeBytes)} — exceeds 2MB recommendation`,
            severity: 'warning',
            suggestion: 'Consider enabling LTO and stripping debug symbols to reduce size',
          });
        }

        if (!info.stripped) {
          warnings.push({
            addon: info.name,
            message: 'Debug symbols not stripped — binary contains debug info',
            severity: 'warning',
            suggestion: 'Add `strip = true` to [profile.release] in Cargo.toml',
          });
        }

        if (!info.ltoEnabled) {
          warnings.push({
            addon: info.name,
            message: 'LTO not enabled — binary is larger than necessary',
            severity: 'info',
            suggestion: 'Add `lto = true` to [profile.release] in Cargo.toml for ~20-30% size reduction',
          });
        }
      }
    }
  }

  // Parse Cargo.toml for crate analysis
  const cargoTomlPath = findCargoToml(addonDir);
  const crates = cargoTomlPath ? parseCargoDependencies(cargoTomlPath) : [];

  // Warn about large crates with alternatives
  for (const crate of crates) {
    if (crate.estimatedSizeBytes > SIZE_THRESHOLDS.largeCrate && crate.alternative) {
      warnings.push({
        addon: crate.name,
        message: `Crate "${crate.name}" (~${formatBytes(crate.estimatedSizeBytes)}) has a lighter alternative`,
        severity: 'info',
        suggestion: crate.suggestion,
      });
    }
  }

  // Calculate total size
  const totalSizeBytes = addons.reduce((sum, a) => sum + a.sizeBytes, 0);

  // Calculate size delta if previous report exists
  let sizeDelta: SizeDelta[] | undefined;
  if (previousReport) {
    sizeDelta = [];
    for (const addon of addons) {
      const prev = previousReport.addons.find((a) => a.name === addon.name);
      if (prev) {
        const delta = addon.sizeBytes - prev.sizeBytes;
        sizeDelta.push({
          addon: addon.name,
          previousSize: prev.sizeBytes,
          currentSize: addon.sizeBytes,
          deltaBytes: delta,
          deltaPercent: prev.sizeBytes > 0 ? (delta / prev.sizeBytes) * 100 : 0,
        });
      }
    }
  }

  return {
    totalSizeBytes,
    addons: addons.sort((a, b) => b.sizeBytes - a.sizeBytes),
    crates: crates.sort((a, b) => b.estimatedSizeBytes - a.estimatedSizeBytes),
    warnings,
    sizeDelta,
    timestamp: new Date().toISOString(),
    projectRoot,
  };
}

// ---------------------------------------------------------------------------
// Formatting and reporting
// ---------------------------------------------------------------------------

/**
 * Formats a bundle analysis result as a human-readable report.
 */
export function formatBundleReport(result: BundleAnalysisResult): string {
  const lines: string[] = [
    '\n=== PSX Bundle Analysis ===\n',
    `Total addon size: ${formatBytes(result.totalSizeBytes)}\n`,
    '\nAddons (sorted by size):',
  ];

  for (const addon of result.addons) {
    const stripped = addon.stripped ? 'stripped' : 'not-stripped';
    const lto = addon.ltoEnabled ? 'LTO' : 'no-LTO';
    lines.push(`  ${addon.name.padEnd(30)} ${formatBytes(addon.sizeBytes).padStart(12)}  ${stripped}  ${lto}`);
  }

  if (result.crates.length > 0) {
    lines.push('\nCrates (estimated contribution):');
    for (const crate of result.crates) {
      const features = crate.features.length > 0 ? ` [${crate.features.join(', ')}]` : '';
      lines.push(`  ${crate.name.padEnd(25)} v${crate.version.padEnd(10)} ~${formatBytes(crate.estimatedSizeBytes).padStart(10)}${features}`);
      if (crate.suggestion) {
        lines.push(`    ${dim('→ ' + crate.suggestion)}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\nWarnings:');
    for (const w of result.warnings) {
      const icon = w.severity === 'error' ? red('✗') : w.severity === 'warning' ? yellow('⚠') : blue('ℹ');
      lines.push(`  ${icon} ${w.addon}: ${w.message}`);
      if (w.suggestion) {
        lines.push(`    ${dim('Fix: ' + w.suggestion)}`);
      }
    }
  }

  if (result.sizeDelta && result.sizeDelta.length > 0) {
    lines.push('\nSize changes since last build:');
    for (const delta of result.sizeDelta) {
      const sign = delta.deltaBytes > 0 ? '+' : '';
      const color = delta.deltaBytes > 0 ? red : green;
      lines.push(`  ${delta.addon.padEnd(30)} ${formatBytes(delta.previousSize).padStart(10)} → ${formatBytes(delta.currentSize).padStart(10)}  ${color(`${sign}${formatBytes(delta.deltaBytes)} (${sign}${delta.deltaPercent.toFixed(1)}%)`)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Saves a bundle analysis report to a JSON file for tracking across builds.
 */
export async function saveBundleReport(
  result: BundleAnalysisResult,
  outputPath: string,
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

/**
 * Loads a previous bundle analysis report from a JSON file.
 */
export function loadBundleReport(inputPath: string): BundleAnalysisResult | null {
  try {
    if (!existsSync(inputPath)) return null;
    const content = readFileSync(inputPath, 'utf-8');
    return JSON.parse(content) as BundleAnalysisResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function blue(s: string): string {
  return `\x1b[34m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
