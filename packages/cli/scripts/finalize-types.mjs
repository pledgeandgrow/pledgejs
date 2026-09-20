/**
 * Makes the CLI package's emitted type declarations usable by consumers.
 *
 * `tsc -p tsconfig.emit.json` (rootDir "../..") writes declarations for the CLI
 * *and every workspace package it bundles* under `dist/packages/<pkg>/src/`,
 * and leaves workspace imports as bare specifiers (`from 'pledgestack-core'`)
 * that do not exist in a consumer's node_modules. This step:
 *
 *  1. rewrites those bare `pledgestack-*` specifiers in the emitted .d.ts files
 *     to relative paths inside `dist/packages`, and
 *  2. writes the entry declarations the package.json `exports` map points at
 *     (`dist/index.d.ts`, `dist/server.d.ts`, ...), re-exporting the emitted
 *     `dist/packages/cli/src/<entry>` declarations.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** `pledgestack-core` -> `core`, `pledgestack-eslint-plugin` -> `eslint-plugin-pledge`, ... */
function packageDir(name) {
  if (name === 'pledgestack-eslint-plugin') return 'eslint-plugin-pledge';
  return name.replace(/^pledgestack-/, '');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const SPECIFIER = /(from\s+|import\(\s*)(['"])(pledgestack-[a-z0-9-]+)(\/[^'"]*)?\2/g;

/**
 * @param {string} outDir absolute path to the CLI `dist` directory
 * @param {string[]} entries entry names (e.g. 'index', 'server', 'auth')
 */
export function finalizeTypes(outDir, entries) {
  const root = join(outDir, 'packages');
  if (!existsSync(root)) {
    console.warn('finalize-types: no dist/packages declarations found — skipping');
    return;
  }

  let rewritten = 0;
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(SPECIFIER, (match, prefix, quote, name, sub) => {
      const target = join(root, packageDir(name), 'src', sub ? sub.slice(1) : 'index');
      let rel = relative(dirname(file), target).split('\\').join('/');
      if (!rel.startsWith('.')) rel = './' + rel;
      return `${prefix}${quote}${rel}${quote}`;
    });
    if (next !== text) {
      writeFileSync(file, next);
      rewritten++;
    }
  }

  for (const entry of entries) {
    if (entry === 'bin') continue;
    const source = join(root, 'cli', 'src', `${entry}.d.ts`);
    if (!existsSync(source)) continue;
    writeFileSync(join(outDir, `${entry}.d.ts`), `export * from './packages/cli/src/${entry}';\n`);
  }
  console.log(`finalize-types: rewrote ${rewritten} declaration file(s), wrote ${entries.length - 1} entry declaration(s)`);
}
