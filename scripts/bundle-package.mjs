#!/usr/bin/env node
/**
 * Bundles a workspace library package's JavaScript for publishing.
 *
 * Why: `tsc` (moduleResolution "bundler") emits ESM whose relative imports are
 * extensionless (`export * from './router'`), which Node's ESM loader cannot
 * resolve — a package built that way installs fine and then crashes on import.
 * This script re-emits the runtime JS with esbuild instead, producing files that
 * load in plain Node ESM. Type declarations still come from `tsc --build`
 * (packages set `emitDeclarationOnly`).
 *
 * Usage (from a package directory, after `tsc --build`):
 *   node ../../scripts/bundle-package.mjs
 *
 * Entry points are derived from the package's `exports` / `main`: every target
 * of the form `./dist/<path>.js` maps to `src/<path>.ts(x)`; a wildcard target
 * (`./dist/*.js`) maps to every top-level source module. All bare imports
 * (dependencies, peers, workspace siblings, node builtins) stay external.
 */

import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkgDir = resolve(process.argv[2] ?? process.cwd());
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const srcDir = join(pkgDir, 'src');

/** Collects every string leaf of an `exports` value. */
function leaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
  return out;
}

const targets = [...leaves(pkg.exports), ...(pkg.main ? [pkg.main] : [])].filter(
  (t) => t.startsWith('./dist/') && t.endsWith('.js'),
);

const isSource = (f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !/\.d\.ts$/.test(f);
const entries = {};

function resolveSource(rel) {
  for (const candidate of [`${rel}.ts`, `${rel}.tsx`]) {
    if (existsSync(join(srcDir, candidate))) return join(srcDir, candidate);
  }
  return null;
}

for (const target of new Set(targets)) {
  const rel = target.slice('./dist/'.length, -'.js'.length);
  if (rel.includes('*')) {
    for (const f of readdirSync(srcDir)) {
      if (isSource(f)) entries[f.replace(/\.tsx?$/, '')] = join(srcDir, f);
    }
    continue;
  }
  const src = resolveSource(rel);
  if (!src) {
    console.error(`bundle-package: no source for export target ${target} (looked for src/${rel}.ts[x])`);
    process.exit(1);
  }
  entries[rel] = src;
}

if (Object.keys(entries).length === 0) {
  console.error(`bundle-package: ${pkg.name} declares no ./dist/*.js targets — nothing to bundle`);
  process.exit(1);
}

// Remove stale JS from previous builds (tsc used to emit extensionless JS here).
const distDir = join(pkgDir, 'dist');
if (existsSync(distDir)) {
  const clean = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) clean(p);
      else if (/\.js(\.map)?$/.test(e.name)) rmSync(p, { force: true });
    }
  };
  clean(distDir);
}

await build({
  entryPoints: entries,
  outdir: distDir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'warning',
});

console.log(`bundle-package: ${pkg.name} -> ${Object.keys(entries).length} entr${Object.keys(entries).length === 1 ? 'y' : 'ies'}`);
