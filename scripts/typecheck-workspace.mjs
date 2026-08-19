#!/usr/bin/env node
/**
 * Typechecks the whole PledgeStack monorepo.
 *
 * The root tsconfig.json intentionally only lists `types/**\/*.d.ts` in its
 * `include` (it exists to hold shared compiler options + path aliases for
 * every package's own tsconfig to extend) — running `tsc --noEmit` directly
 * against it, as both the old CI workflow and this package's `typecheck`
 * script used to do, only ever typechecks those two ambient declaration
 * files, never the ~500 real source files under packages/*\/src. That gap is
 * exactly how a real bug (packages/adapters/src/cloudflare.ts calling
 * edge-security.ts functions with the wrong signatures) shipped without CI
 * ever catching it.
 *
 * `tsc -b` (project references / composite build mode) is the correct way to
 * typecheck this monorepo, but it has to be invoked once per "leaf" project
 * that isn't itself referenced by another project — otherwise leaves like
 * the renderer-* packages (deliberately *not* referenced by pledgestack-core,
 * see packages/core/src/render/renderer-manager.ts, to avoid a circular
 * project reference) are silently skipped. This script runs `tsc -b` against
 * every such leaf, plus a plain `tsc --noEmit` for the handful of packages
 * that are standalone (not part of the composite/project-reference graph at
 * all: create-pledge-app, eslint-plugin-pledge, the two VS Code extensions).
 */

import { spawnSync } from 'node:child_process';

const COMPOSITE_LEAVES = [
  // Pulls in shared/core/server/client/auth/state/api/a11y/overlay/seo/
  // image/font/mdx/og/sitemap/rss/ws/adapters/privacy/bundler-* transitively
  // via its own tsconfig.json "references".
  'packages/cli',
  // Not referenced by pledgestack-core (would create a circular project
  // reference — renderer-* depends on core, not the other way around), so
  // each needs its own invocation to be checked at all.
  'packages/renderer-react',
  'packages/renderer-vue',
  'packages/renderer-solid',
  'packages/renderer-svelte',
  // composite:true but not referenced by any other project.
  'packages/eslint-plugin-pledge',
];

const STANDALONE_PROJECTS = [
  'packages/create-pledge-app/tsconfig.json',
  'packages/vscode-extension/tsconfig.json',
  'packages/vscode-psx/tsconfig.json',
];

let failed = false;

function run(label, command, args) {
  console.log(`\n\x1b[1m\x1b[36m→ ${label}\x1b[0m`);
  // On Windows, npx resolves to npx.cmd, which requires shell:true to spawn —
  // but passing shell:true with a separate args array is deprecated (Node
  // warns it can't escape them safely), so join into one string ourselves.
  const result = process.platform === 'win32'
    ? spawnSync([command, ...args].join(' '), { stdio: 'inherit', shell: true })
    : spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    failed = true;
    console.error(`\x1b[31m✗ ${label} failed\x1b[0m`);
  }
}

for (const project of COMPOSITE_LEAVES) {
  run(project, 'npx', ['tsc', '-b', project]);
}

for (const tsconfig of STANDALONE_PROJECTS) {
  run(tsconfig, 'npx', ['tsc', '--noEmit', '-p', tsconfig]);
}

if (failed) {
  console.error('\n\x1b[31m✗ Typecheck failed.\x1b[0m\n');
  process.exit(1);
}

console.log('\n\x1b[32m✓ No type errors found across the workspace.\x1b[0m\n');
