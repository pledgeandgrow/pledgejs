#!/usr/bin/env node
/**
 * Release-readiness check for the PledgeStack monorepo.
 *
 * Verifies, for every publishable package (any package under packages/ that is
 * not `"private": true`):
 *   - metadata: license, repository (with directory), homepage, bugs, engines,
 *     publishConfig.access = public, `files`, a README and a LICENSE file
 *   - the version matches the release version (all public packages move together)
 *   - a CHANGELOG.md exists
 *   - every `workspace:` dependency points at another *public* package
 *   - every `pledgestack-*` package imported by shipped source is declared in
 *     dependencies / peerDependencies / optionalDependencies (otherwise the
 *     published package would crash for consumers with "Cannot find package")
 *   - with `--dist`: every `exports` / `main` / `bin` / `types` target exists
 *     on disk (run after `pnpm build:packages`)
 *   - .changeset/config.json does not ignore any public package and lists them
 *     all in one `fixed` group
 *
 * Usage: node scripts/check-release.mjs [--dist]
 * Exit code 1 when any problem is found.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const checkDist = process.argv.includes('--dist');
const problems = [];
const fail = (pkg, msg) => problems.push(`${pkg}: ${msg}`);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const packages = [];
for (const dir of readdirSync(join(ROOT, 'packages'))) {
  const pj = join(ROOT, 'packages', dir, 'package.json');
  if (!existsSync(pj)) continue;
  const json = readJson(pj);
  packages.push({ dir, path: join(ROOT, 'packages', dir), json, isPublic: !json.private });
}
const publicPkgs = packages.filter((p) => p.isPublic);
const publicNames = new Set(publicPkgs.map((p) => p.json.name));
const releaseVersion = publicPkgs.find((p) => p.json.name === 'pledgestack')?.json.version;

/** Recursively collects non-test source files. */
function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'templates') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// Package specifiers that appear only inside *generated code* (template strings that are
// emitted into a user's project and resolved there), not as real imports of the shipping package.
const GENERATED_CODE_REFS = {
  'pledgestack-server': new Set(['pledgestack-client']),
};

function importedWorkspaceNames(file) {
  // Ignore comment lines (JSDoc examples such as `import x from 'pledgestack'`).
  const text = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  const found = new Set();
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](pledgestack(?:-[a-z0-9-]+)?|create-pledge-app)(?:\/[^'"]*)?['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  return found;
}

function exportTargets(pkg) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pkg.exports);
  if (pkg.main) out.push(pkg.main);
  if (pkg.types) out.push(pkg.types);
  if (typeof pkg.bin === 'string') out.push(pkg.bin);
  else if (pkg.bin) out.push(...Object.values(pkg.bin));
  return [...new Set(out)];
}

for (const { dir, path, json, isPublic } of packages) {
  const label = json.name ?? dir;

  if (!isPublic) {
    if (!/vscode/.test(dir)) fail(label, 'is private but is not one of the VS Code extensions — decide whether it should be public');
    continue;
  }

  if (releaseVersion && json.version !== releaseVersion) fail(label, `version ${json.version} != release version ${releaseVersion}`);
  if (json.license !== 'MIT') fail(label, 'missing license "MIT"');
  if (!json.repository?.url || json.repository.directory !== `packages/${dir}`) fail(label, 'repository.url / repository.directory missing or wrong');
  if (!json.homepage) fail(label, 'missing homepage');
  if (!json.bugs?.url) fail(label, 'missing bugs.url');
  if (!json.engines?.node) fail(label, 'missing engines.node');
  if (json.publishConfig?.access !== 'public') fail(label, 'publishConfig.access must be "public"');
  if (!Array.isArray(json.files) || !json.files.includes('dist')) fail(label, '`files` must include "dist"');
  if (!existsSync(join(path, 'README.md'))) fail(label, 'missing README.md');
  if (!existsSync(join(path, 'LICENSE'))) fail(label, 'missing LICENSE');
  if (!existsSync(join(path, 'CHANGELOG.md'))) fail(label, 'missing CHANGELOG.md');
  if (!json.exports && dir !== 'create-pledge-app') fail(label, 'missing `exports`');

  const declared = new Set([
    ...Object.keys(json.dependencies ?? {}),
    ...Object.keys(json.peerDependencies ?? {}),
    ...Object.keys(json.optionalDependencies ?? {}),
  ]);

  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(json[section] ?? {})) {
      if (String(range).startsWith('workspace:') && !publicNames.has(dep)) {
        fail(label, `${section}.${dep} is a workspace dependency on a non-public package`);
      }
    }
  }

  // The CLI inlines every workspace package into its own bundle (esbuild alias),
  // so its workspace deps are devDependencies by design.
  if (dir !== 'cli') {
    const shipped = sourceFiles(join(path, 'src'));
    const missing = new Set();
    for (const f of shipped) {
      for (const name of importedWorkspaceNames(f)) {
        if (name !== json.name && !declared.has(name) && !GENERATED_CODE_REFS[json.name]?.has(name)) missing.add(name);
      }
    }
    for (const name of missing) fail(label, `imports "${name}" in shipped source but does not declare it in dependencies`);
  }

  if (checkDist) {
    for (const target of exportTargets(json)) {
      if (target.includes('*')) continue;
      if (!target.startsWith('./') && !target.startsWith('bin/')) continue;
      if (!existsSync(join(path, target))) fail(label, `target ${target} does not exist (run pnpm build:packages)`);
    }
    // No published .js file may contain extensionless relative imports (Node ESM cannot load them).
    const distDir = join(path, 'dist');
    if (existsSync(distDir) && dir !== 'create-pledge-app') {
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) {
            const text = readFileSync(p, 'utf8');
            // Static import/export statements at the start of a line only — relative
            // specifiers inside generated-code strings are not module imports.
            const bad = /^\s*(?:import|export)\s[^;'"]*?from\s*['"](\.{1,2}\/[^'"]*?)['"]/gm;
            let m;
            while ((m = bad.exec(text)) !== null) {
              if (!/\.(js|mjs|cjs|json|node)$/.test(m[1])) {
                fail(label, `${p.slice(path.length + 1)} has an extensionless relative import "${m[1]}" (not loadable in Node ESM)`);
                break;
              }
            }
          }
        }
      };
      walk(distDir);
    }
  }
}

// --- version consistency ------------------------------------------------------
// PLEDGE_VERSION in pledgestack-shared must match the release version — it is
// the framework version reported by `pledge info` and scaffolded health routes.
// This constant has drifted stale before; check it here so a release can't ship
// with a mismatched version string.
const constantsPath = join(ROOT, 'packages', 'shared', 'src', 'constants.ts');
if (existsSync(constantsPath) && releaseVersion) {
  const constants = readFileSync(constantsPath, 'utf8');
  const m = constants.match(/PLEDGE_VERSION\s*=\s*'([^']+)'/);
  if (!m) problems.push('PLEDGE_VERSION not found in packages/shared/src/constants.ts');
  else if (m[1] !== releaseVersion) problems.push(`PLEDGE_VERSION ${m[1]} != release version ${releaseVersion} — update packages/shared/src/constants.ts`);
}

// --- changesets ---------------------------------------------------------------
const csPath = join(ROOT, '.changeset', 'config.json');
if (!existsSync(csPath)) {
  problems.push('.changeset/config.json is missing');
} else {
  const cs = readJson(csPath);
  const ignored = new Set(cs.ignore ?? []);
  for (const name of publicNames) if (ignored.has(name)) problems.push(`.changeset/config.json ignores public package ${name}`);
  const grouped = new Set((cs.fixed ?? []).flat());
  for (const name of publicNames) if (!grouped.has(name)) problems.push(`.changeset/config.json "fixed" group does not include ${name}`);
  for (const name of grouped) if (!publicNames.has(name)) problems.push(`.changeset/config.json "fixed" group lists unknown/private package ${name}`);
}

// --- release workflow ------------------------------------------------------------
const wf = join(ROOT, '.github', 'workflows', 'release.yml');
if (existsSync(wf) && !/changeset/.test(readFileSync(wf, 'utf8'))) {
  problems.push('.github/workflows/release.yml does not publish via changesets');
}

if (problems.length > 0) {
  console.error(`\nRelease check FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`Release check passed: ${publicPkgs.length} public packages @ ${releaseVersion}${checkDist ? ' (dist verified)' : ''}.`);
