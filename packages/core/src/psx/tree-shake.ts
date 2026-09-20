/**
 * #282 — Rust Addon Tree Shaking.
 *
 * Strip unused crate features at compile time, cargo feature flag
 * optimization, remove unused derive macros, minimize .node size.
 *
 * Provides:
 * - Analyze Cargo.toml for unused features
 * - Detect unused crate dependencies
 * - Suggest minimal feature sets
 * - Generate optimized Cargo.toml
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrateFeatureUsage {
  crate: string;
  allFeatures: string[];
  usedFeatures: string[];
  unusedFeatures: string[];
  defaultFeatures: boolean;
  recommendedFeatures: string[];
  potentialSizeSavingsKB: number;
}

export interface TreeShakeResult {
  crateUsages: CrateFeatureUsage[];
  unusedCrates: string[];
  totalPotentialSavingsKB: number;
  optimizedCargoToml: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Feature analysis
// ---------------------------------------------------------------------------

/**
 * Known minimal feature sets for common crates.
 */
const MINIMAL_FEATURES: Record<string, { default: string[]; minimal: string[]; description: string }> = {
  'tokio': {
    default: ['full'],
    minimal: ['rt', 'macros', 'net', 'io-util', 'time'],
    description: 'Replace "full" with only needed features. Most apps need rt+macros+net',
  },
  'serde': {
    default: ['derive'],
    minimal: ['derive'],
    description: 'derive is typically the only needed feature',
  },
  'sqlx': {
    default: ['runtime-tokio', 'postgres', 'macros', 'chrono'],
    minimal: ['runtime-tokio', 'postgres', 'macros'],
    description: 'Remove unused database features (mysql, sqlite, json)',
  },
  'reqwest': {
    default: ['default-tls', 'json', 'stream'],
    minimal: ['json'],
    description: 'Use rustls-tls instead of default-tls, remove unused features',
  },
  'image': {
    default: ['default'],
    minimal: ['png', 'jpeg'],
    description: 'Only enable formats you use. Each format adds ~100KB',
  },
  'napi': {
    default: ['napi8', 'async'],
    minimal: ['napi8', 'async'],
    description: 'napi8 is the minimum for async support',
  },
};

/**
 * Analyzes a Cargo.toml for unused features and suggests minimal feature sets.
 */
export function analyzeCargoFeatures(cargoTomlPath: string): CrateFeatureUsage[] {
  if (!existsSync(cargoTomlPath)) return [];

  const content = readFileSync(cargoTomlPath, 'utf-8');
  const results: CrateFeatureUsage[] = [];

  // Parse dependencies
  const depRegex = /^(\w[\w-]*)\s*=\s*\{(.+)\}$/gm;
  let match: RegExpExecArray | null;

  while ((match = depRegex.exec(content)) !== null) {
    const crate = match[1];
    const tableContent = match[2];

    const featuresMatch = tableContent.match(/features\s*=\s*\[([^\]]+)\]/);
    const defaultFeaturesMatch = tableContent.match(/default-features\s*=\s*(true|false)/);

    const allFeatures = featuresMatch
      ? featuresMatch[1].split(',').map(f => f.trim().replace(/"/g, '')).filter(Boolean)
      : [];
    const defaultFeatures = defaultFeaturesMatch?.[1] !== 'false';

    const minimal = MINIMAL_FEATURES[crate];
    const usedFeatures = minimal?.minimal ?? allFeatures;
    const unusedFeatures = allFeatures.filter(f => !usedFeatures.includes(f));
    const recommendedFeatures = minimal?.minimal ?? allFeatures;

    // Estimate size savings (rough estimates)
    const potentialSizeSavingsKB = unusedFeatures.length * 50; // ~50KB per unused feature

    results.push({
      crate,
      allFeatures,
      usedFeatures,
      unusedFeatures,
      defaultFeatures,
      recommendedFeatures,
      potentialSizeSavingsKB,
    });
  }

  return results;
}

/** Reads every .rs file under `dir` (no shell — works on Windows and with any directory name). */
function readRustSources(dir: string): string {
  const chunks: string[] = [];
  function walk(current: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'target' && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.rs')) {
        try {
          chunks.push(readFileSync(full, 'utf-8'));
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  walk(dir);
  return chunks.join('\n');
}

/**
 * Names declared in dependency tables of a Cargo.toml (`[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, `[workspace.dependencies]`,
 * `[target.*.dependencies]`, and `[dependencies.name]` sub-tables). Keys of
 * other tables ([package], [lib], [profile.*], [features]) are not crates.
 */
function declaredDependencyNames(cargoToml: string): string[] {
  const names = new Set<string>();
  let inDependencyTable = false;

  for (const rawLine of cargoToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) {
      const table = header[1];
      // [dependencies.name] declares one crate through its own table
      const sub = table.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/);
      if (sub) names.add(sub[1]);
      inDependencyTable = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(table);
      continue;
    }
    if (!inDependencyTable || !line || line.startsWith('#')) continue;
    const key = line.match(/^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\s*=/);
    if (key) names.add(key[1]);
  }
  return [...names];
}

/**
 * Detects unused crate dependencies by analyzing Rust source files.
 *
 * A crate counts as used when its (underscored) name appears as a path or
 * macro root anywhere in the sources — `serde_json::json!`, `uuid::Uuid`,
 * `use reqwest::…` — not only in `use` statements.
 */
export function detectUnusedCrates(
  cargoTomlPath: string,
  rustSourceDir: string,
): string[] {
  if (!existsSync(cargoTomlPath)) return [];

  const declaredCrates = declaredDependencyNames(readFileSync(cargoTomlPath, 'utf-8'));
  const source = readRustSources(rustSourceDir)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const unusedCrates = declaredCrates.filter((crate) => {
    const ident = crate.replace(/-/g, '_');
    return !new RegExp(`\\b${ident}\\b`).test(source);
  });

  // Don't flag napi/napi-derive as unused (they're used via macros)
  return unusedCrates.filter((c) => c !== 'napi' && c !== 'napi-derive');
}


/**
 * Generates an optimized Cargo.toml with minimal features.
 */
export function generateOptimizedCargoToml(cargoTomlPath: string): string {
  if (!existsSync(cargoTomlPath)) return '';

  const content = readFileSync(cargoTomlPath, 'utf-8');
  const usages = analyzeCargoFeatures(cargoTomlPath);

  let optimized = content;

  for (const usage of usages) {
    if (usage.unusedFeatures.length === 0) continue;

    const minimal = MINIMAL_FEATURES[usage.crate];
    if (!minimal) continue;

    // Replace features array in the dependency declaration
    const oldFeatures = `features = [${usage.allFeatures.map(f => `"${f}"`).join(', ')}]`;
    const newFeatures = `features = [${usage.recommendedFeatures.map(f => `"${f}"`).join(', ')}]`;

    optimized = optimized.replace(oldFeatures, newFeatures);
  }

  // Ensure LTO and strip are enabled in release profile
  if (!optimized.includes('lto = true')) {
    optimized += '\n[profile.release]\nlto = true\nopt-level = 3\nstrip = true\n';
  }

  return optimized;
}

/**
 * Runs full tree shaking analysis on a project.
 */
export function treeShakeAnalysis(
  projectRoot: string,
  rustSourceDir?: string,
): TreeShakeResult {
  const cargoTomlPath = join(projectRoot, 'packages', 'core', 'native', 'Cargo.toml');
  const sourceDir = rustSourceDir ?? join(projectRoot, 'packages', 'core', 'native', 'src');

  const crateUsages = analyzeCargoFeatures(cargoTomlPath);
  const unusedCrates = detectUnusedCrates(cargoTomlPath, sourceDir);
  const optimizedCargoToml = generateOptimizedCargoToml(cargoTomlPath);

  const totalPotentialSavingsKB = crateUsages.reduce(
    (sum, u) => sum + u.potentialSizeSavingsKB,
    0,
  );

  const warnings: string[] = [];
  for (const usage of crateUsages) {
    if (usage.unusedFeatures.length > 0) {
      const minimal = MINIMAL_FEATURES[usage.crate];
      warnings.push(
        `${usage.crate}: ${usage.unusedFeatures.length} unused feature(s): ${usage.unusedFeatures.join(', ')}` +
        (minimal ? ` — ${minimal.description}` : ''),
      );
    }
  }

  for (const crate of unusedCrates) {
    warnings.push(`${crate}: crate declared in Cargo.toml but not used in source — remove to save space`);
  }

  return {
    crateUsages,
    unusedCrates,
    totalPotentialSavingsKB,
    optimizedCargoToml,
    warnings,
  };
}

/**
 * Formats tree shaking results for CLI output.
 */
export function formatTreeShakeResult(result: TreeShakeResult): string {
  const lines: string[] = [
    '\n=== Rust Addon Tree Shaking Analysis ===\n',
  ];

  if (result.warnings.length === 0) {
    lines.push(`${green('✓')} No unused features or crates detected`);
    return lines.join('\n');
  }

  lines.push(`Potential savings: ~${result.totalPotentialSavingsKB}KB\n`);

  for (const usage of result.crateUsages) {
    if (usage.unusedFeatures.length === 0) continue;
    lines.push(`${yellow('⚠')} ${usage.crate}:`);
    lines.push(`  Current features: [${usage.allFeatures.join(', ')}]`);
    lines.push(`  Recommended:      [${usage.recommendedFeatures.join(', ')}]`);
    lines.push(`  Estimated savings: ~${usage.potentialSizeSavingsKB}KB\n`);
  }

  if (result.unusedCrates.length > 0) {
    lines.push(`${red('✗')} Unused crates:`);
    for (const crate of result.unusedCrates) {
      lines.push(`  • ${crate} — remove from Cargo.toml`);
    }
  }

  lines.push(`\n${dim('Run with --fix to apply optimized Cargo.toml')}`);
  return lines.join('\n');
}

/**
 * Applies the optimized Cargo.toml to disk.
 */
export function applyTreeShaking(projectRoot: string): { applied: boolean; backupPath: string } {
  const cargoTomlPath = join(projectRoot, 'packages', 'core', 'native', 'Cargo.toml');
  const backupPath = cargoTomlPath + '.bak';

  // Backup original
  const original = readFileSync(cargoTomlPath, 'utf-8');
  writeFileSync(backupPath, original, 'utf-8');

  // Write optimized
  const optimized = generateOptimizedCargoToml(cargoTomlPath);
  writeFileSync(cargoTomlPath, optimized, 'utf-8');

  return { applied: true, backupPath };
}

// ---------------------------------------------------------------------------

function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
