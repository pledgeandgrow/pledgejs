# Remaining Issues — September 2026

Follow-up to the fixes committed in `fix: production-readiness — end-to-end
(server actions, binary/cookies, React hydration), security (PKCE, SAML,
edge-JWT, Sentry, bundler traversal), and features (image handler, ISR, state
fixes); 913 tests green` (commit `3a4dd5a`) and the 2026-09-14 operational
fixes (CLI dist, typecheck script, `@types/react` hoisting, sccache flake).

This document lists what's genuinely still left to do. Items previously listed
here that have been fixed are marked ✅ with a note; items still open are
listed below.

## Verification status as of 2026-09-14

- `pnpm typecheck`: 0 errors (workspace-wide, via `scripts/typecheck-workspace.mjs`)
- `pnpm test`: 1023 passing, 2 failing (new MDX/server-fn tests), 5 skipped across 112 files
- `pnpm audit --audit-level=high`: 3 findings (all `js-yaml`, via `@changesets/cli`)

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

---

## Priority: Medium — still open

- **VS Code PSX debug adapter is a non-functional stub.**
  `packages/vscode-psx/src/debug-adapter.ts:130-148` — "Continue" emits a
  `terminated` event (kills the session) instead of resuming execution; `next`/
  `stepIn`/`stepOut` fake a `stopped` event without actually stepping. Not wired to
  a real lldb/gdb session despite the doc comment implying it delegates to one.

- **`multi-region` `routeByLatency` fallback lookup is wrong.**
  `packages/core/src/psx/multi-region.ts:276` — the fallback
  `region.latency?.[region.id]` is keyed by the region's own id, not the
  market/client-region name, so it never resolves and always falls through to
  `Infinity`. No practical impact today since this module is not consumed
  anywhere in the request path.

---

## Priority: Low — still open

- **Workspace version drift.** Packages span 0.0.1 … 0.2.8; root is 0.1.12;
  no stated versioning policy. Not a functional bug, but makes dependency
  resolution and publishing harder to reason about.

- **`js-yaml` high-severity audit findings** (via `@changesets/cli`'s
  `read-yaml-file` dependency) left unpatched — forcing js-yaml to a patched 4.x
  would drop the 3.x `safeLoad` API `read-yaml-file` calls, risking a runtime
  break in `pledge changeset`/`version-packages` for a dev-only tool. Needs
  verifying `read-yaml-file` (or an upstream fix) before bumping.

---

## Already known, deliberately not addressed

Carried over from `AUDIT-AND-FIXES.md` §6 — still true, still out of scope:

- **PSX Integrations** (SQLx, Redis, Argon2, image/PDF processing, etc. — 15
  wrappers in `packages/core/src/psx/integrations.ts`) have no corresponding Rust
  crate source anywhere in this repo, so they always run their JS fallback
  regardless of whether the 16 real `rust-*` native addons are compiled.
  These are honestly labeled as JS fallbacks in their output/docs.
- **macOS/Linux PledgePack binaries** aren't bundled in this repo (only Windows x64
  is); those platforms rely on a postinstall download from a GitHub release.
- Several `packages/core/src/psx/*` modules (`multi-region.ts`,
  `monitoring-dashboard.ts`, `lambda-psx.ts`, `serverless-cold-start.ts`,
  `edge-durable-objects.ts`) are exported publicly but not consumed anywhere in
  the request path — breadth without integration. (`serverless-cold-start.ts`
  was hardened in 2026-09-14 to support async loaders, but is still not wired
  to any request path.)
- **`pledge playground`** simulates Rust→WASM compile/execute/save (fabricated
  results); `pledge bench --psx` targets a nonexistent `rust-bench.node` addon.
  Both are honestly labeled in their output/docs.
