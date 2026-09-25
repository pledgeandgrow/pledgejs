# AGENTS.md

Guidance for agentic coding tools working in this repo.

## Repo layout

`pledgestack` is a pnpm monorepo for a React full-stack framework (file-based
routing, SSR/SSG/ISR, RSC, API routes, server actions, plus a `.psx` native-Rust
extension surface).

- `packages/cli` — the published `pledgestack` package (the `pledge` binary).
  Everything it needs is bundled into it via esbuild, so it works on its own.
- `packages/*` — the library packages (server, core, client, shared, bundlers,
  renderers, integrations, eslint plugin, `create-pledge-app`). 30 packages are
  public and released together at one version; only the two VS Code extensions
  (`vscode-extension`, `vscode-psx`) are `private: true`. Each library's `build`
  is `tsc --build` (declarations only) + `scripts/bundle-package.mjs` (esbuild ESM).
- `packages/create-pledge-app/templates/` — the 11 scaffolded app templates
  (8 base + vue/solid/svelte starters); there is currently no top-level
  `apps/` directory (the `apps/*` pnpm-workspace glob exists for when one is
  added).
- `scripts/` — repo tooling (e.g. `typecheck-workspace.mjs`).
- `types/optional-deps.d.ts` — ambient module declarations for optional runtime
  integrations (see "Optional dependencies" below).

## Verified commands

Run from the repo root. Requires Node >= 20 and pnpm 11.13.1 (Corepack:
`corepack enable && corepack prepare pnpm@11.13.1 --activate`).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the workspace. |
| `pnpm typecheck` | Typecheck all packages (via `scripts/typecheck-workspace.mjs`). Requires `pnpm build:packages` first — composite project references resolve cross-package imports to `dist/*.d.ts` (TS6305 on a clean checkout). Should report "No type errors". |
| `pnpm test` | Run the Vitest suite via the CLI (`node packages/cli/dist/bin.js test`). Requires the CLI built first. |
| `pnpm lint` | Build the local ESLint plugin, then run ESLint on the repo. |
| `pnpm lint:psx` | Run the `.psx`/`.ps` (Rust) linter via the CLI. |
| `pnpm build:packages` | Build `packages/cli` (bundles internal packages). |
| `pnpm build` | Run `pledge build` for the app in the cwd. |

To build + test from scratch:

```bash
pnpm install
pnpm build:packages   # produces packages/cli/dist/bin.js
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test`/`pnpm lint:psx`/`pnpm build` shell out to `packages/cli/dist/bin.js`,
so they need `pnpm build:packages` (or a prior `pnpm install` that built it via a
prepare step) to have run first.

## Linting

ESLint uses `eslint.config.mjs` (flat config). It registers the local plugin
`pledgestack-eslint-plugin` from `packages/eslint-plugin-pledge/dist`, so
`pnpm lint` builds that package first (incremental `tsc --build`).

The plugin enforces framework conventions (default export in `page.tsx`/
`layout.tsx`, no `use client` in server files, no `eval`/secret leaks in client
components, SSRF hints). Warnings do not fail CI; errors do. If you hit a
legitimate rule violation (e.g. a deliberate `\x00` sentinel regex), add a
targeted `// eslint-disable-next-line <rule> -- reason` comment rather than
weakening the config.

## Versioning & releasing

Versioning uses [Changesets](https://github.com/changesets/changesets)
(`@changesets/cli` is a root devDep, config in `.changeset/config.json`).

**Policy:** 29 of the 30 public packages share one version (a Changesets `fixed`
group in `.changeset/config.json`) — never hand-bump versions, never add a public
package to `ignore`, and add any new public package to the `fixed` group.
`create-pledge-app` is the exception: it versions independently on its own
npm line (currently `0.1.x`) since scaffolds release on their own cadence —
it must stay out of the `fixed` group and is exempted in
`scripts/check-release.mjs` (`INDEPENDENT`).
The repo is in normal (non-prerelease) mode: versions are `0.x.y`, published
under the `latest` dist-tag. `pnpm check:release`
(`scripts/check-release.mjs`) enforces metadata, versions, READMEs/CHANGELOGs,
declared workspace dependencies and (with `--dist`) that built entry points exist.

Release flow:

1. Add a changeset describing your change: `pnpm changeset`.
2. Push to `main`: `.github/workflows/release.yml` runs the full gate and the
   Changesets action opens a "Version Packages" PR (`pnpm version-packages`).
3. Merging that PR publishes to npm (`pnpm release`). Agents must not run
   `npm publish` / `changeset publish` locally.

## Optional runtime dependencies

`packages/core` has JS fallbacks for the PSX integrations (SQL via `pg`/`mysql2`,
cache via `redis`/`ioredis`, hashing via `argon2`/`bcryptjs`, JWT via
`jsonwebtoken`, image via `sharp`, PDF via `puppeteer`, email via `nodemailer`,
Excel via `xlsx`).

**These packages are intentionally NOT declared** as dependencies/peer deps in
`packages/core/package.json` — declaring them (even as `peerDependenciesMeta
optional`) causes pnpm to auto-install heavy natives (Puppeteer downloads a
~150MB browser, argon2/sharp compile native code). Instead:

- They are dynamically `import()`ed only when the feature is used.
- `types/optional-deps.d.ts` provides ambient `declare module` declarations so
  `pnpm typecheck` passes without them installed.
- `importOptional()` in `packages/core/src/psx/integrations-fallback.ts` throws a
  clear `npm install <pkg>` hint when a package is missing. Preserve the fallback
  chains (e.g. argon2 → bcryptjs → PBKDF2) — don't replace a graceful chain with
  a hard throw.

## PledgePack integration

`pledgestack-bundler-pledgepack` adapts the external Rust `pledgepack` bundler.
Contract: `pledgepack/docs/CONNECTION.md` (in the sibling pledgepack repo).

- The dev-server transform fetch uses the configured host
  (`config.pledgepack.devServer.host`), not hardcoded `localhost` — this is what
  makes `--host 0.0.0.0` / LAN dev work.
- PSX→TSX transformation lives in `packages/server/src/transform.ts`
  (`transformFile`); the pledgepack adapter delegates to it rather than
  duplicating the logic.
- The transform result cache is a bounded `BoundedLRUMap` (from
  `pledgestack-shared`) to avoid unbounded growth in dev.
- Keep the `pledgepack` dependency at `^0.4.2` across `package.json`,
  `packages/cli`, `packages/server`, and `packages/bundler-pledgepack` —
  ranges drifted before and caused mismatches. Bump all four
  package.jsons (plus the `minimumReleaseAgeExclude` pin in
  `pnpm-workspace.yaml`) together whenever the pinned version changes.
- `PLEDGEPACK_BINARY` env var overrides binary resolution (validated as an
  existing file in `packages/bundler-pledgepack/src/binary-resolver.ts`) —
  needed on Windows to test a locally-built pledgepack binary — published
  builds through 0.3.3 mishandled verbatim `\\?\` paths and failed `pledge build`
  with `Cannot resolve module: ./__pledge_router`.
- `pledge start` prefers the Rust `pledge serve` static server, but falls back
  to the Node.js server automatically when the app has API routes (`route.ts`)
  — the Rust server cannot execute route handlers.

## Docker

`Dockerfile` is a multi-stage build: it enables Corepack, copies the workspace
manifests, builds the packages/CLI, installs production deps, and runs the CLI
directly (`node packages/cli/dist/bin.js start`). `.dockerignore` keeps
`node_modules`, `.git`, caches, and build output out of the build context.
`Dockerfile.test` mirrors it for the test image.
