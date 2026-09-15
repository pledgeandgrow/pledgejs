# AGENTS.md

Guidance for agentic coding tools working in this repo.

## Repo layout

`pledgestack` is a pnpm monorepo for a React full-stack framework (file-based
routing, SSR/SSG/ISR, RSC, API routes, server actions, plus a `.psx` native-Rust
extension surface).

- `packages/cli` — the published `pledgestack` package (the `pledge` binary).
  Everything is bundled into this via esbuild.
- `packages/*` — internal packages (server, core, client, shared, bundlers,
  renderers, integrations). All `private: true`; never published on their own.
- `apps/` — example/test apps.
- `scripts/` — repo tooling (e.g. `typecheck-workspace.mjs`).
- `types/optional-deps.d.ts` — ambient module declarations for optional runtime
  integrations (see "Optional dependencies" below).

## Verified commands

Run from the repo root. Requires Node >= 20 and pnpm 11.13.1 (Corepack:
`corepack enable && corepack prepare pnpm@11.13.1 --activate`).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the workspace. |
| `pnpm typecheck` | Typecheck all packages (via `scripts/typecheck-workspace.mjs`). Should report "No type errors". |
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

**Policy:** only the `pledgestack` CLI package is published to npm. Every other
package is `private: true` and listed in the changesets `ignore` array — their
individual version numbers are not meaningful because they are never published
and are consumed through `workspace:*` ranges (always the local version). Do not
hand-bump internal package versions; the CLI version is the only one that
matters.

Release flow:

1. Add a changeset describing your change: `pnpm changeset`
   (select `pledgestack`; the internal packages are ignored).
2. Bump the version + changelog: `pnpm version-packages`
   (runs `changeset version`).
3. Build + publish: `pnpm release` (`changeset publish`), or push a `v*.*.*`
   tag and let `.github/workflows/release.yml` publish.

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
- Keep the `pledgepack` dependency at `^0.3.2` across `package.json`,
  `packages/cli`, and `packages/server` — ranges drifted before and caused
  mismatches.

## Docker

`Dockerfile` is a multi-stage build: it enables Corepack, copies the workspace
manifests, builds the packages/CLI, installs production deps, and runs the CLI
directly (`node packages/cli/dist/bin.js start`). `.dockerignore` keeps
`node_modules`, `.git`, caches, and build output out of the build context.
`Dockerfile.test` mirrors it for the test image.
