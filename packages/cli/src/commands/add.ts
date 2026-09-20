/**
 * `pledge add` / `pledge remove` / `pledge update` — Rust crate management.
 *
 * Goal #216: Version-pinned crate management with Cargo.lock.
 * - `pledge add sqlx@0.8` — add version-pinned crate
 * - `pledge add sqlx` — add crate with default version from SUPPORTED_CRATES
 * - `pledge remove sqlx` — remove crate
 * - `pledge update` — update all crates to latest compatible versions
 * - `pledge list` — list all installed Rust crates
 *
 * Cargo.lock is checked into git for reproducible builds.
 */

import {
  addCrate,
  removeCrate,
  listCrates,
  SUPPORTED_CRATES,
  ensureRootCargoToml,
} from 'pledgestack-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface AddOptions {
  /** Version spec (e.g., "0.8" or "{ version = \"0.8\", features = [\"json\"] }") */
  version?: string;
}

/**
 * Parses a crate spec like "sqlx@0.8" into name and version.
 */
function parseCrateSpec(spec: string): { name: string; version?: string } {
  const atIndex = spec.indexOf('@');
  if (atIndex === -1) {
    return { name: spec };
  }
  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}

/**
 * Formats a version string into a Cargo.toml dependency spec.
 * "0.8" → '"0.8"'
 * "{ version = \"0.8\", features = [\"json\"] }" → as-is
 */
function formatVersionSpec(name: string, version: string): string {
  // If it starts with {, it's a full spec
  if (version.startsWith('{')) {
    return version;
  }

  // Check if this crate has a default spec with features
  const defaultSpec = SUPPORTED_CRATES[name];
  if (defaultSpec) {
    // Try to replace the version in the default spec
    const versionMatch = defaultSpec.match(/version\s*=\s*"([^"]*)"/);
    if (versionMatch) {
      return defaultSpec.replace(/version\s*=\s*"[^"]*"/, `version = "${version}"`);
    }
  }

  // Simple version string
  return `"${version}"`;
}

/**
 * Resolves the Cargo dependency spec for `pledge add`. An explicit version
 * (`sqlx@0.8`) or full spec (`pledge add sqlx '{ version = "0.8" }'`, passed
 * as `opts.version`) wins over the SUPPORTED_CRATES default. Returns
 * undefined for an unknown crate with no version.
 */
export function resolveVersionSpec(name: string, version?: string, explicitSpec?: string): string | undefined {
  const requested = version ?? explicitSpec?.trim();
  if (requested) return formatVersionSpec(name, requested);
  return SUPPORTED_CRATES[name];
}

export async function addCommand(crateSpec: string, opts?: AddOptions): Promise<void> {
  const { name, version } = parseCrateSpec(crateSpec);
  const projectRoot = process.cwd();

  // Determine version spec (before touching the filesystem, so an unknown
  // crate does not leave a freshly written Cargo.toml behind)
  const versionSpec = resolveVersionSpec(name, version, opts?.version);

  if (!versionSpec) {
    // Unknown crate — user must provide version
    console.error(
      `Unknown crate: ${name}\n` +
      `Provide a version: pledge add ${name}@1.0.0\n` +
      `Or a full spec: pledge add ${name} '{ version = "1.0", features = ["json"] }'`,
    );
    process.exit(1);
  }

  // Ensure Cargo.toml exists
  await ensureRootCargoToml(projectRoot);

  // Add the crate
  await addCrate(projectRoot, name, versionSpec);

  // Run cargo update to refresh Cargo.lock
  const cargoResult = await runCargoUpdate(projectRoot, name);

  console.log(`\x1b[32m✓\x1b[0m Added \x1b[1m${name}\x1b[0m ${versionSpec} to Cargo.toml`);
  reportCargoLock(cargoResult);
}

export async function removeCommand(crateName: string): Promise<void> {
  const projectRoot = process.cwd();

  // Check if crate is installed
  const crates = await listCrates(projectRoot);
  if (!crates[crateName]) {
    console.error(`\x1b[33m${crateName}\x1b[0m is not installed.`);
    process.exit(1);
  }

  await removeCrate(projectRoot, crateName);

  // Update Cargo.lock
  const cargoResult = await runCargoUpdate(projectRoot);

  console.log(`\x1b[32m✓\x1b[0m Removed \x1b[1m${crateName}\x1b[0m from Cargo.toml`);
  reportCargoLock(cargoResult);
}

export async function listCommand(): Promise<void> {
  const projectRoot = process.cwd();
  const crates = await listCrates(projectRoot);

  if (Object.keys(crates).length === 0) {
    console.log('No Rust crates installed. Use `pledge add <crate>` to add one.');
    console.log('\nAvailable crates:');
    for (const [name, spec] of Object.entries(SUPPORTED_CRATES)) {
      console.log(`  ${name.padEnd(25)} ${spec}`);
    }
    return;
  }

  console.log('\n\x1b[1mInstalled Rust crates:\x1b[0m\n');
  for (const [name, spec] of Object.entries(crates)) {
    console.log(`  ${name.padEnd(25)} ${spec}`);
  }

  // Check if Cargo.lock exists
  const lockPath = join(projectRoot, 'Cargo.lock');
  if (existsSync(lockPath)) {
    console.log('\n\x1b[32m✓\x1b[0m Cargo.lock exists (reproducible builds enabled)');
  } else {
    console.log('\n\x1b[33m⚠\x1b[0m Cargo.lock not found — run `cargo generate-lockfile` to create it');
  }
}

export async function updateCommand(crateName?: string): Promise<void> {
  const projectRoot = process.cwd();

  if (crateName) {
    // Update specific crate
    console.log(`Updating \x1b[1m${crateName}\x1b[0m...`);
    const cargoResult = await runCargoUpdate(projectRoot, crateName);
    if (cargoResult.ok) console.log(`\x1b[32m✓\x1b[0m Updated ${crateName}`);
    else reportCargoLock(cargoResult);
  } else {
    // Update all crates
    console.log('Updating all Rust crates...');
    const cargoResult = await runCargoUpdate(projectRoot);
    if (cargoResult.ok) console.log(`\x1b[32m✓\x1b[0m All crates updated`);
    else reportCargoLock(cargoResult);
  }

  // Show what changed
  const crates = await listCrates(projectRoot);
  console.log('\nCurrent versions:');
  for (const [name, spec] of Object.entries(crates)) {
    console.log(`  ${name.padEnd(25)} ${spec}`);
  }
}

/** Result of attempting `cargo update`. */
interface CargoUpdateResult {
  ok: boolean;
  cargoMissing: boolean;
}

/**
 * Runs `cargo update` to refresh Cargo.lock. Reports whether cargo actually
 * ran, so callers don't claim "Cargo.lock updated" when cargo is missing or
 * the update failed.
 */
async function runCargoUpdate(projectRoot: string, crateName?: string): Promise<CargoUpdateResult> {
  return new Promise((resolve) => {
    const args = ['update'];
    if (crateName) {
      args.push('--package', crateName);
    }

    const child = spawn('cargo', args, {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    child.on('error', () => resolve({ ok: false, cargoMissing: true }));
    child.on('close', (code) => resolve({ ok: code === 0, cargoMissing: false }));
  });
}

/** Print a message about the Cargo.lock state after a crate change. */
function reportCargoLock(result: CargoUpdateResult): void {
  if (result.ok) {
    console.log(`  Cargo.lock updated. Commit it for reproducible builds.`);
  } else if (result.cargoMissing) {
    console.log(`\x1b[33m  ⚠ cargo not found — Cargo.toml was updated but Cargo.lock was NOT regenerated.\x1b[0m`);
    console.log(`    Install the Rust toolchain (https://rustup.rs) and run \`cargo update\`.`);
  } else {
    console.log(`\x1b[33m  ⚠ \`cargo update\` failed — Cargo.lock may be out of date. Run \`cargo update\` manually.\x1b[0m`);
  }
}
