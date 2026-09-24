/**
 * PSX workspace manager — manages Rust dependencies across all .psx files.
 *
 * Instead of each .psx file having its own Cargo.toml (which would mean
 * each file compiles separately with its own dependency tree), PledgeStack
 * uses a single Cargo workspace at the project root.
 *
 * Structure:
 *   project/
 *     package.json          ← JS/TS deps (React, etc.)
 *     Cargo.toml            ← Rust deps (sqlx, argon2, reqwest, etc.) — shared
 *     app/
 *       users/page.psx      ← uses sqlx (from root Cargo.toml)
 *       auth/login.psx      ← uses argon2 (from root Cargo.toml)
 *     .pledge/
 *       cargo/              ← workspace target dir
 *         users/            ← generated crate for users.psx
 *           Cargo.toml      ← inherits from root workspace
 *           lib.rs           ← generated from <rust> block
 *         auth/
 *           Cargo.toml
 *           lib.rs
 *
 * Benefits:
 * - Dependencies declared once at project root
 * - Shared compilation cache — sqlx compiles once, reused by all .psx files
 * - `pledge add sqlx` adds to root Cargo.toml, available everywhere
 * - No node_modules equivalent — Rust uses global ~/.cargo/registry cache
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CargoProfileConfig,
  DEFAULT_CARGO_DEV_PROFILE,
  DEFAULT_CARGO_RELEASE_PROFILE,
  cargoProfileToToml,
} from 'pledgestack-shared';

/**
 * Default dependencies included in every PledgeStack project.
 * These are the "batteries included" Rust crates.
 */
export const DEFAULT_RUST_DEPENDENCIES: Record<string, string> = {
  'napi': '{ version = "2", features = ["napi8", "async"] }',
  'napi-derive': '"2"',
  'serde': '{ version = "1", features = ["derive"] }',
  'serde_json': '"1"',
  'tokio': '{ version = "1", features = ["full"] }',
};

/**
 * Optional crates that users can add with `pledge add <crate>`.
 * Each entry maps to a Cargo.toml dependency line.
 */
export const SUPPORTED_CRATES: Record<string, string> = {
  // Database
  'sqlx': '{ version = "0.7", features = ["runtime-tokio", "postgres", "macros", "chrono", "uuid"] }',
  'sea-orm': '{ version = "0.12", features = ["sqlx-postgres", "runtime-tokio-rustls"] }',
  'redis': '{ version = "0.24", features = ["tokio-comp"] }',
  'mongodb': '{ version = "2.8" }',
  'diesel': '{ version = "2", features = ["postgres", "r2d2"] }',

  // HTTP / Networking
  'reqwest': '{ version = "0.12", features = ["json", "stream"] }',
  'hyper': '{ version = "1", features = ["full"] }',
  'tokio-tungstenite': '{ version = "0.21", features = ["native-tls"] }',

  // Auth & Security
  'jsonwebtoken': '"9"',
  'argon2': '"0.5"',
  'bcrypt': '"0.15"',
  'rand': '"0.8"',

  // Serialization
  'rmp-serde': '"1"',
  'prost': '"0.12"',

  // File processing
  'image': '"0.24"',
  'printpdf': '"0.7"',
  'calamine': '"0.22"',
  'rust_xlsxwriter': '"0.62"',

  // Background jobs
  'apalis': '{ version = "0.6", features = ["tokio"] }',
  'tokio-cron-scheduler': '"0.10"',

  // Observability
  'tracing': '"0.1"',
  'tracing-subscriber': '{ version = "0.3", features = ["env-filter", "json"] }',
  'tracing-opentelemetry': '"0.23"',

  // Utilities
  'uuid': '{ version = "1", features = ["v4", "serde"] }',
  'chrono': '{ version = "0.4", features = ["serde"] }',
  'once_cell': '"1"',
  'anyhow': '"1"',
  'thiserror': '"1"',
};

/**
 * Generates the root Cargo.toml for a PledgeStack project.
 * This is the workspace manifest that all .psx files inherit from.
 *
 * Profile sections are generated from CargoProfileConfig (#213).
 */
export function generateRootCargoToml(
  dependencies: Record<string, string> = DEFAULT_RUST_DEPENDENCIES,
  devProfile: CargoProfileConfig = DEFAULT_CARGO_DEV_PROFILE,
  releaseProfile: CargoProfileConfig = DEFAULT_CARGO_RELEASE_PROFILE,
): string {
  const depLines = Object.entries(dependencies)
    .map(([name, spec]) => `${name} = ${spec}`)
    .join('\n');

  return `[workspace]
members = [".pledge/cargo/*"]
resolver = "2"

[workspace.dependencies]
${depLines}

${cargoProfileToToml(releaseProfile, 'release')}

${cargoProfileToToml(devProfile, 'dev')}
`;
}

/**
 * Cargo package name for a .psx module. Cargo only accepts alphanumerics,
 * `-` and `_`, so anything else in the file name (dots, spaces) becomes `_`.
 */
export function rustCrateName(moduleName: string): string {
  return `pledge-${moduleName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * Base name of the cdylib cargo produces for a module: the crate name with
 * `-` normalised to `_` (e.g. `user-list` -> `pledge_user_list`, giving
 * `libpledge_user_list.so` / `pledge_user_list.dll`).
 */
export function rustLibName(moduleName: string): string {
  return rustCrateName(moduleName).replace(/-/g, '_');
}

/**
 * Generates a per-module Cargo.toml that inherits from the workspace.
 * This is generated for each .psx file by the transform pipeline.
 *
 * Profile sections inherit from the workspace root, so we only need
 * to override if the module has specific needs.
 */
export function generateModuleCargoToml(
  moduleName: string,
  dependencies: string[] = [],
): string {
  const depLines = dependencies
    .map((dep) => `${dep}.workspace = true`)
    .join('\n');

  return `[package]
name = "${rustCrateName(moduleName)}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi.workspace = true
napi-derive.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
${depLines}
`;
}

/**
 * Ensures the root Cargo.toml exists in a project.
 * Called during `pledge init` and `pledge dev`.
 *
 * If the file exists but doesn't have a workspace section, it's backed up
 * and a new workspace manifest is created.
 *
 * Profile sections are generated from the config (#213).
 */
export async function ensureRootCargoToml(
  projectRoot: string,
  devProfile?: CargoProfileConfig,
  releaseProfile?: CargoProfileConfig,
): Promise<void> {
  const cargoPath = join(projectRoot, 'Cargo.toml');

  if (existsSync(cargoPath)) {
    // Check if it's a workspace manifest
    const content = await readFile(cargoPath, 'utf-8');
    if (content.includes('[workspace]')) return;

    // Not a workspace — back it up and create workspace
    await writeFile(`${cargoPath}.backup`, content, 'utf-8');
  }

  const cargoToml = generateRootCargoToml(
    DEFAULT_RUST_DEPENDENCIES,
    devProfile,
    releaseProfile,
  );
  await writeFile(cargoPath, cargoToml, 'utf-8');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Adds a Rust crate to the project's root Cargo.toml.
 * Called by `pledge add <crate>`.
 */
export async function addCrate(
  projectRoot: string,
  crateName: string,
  versionSpec?: string,
): Promise<void> {
  const cargoPath = join(projectRoot, 'Cargo.toml');

  if (!existsSync(cargoPath)) {
    await ensureRootCargoToml(projectRoot);
  }

  // The name is written into Cargo.toml unquoted, so it must be a plain crate
  // name — never something that could start a new key or table.
  if (!/^[A-Za-z0-9_-]+$/.test(crateName)) {
    throw new Error(`Invalid crate name: ${JSON.stringify(crateName)}`);
  }

  const content = await readFile(cargoPath, 'utf-8');

  // Check if already present (whole key, not the tail of a longer crate name)
  if (new RegExp(`^${escapeRegExp(crateName)}\\s*=`, 'm').test(content)) {
    return; // Already installed
  }

  // Get version spec from supported crates or use provided
  const spec = versionSpec ?? SUPPORTED_CRATES[crateName];
  if (!spec) {
    throw new Error(
      `Unknown crate: ${crateName}\n` +
      `Supported crates: ${Object.keys(SUPPORTED_CRATES).join(', ')}\n` +
      `Or provide a version spec: pledge add ${crateName} "{ version = \\"1.0\\" }"`
    );
  }

  // Add to [workspace.dependencies] section
  // (files checked out on Windows use CRLF, so match either line ending)
  const header = /\[workspace\.dependencies\](\r?\n)/;
  const headerMatch = header.exec(content);
  if (!headerMatch) {
    throw new Error(
      `Cargo.toml has no [workspace.dependencies] section — cannot add "${crateName}". ` +
        'Add the section (or regenerate the file) and retry.',
    );
  }
  const eol = headerMatch[1];
  const updated = content.replace(header, () => `[workspace.dependencies]${eol}${crateName} = ${spec}${eol}`);

  await writeFile(cargoPath, updated, 'utf-8');
}

/**
 * Removes a Rust crate from the project's root Cargo.toml.
 * Called by `pledge remove <crate>`.
 */
export async function removeCrate(
  projectRoot: string,
  crateName: string,
): Promise<void> {
  const cargoPath = join(projectRoot, 'Cargo.toml');
  if (!existsSync(cargoPath)) return;

  const content = await readFile(cargoPath, 'utf-8');
  // Remove the crate line — escape regex special chars in crate name
  const escapedName = crateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = content.replace(
    // Match the whole line including its CRLF or LF terminator.
    new RegExp(`^${escapedName}[ \\t]*=[^\\r\\n]*(?:\\r?\\n)?`, 'gm'),
    '',
  );
  await writeFile(cargoPath, updated, 'utf-8');
}

/**
 * Lists all Rust crates in the project's Cargo.toml.
 *
 * Two project layouts exist: the PSX workspace layout keeps deps in the root
 * Cargo.toml under [workspace.dependencies], while the `pledge` scaffold
 * template puts a plain package manifest at server/Cargo.toml with deps under
 * [dependencies]. Both are checked so `pledge list` works on either.
 */
export async function listCrates(projectRoot: string): Promise<Record<string, string>> {
  const cargoPath = existsSync(join(projectRoot, 'Cargo.toml'))
    ? join(projectRoot, 'Cargo.toml')
    : join(projectRoot, 'server', 'Cargo.toml');
  if (!existsSync(cargoPath)) return {};

  const content = await readFile(cargoPath, 'utf-8');
  const crates: Record<string, string> = {};

  for (const section of ['workspace\\.dependencies', 'dependencies']) {
    const match = content.match(new RegExp(`\\[${section}\\]\\r?\\n([\\s\\S]*?)(?:\\r?\\n\\[|$)`));
    if (!match) continue;
    const depRegex = /^(\S+)\s*=\s*(.+)$/gm;
    let depMatch: RegExpExecArray | null;
    while ((depMatch = depRegex.exec(match[1])) !== null) {
      crates[depMatch[1]] = depMatch[2].trim();
    }
  }

  return crates;
}

/**
 * Detects which crates a .psx file uses based on its `use` statements.
 * Returns crate names that should be added to the module's Cargo.toml.
 */
export function detectCratesFromImports(imports: string[]): string[] {
  const crateMap: Record<string, string> = {
    'sqlx': 'sqlx',
    'sea_orm': 'sea-orm',
    'redis': 'redis',
    'mongodb': 'mongodb',
    'diesel': 'diesel',
    'reqwest': 'reqwest',
    'hyper': 'hyper',
    'tokio_tungstenite': 'tokio-tungstenite',
    'jsonwebtoken': 'jsonwebtoken',
    'argon2': 'argon2',
    'bcrypt': 'bcrypt',
    'rand': 'rand',
    'rmp_serde': 'rmp-serde',
    'prost': 'prost',
    'image': 'image',
    'printpdf': 'printpdf',
    'calamine': 'calamine',
    'rust_xlsxwriter': 'rust_xlsxwriter',
    'apalis': 'apalis',
    'tokio_cron_scheduler': 'tokio-cron-scheduler',
    'tracing': 'tracing',
    'tracing_subscriber': 'tracing-subscriber',
    'tracing_opentelemetry': 'tracing-opentelemetry',
    'uuid': 'uuid',
    'chrono': 'chrono',
    'once_cell': 'once_cell',
    'anyhow': 'anyhow',
    'thiserror': 'thiserror',
  };

  const detected = new Set<string>();

  for (const imp of imports) {
    // Extract crate name from use statement: "sqlx::query" → "sqlx"
    const rootCrate = imp.split('::')[0].trim();
    const crateName = crateMap[rootCrate];
    if (crateName) {
      detected.add(crateName);
    }
  }

  return Array.from(detected);
}
