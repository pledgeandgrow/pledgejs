# Remaining Issues — September 2026

Follow-up to the fixes committed in `fix: production-readiness — end-to-end
(server actions, binary/cookies, React hydration), security (PKCE, SAML,
edge-JWT, Sentry, bundler traversal), and features (image handler, ISR, state
fixes); 913 tests green` (commit `3a4dd5a`) and the 2026-09-14 operational
fixes (CLI dist, typecheck script, `@types/react` hoisting, sccache flake).

This document lists what's genuinely still left to do. Items previously listed
here that have been fixed are marked ✅ with a note; items still open are
listed below.

## Verification status as of 2026-09-20

The authoritative, always-current status is [AUDIT-STATUS.md](../AUDIT-STATUS.md);
this file only tracks the follow-up backlog.

- `pnpm typecheck`: 0 errors (workspace-wide, via `scripts/typecheck-workspace.mjs`)
- `pnpm lint`: 0 errors (75 pre-existing warnings)
- `pnpm build:packages`: passes (34 public packages)
- `pnpm test`: 1691 passing, 0 failing, 6 skipped across 206 files
  (the 5 skips are Netlify real-CLI deploy tests gated on `NETLIFY_AUTH_TOKEN`)
- `pnpm audit`: no known vulnerabilities (vitest upgraded to 4.1.11)

---

## ✅ Previously listed — now FIXED

| Bug | File | Status |
|---|---|---|
| `setValue` corrupts state with non-identity selector | `packages/state/src/store.ts` | ✅ Fixed — `applySelectorUpdate` uses `detectSelectorKey` to write back through the selector path. Tests cover non-identity selectors. |
| JSON-LD XSS (`</script>` injection) | `packages/seo/src/jsonld.ts` | ✅ Fixed — `generateJsonLd` escapes `<`, `>`, `&` in the JSON output. |
| `api` template non-functional (routes don't share state) | `packages/create-pledge-app/templates/api/` | ✅ Fixed — both routes import a shared `store.ts`. |
| `sitemap` plugin doesn't generate `sitemap.xml` | `packages/sitemap/src/index.ts` | ✅ Fixed — `buildEnd` hook writes `sitemap.xml` to the output dir. |
| `heading-order` a11y rule never fires | `packages/a11y/src/audit.ts` | ✅ Fixed — the check walks the document's heading list and compares levels. |
| `nosql-injection` sensitive-operators branch is inert | `packages/api/src/nosql-injection.ts` | ✅ Fixed — see `nosql-injection-fix.test.ts`. |
| `font` fallback-metrics dead code | `packages/font/src/index.ts` | ✅ Fixed — see `tier3-fixes.test.ts`. |
| `serverless-cold-start` sync loaders / misreported cached metric | `packages/core/src/psx/serverless-cold-start.ts` | ✅ Fixed (2026-09-14) — `loadModule`/`get`/`preWarm`/`preWarmAll` are now async; `cachedModules` Set for accurate reporting. |
| Sccache test flake (timeout) | `packages/core/src/psx/sccache.test.ts` | ✅ Fixed (2026-09-14) — timeout increased to 30000ms. |
| CLI dist overwritten by typecheck | `scripts/typecheck-workspace.mjs` | ✅ Fixed (2026-09-14) — switched from `tsc -b` (emits) to `tsc --noEmit -p` (typechecks only). |
| `@types/react` hoisting gap | `package.json` | ✅ Fixed (2026-09-14) — added `@types/react`/`@types/react-dom` to root devDependencies. |
| Workspace version drift (0.0.1 … 0.2.3, no policy) | all `packages/*/package.json` | ✅ Fixed (2026-09-20) — every public package is `1.0.0-rc.0` in one Changesets `fixed` group; `pnpm check:release` enforces it. |
| Only the CLI was publishable / release workflow had no gate | `.github/workflows/release.yml` | ✅ Fixed (2026-09-20) — 34 packages are public; the workflow runs typecheck, lint, build, tests and the release check, then publishes through Changesets. |
| `pledge init --skip-install` was a no-op | `packages/cli/src/commands/init.ts` | ✅ Fixed (2026-09-20) — init installs unless `--skip-install`; tested. |
| `pledge upgrade` codemod path was dead | `packages/cli/src/commands/upgrade.ts` | ✅ Removed (2026-09-20) — codemods stay available via `pledge codemod`. |
| WebAuthn UV not enforced / empty stored userId; api rate-limit buckets unbounded; nosql sanitizer let `__proto__` through; Prometheus labels unquoted | auth, api, server | ✅ Fixed and tested. |
| OG `ImageResponse` never became a PNG | `packages/server/src/og-response.ts` | ✅ Fixed (2026-09-20) — renders via native addon or `sharp`, else `501`. |
| VS Code PSX debug adapter was a non-functional stub | `packages/vscode-psx/src/debug-adapter.ts` | ✅ Fixed — rewritten as a real CDP-based adapter (~930 lines): connects to a debug target over WebSocket/CDP, and `continue`/`next`/`stepIn`/`stepOut` send real `Debugger.*` CDP commands instead of faking `stopped`/`terminated` events. |
| `multi-region` `routeByLatency` fallback lookup wrong | `packages/core/src/psx/multi-region.ts` | ✅ Fixed — the fallback now looks up `region.latency[clientRegion]` (the client's market), not `region.latency[region.id]` (the region's own id, which never resolved). Still unwired to any request path. |

---

## Priority: Medium — still open

_(None currently — both items previously listed here were fixed.)_

---

## Priority: Low — still open

- **Bundler HMR** is only as real as the bundler's own dev server; see
  [limitations.md](./limitations.md#bundler-hmr-hot-module-replacement).
- **Renderer asset URLs** are not content-hashed (`/__pledge__/client.js`).
- **75 lint warnings** (unused variables, `prefer-const`, SSRF-suggestion rule).
- **Native addons** are not compiled in CI artifacts or shipped to npm.

---

## Already known, deliberately not addressed

Carried over from `AUDIT-AND-FIXES.md` §6 — still true, still out of scope:

- **PSX Integrations** (SQLx, Redis, Argon2, image/PDF processing, etc. — 15
  wrappers in `packages/core/src/psx/integrations.ts`) have no corresponding Rust
  crate source anywhere in this repo, so they always run their JS fallback
  regardless of whether the 17 real `rust-*` native addons are compiled.
  Sea-ORM and ML inference have no JS fallback and now fail at construction
  unless a `driver` / `executor` is supplied. These are honestly labeled as JS
  fallbacks in their output/docs.
- **macOS/Linux PledgePack binaries** aren't bundled in this repo (only Windows x64
  is); those platforms rely on a postinstall download from a GitHub release.
- Several `packages/core/src/psx/*` modules (`multi-region.ts`,
  `monitoring-dashboard.ts`, `lambda-psx.ts`, `serverless-cold-start.ts`,
  `edge-durable-objects.ts`) are exported publicly but not consumed anywhere in
  the request path — breadth without integration. (`serverless-cold-start.ts`
  was hardened in 2026-09-14 to support async loaders, but is still not wired
  to any request path.)
- **`pledge playground`** uses the real `cargo --target wasm32-unknown-unknown`
  toolchain when available and clearly labels simulated results when it isn't;
  **`pledge bench --psx`** targets the real `rust-bench` crate (source now in
  `packages/core/native/rust-bench/`) and benchmarks real JS fallback code when
  the addon isn't compiled. Both are honestly labeled in their output/docs.
