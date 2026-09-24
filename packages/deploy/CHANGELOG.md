# pledgestack-deploy

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

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
