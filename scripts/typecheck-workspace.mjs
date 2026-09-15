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
 * `tsc -b` (project references / composite build mode) was the original approach,
 * but it EMITS JS into each package's dist/ — overwriting the esbuild-bundled CLI
 * output with tsc's unbundled emit (extensionless `import('./commands/x')`
 * calls that Node ESM can't resolve, breaking `pnpm test`/`dev`/`build`).
 * `tsc -b --noEmit` doesn't work either: composite referenced projects may not
 * disable emit (TS6310). So we use `tsc --noEmit -p` per leaf project instead —
 * the root tsconfig's `paths` mapping resolves all workspace imports to source
 * files directly, so project references aren't needed for typechecking. This
 * script runs `tsc --noEmit -p` against every leaf project that isn't itself
 * referenced by another project, plus the standalone projects (create-pledge-app,
 * eslint-plugin-pledge, the two VS Code extensions).
 */

import { spawnSync } from 'node:child_process';

// All projects are typechecked with `tsc --noEmit -p` — no emit, no project
// references needed (the root tsconfig's `paths` resolve workspace imports to
// source files directly). Listed by tsconfig path.
const PROJECTS = [
  // Pulls in shared/core/server/client/auth/state/api/a11y/overlay/seo/
  // image/font/mdx/og/sitemap/rss/ws/adapters/privacy/bundler-* transitively
  // via the root tsconfig's path aliases.
  'packages/cli/tsconfig.json',
  // Not referenced by pledgestack-core (would create a circular project
  // reference — renderer-* depends on core, not the other way around), so
  // each needs its own invocation to be checked at all.
  'packages/renderer-react/tsconfig.json',
  'packages/renderer-vue/tsconfig.json',
  'packages/renderer-solid/tsconfig.json',
  'packages/renderer-svelte/tsconfig.json',
  // Leaf plugins only reached via `export *` re-exports in the CLI. A bare
  // re-export doesn't always force the target's own bodies through contextual
  // checks reliably, so list them explicitly — packages/mdx shipped a
  // `config.mdx` bug that only `tsc --build` caught.
  'packages/mdx/tsconfig.json',
  'packages/content/tsconfig.json',
  'packages/deploy/tsconfig.json',
  // Standalone (not part of the composite/project-reference graph).
  'packages/eslint-plugin-pledge/tsconfig.json',
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

for (const tsconfig of PROJECTS) {
  run(tsconfig, 'npx', ['tsc', '--noEmit', '-p', tsconfig]);
}

if (failed) {
  console.error('\n\x1b[31m✗ Typecheck failed.\x1b[0m\n');
  process.exit(1);
}

console.log('\n\x1b[32m✓ No type errors found across the workspace.\x1b[0m\n');
