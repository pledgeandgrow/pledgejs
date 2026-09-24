# create-pledge-app

## 0.1.8

### Patch Changes

- Fix a batch of real bugs found by actually running the workspace's own typecheck across every package (previously the root `tsc --noEmit` and CI's "Typecheck" job only checked two small ambient `.d.ts` files, not the ~500 real source files under `packages/*/src` — `pnpm typecheck` now runs `tsc -b`/`tsc --noEmit` against every package via `scripts/typecheck-workspace.mjs`):
  
  - RSC streaming (`renderRSCStream`) now actually delivers the flight payload progressively instead of generating it and discarding it in favor of plain SSR HTML.
  - The Rust SSR acceleration path in `pledgestack-renderer-react` now resolves `pledgestack-core`'s compiled `.node` addon via real module resolution instead of a relative path that pointed at a nonexistent location — it will actually engage once `packages/core/native/build.sh` is run.
  - `pledgestack-adapters`'s Cloudflare Workers adapter now calls `edge-security.ts`'s rate-limit/bot-detection/geo-restriction/CSP functions with their real signatures (it previously didn't even compile against them).
  - `pledgestack-adapters`'s Lambda adapter now handles both API Gateway payload format 2.0 (what the generated SAM template's `HttpApi` actually sends) and format 1.0, instead of only reading v1 fields from a v2 payload.
  - `create-pledge-app` no longer copies React-only content templates (blog/api/saas/portfolio/dashboard/ecommerce) into non-React scaffolds — it falls back to the framework's `default` template with a clear message.
  - CSRF protection (`pledgestack-auth`) no longer treats a request that omits `Sec-Fetch-Site` as same-site by default, which previously let a forged cross-origin request skip Origin validation just by not sending that header.
  - `PledgeConfig` gained real, typed `cdn`, `geoRestriction`, `cors`, and `csp` fields — these were previously read via unsafe `as unknown as Record<string, unknown>` casts (and, for `cdn`, called with the wrong argument count entirely).
  - `pledge docker --optimized` now generates the Rust-addon-aware multi-stage Dockerfile that already existed in `pledgestack-core` but was never wired into the CLI.
  - Consolidated four copies of the same HTML/XML-escaping helper (og, seo, sitemap, rss, and all four renderer adapters) into one implementation in `pledgestack-shared`.

- Fix the `pledge` scaffold template being unusable: its generated
  `pledge.config.ts` sets `framework: 'pledge'` (the full-stack React + Rust
  backend mode that PledgePack's adapter-pledgestack keys off to scan
  `server/api/*.rs`), but `validateConfig` rejected the value, `initRenderer`
  crashed on `registry.setDefault('pledge')`, and the RSC path was gated on
  `=== 'react'`. `'pledge'` is now a valid config framework and resolves the
  React renderer adapter; `pledge storybook` treats it as React too.
  
  Fix `pledge create` doing nothing: it spawned `create-pledge-app`'s library
  entry (`dist/index.js`, which only exports `createApp` — never calls it)
  instead of its bin entry, so it exited 0 without scaffolding. It now runs
  `bin/create-pledge-app.js`, `create-pledge-app` is a real dependency of the
  `pledgestack` package so the command works outside the monorepo, and
  `--install`/`--no-install` are forwarded (`--no-install` previously crashed
  with ERR_PARSE_ARGS_UNKNOWN_OPTION).
  
  Fix dev servers serving stale SSR output after file edits: `startNodeServer`
  now watches the project root in dev and calls the request handler's
  `invalidate()` (previously unreachable dead code), so page/layout/API edits
  are picked up on the next request instead of requiring a restart.
  
  Add missing React `key` props to list renders in the `default`, `pledge`,
  `dashboard`, and `ecommerce` templates (they logged "unique key prop"
  warnings in dev).

- Fix `pledge search` never returning results: the index was in-memory only, so a
  separate `pledge search <query>` process always saw an empty index. The command
  now persists documents to `.pledge/search-index.json` after indexing and
  hydrates the index before querying.
  
  Fix `pledge sync-aliases` clobbering `compilerOptions.paths`: generated aliases
  are now merged into existing mappings instead of replacing them (previously it
  erased unrelated workspace aliases such as `pledgestack-*` in a monorepo
  tsconfig).
  
  Fix `pledge deploy` failing with "'pledge' is not recognized" when the CLI bin
  isn't on PATH (e.g. invoked via `node dist/bin.js`): the build step now
  re-invokes the running CLI through `process.execPath` + `process.argv[1]`.
  
  Fix stale version reporting: `pledge info` reads the installed `pledgestack`
  package version (same as `--version`) instead of a hardcoded constant that had
  drifted to `0.1.10`; `PLEDGE_VERSION` is updated to match the release and
  `pnpm check:release` now fails if it drifts again; scaffolded health routes
  return `PLEDGE_VERSION` instead of a hardcoded `0.1.11`.
  
  Fix `pledge doctor` false positives on a healthy scaffold: the `pledgestack`
  meta package now satisfies the core-dependency check, `not-found.tsx` grouped
  with a page/layout is detected via scanned file conventions (not only
  standalone `isNotFound` routes), and `.pledge/` must contain real build
  artifacts to count as a build.
  
  Wire up `pledge env-check`: the command existed but was unreachable. It now
  validates `config.envSchema` (the same check `build`/`start`/`dev` run) so it
  can be used standalone in CI or before boot.
  
  Fix `pledge why` printing `../../../../…` module paths: specifiers that escape
  the project root are anchored to the absolute path they point to.
  
  Fix `pledge generate-route-types` emitting a duplicate `| '/'` in the
  `RoutePattern` union when `/` is already a route.
  
  Fix `pledge init` printing "scripts and dependencies added" when no
  package.json exists — it now reports the skip honestly.
  
  Fix `pledge list` reporting "No Rust crates installed" on the `pledge`
  template, which keeps its manifest at `server/Cargo.toml` with a plain
  `[dependencies]` section.
  
  Improve UX: `check-routes`/`generate-route-types` print a friendly error when
  `app/` is missing instead of a raw ENOENT; `pledge bench` without `--psx`
  prints its hint without a misleading benchmark header; `pledge docs` scans the
  app directory and explains itself when zero declarations are found.
  
  Make scaffolded apps track the release channel: `create-pledge-app` resolves
  the dist-tag matching its own version (`rc` for prereleases) before falling
  back to `latest`, so rc scaffolders install rc framework packages.
  
  Add `PLEDGEPACK_BINARY` env var to `resolveBinary()`: point it at a
  locally-built or newer pledgepack binary when the published binary has a
  platform-specific bug (e.g. the `0.3.3` Windows `__pledge_router` resolution
  failure, fixed upstream in `0.4.0`).

- Scaffolding helpers (`parseArgs`, `scaffold`, `generatePackageJson`, `generateTsConfig`) are exported and covered by tests.
