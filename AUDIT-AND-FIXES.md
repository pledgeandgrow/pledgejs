# Audit & Fixes — August 2026

This document recaps a session of deep auditing and fixing across two repos:
this framework (`pledgejs` / `pledgestack`) and its marketing/docs site
(`pledgejs-site`). Nothing here has been committed — everything is sitting in
the working tree, reviewed and verified, ready to commit.

## 1. Why this happened

A deep-dive analysis of the monorepo (39 packages, ~500 source files) found
that the project's own self-reported health — "90 test files · 805 tests,
all passing" — was accurate, but hid a real gap: **the root `tsc --noEmit`
used by both CI and `pnpm typecheck` was only ever checking two small ambient
declaration files** (`types/*.d.ts`), never the real source under
`packages/*/src`. Fixing that gap surfaced **166 pre-existing type errors**
in one pass, including a genuinely broken adapter that had never compiled.

Everything below was found either by that audit or by the follow-up
type-check sweep, then fixed and verified (typecheck + full test suite,
repeatedly, throughout).

## 2. Real bugs fixed

| Area | What was wrong | Fix |
|---|---|---|
| RSC streaming | `renderRSCStream()` in `renderer-react` generated a real flight payload via `react-server-dom-webpack`, then discarded it and returned plain SSR HTML instead. | Streams flight chunks progressively to the client as inline scripts, with a matching client-side reader. |
| Rust SSR acceleration | `renderer-react/src/rust-accel.ts` looked for the compiled `.node` addon at a relative path that could never resolve — the native code lives in a *different* package (`pledgestack-core`). | Resolves `pledgestack-core`'s real location via `import.meta.resolve` (works around `pledgestack-core`'s ESM-only `exports`), verified end to end with a manual smoke test. |
| Cloudflare adapter | `packages/adapters/src/cloudflare.ts` called `checkEdgeRateLimit`, `detectBot`, `checkGeoRestriction`, `edgeCspHeaders` with the wrong arguments — it had never actually compiled against its own `edge-security.ts`. | Fixed every call site; added a real `CloudflareKvNamespace` type instead of `unknown`. |
| Lambda adapter | The generated SAM template wires an `HttpApi` (payload format **v2**: `rawPath`, `requestContext.http.method`), but the handler only read **v1** fields (`httpMethod`, `path`) — a real, reachable payload-shape mismatch. | Handler now detects and supports both v1 and v2 payloads. |
| `create-pledge-app` | Picking a non-React framework with a non-`default` template (blog, api, saas, portfolio, dashboard, ecommerce — React-only content) silently copied React JSX into a Vue/Solid/Svelte-labeled project. | Interactive prompt now filters template choices by framework; a CLI-flags fallback rejects the bad combination with a clear message. |
| CSRF protection | `isSameSiteRequest()` treated a **missing** `Sec-Fetch-Site` header as same-site (trusted) by default — letting a forged cross-origin request skip Origin validation just by omitting the header. | Missing header is now treated as *not* confirmed same-site, falling through to Origin validation. 5 new tests added (`packages/auth/src/csrf.test.ts`). |
| `PledgeConfig` | `cdn`, `cors`, `csp`, `geoRestriction` were read via unchecked `as unknown as Record<string, unknown>` casts — `cdn` was even called with the wrong argument count, so CDN purge would have crashed the moment it ran. | Added real typed fields to `PledgeConfig` in `pledgestack-shared`; removed every unsafe cast. |
| Root CI typecheck | See §1 — `tsc --noEmit` at the repo root only ever validated 2 ambient `.d.ts` files. | New `scripts/typecheck-workspace.mjs` runs `tsc -b`/`tsc --noEmit` against every real project (composite leaves + standalone packages); wired into `pnpm typecheck` and `.github/workflows/ci.yml`. Verified with a deliberately-injected type error that it actually fails. |

### Bugs found *while* fixing the above (not in the original audit)

- **Vue 3 hydration was calling a function that doesn't exist.** The generated
  client script imported `hydrate` from `'vue'` and called `hydrate(app, root)`
  — Vue 3's public API has no such top-level export. Fixed to use
  `createSSRApp(component).mount(root)`, Vue 3's real hydration path.
- **Svelte client script imported from a nonexistent subpath.** `'svelte/client'`
  isn't a real export of the `svelte` package (verified against the installed
  package's `package.json`); `hydrate`/`mount`/`unmount` are exported from
  `'svelte'` itself. Fixed.
- A dead, unused `Dockerfile` generator existed in `pledgestack-core`
  (a more sophisticated, Rust-addon-aware multi-stage build) alongside the
  simpler one actually wired into `pledge docker`. Rather than delete the
  better implementation, it's now reachable via `pledge docker --optimized`.

## 3. Cleanup

- **Deduplicated HTML/XML escaping.** The same `escapeHtml`/`escapeXml`
  function was copied nearly verbatim into `og`, `seo` (×2), `sitemap`,
  `rss` (×2), and all four renderer adapters. Consolidated into
  `packages/shared/src/escape.ts`.
- **Removed ~36 stale compiled `.d.ts` files accidentally committed to git**
  under `packages/{client,core,server}/src/` — leftover `tsc` output that had
  been checked in and was shadowing real source in some resolution paths.
  (A separate ~176 *untracked* stray build artifacts, from local builds, were
  also cleaned up but were never a repo problem.)

## 4. Documentation updated

**In this repo:**
- `README.md` — corrected the `pledge.config.ts` example (`cors.origins` not
  `origin`, `cdn.token`/`cdn.paths` not `apiToken`, removed the fictional
  `requestTimeout` field, added `geoRestriction`), updated the Known
  Limitations section (Rust addon resolution, PledgePack platform binaries),
  updated the RSC bullet, updated `pledge docker` row, bumped the test count
  to 810.
- `packages/adapters/README.md` — corrected the Cloudflare usage example
  (`createCloudflareAdapter(config)` takes one argument, not two; the real
  option names are `rateLimit`/`botDetection`/`geoRestriction` on
  `PledgeConfig` itself), added a note on Lambda's dual payload-format support.
- `packages/auth/README.md` — corrected the CSRF example (`generateCsrfToken()`
  returns a string, not `{token, cookie}`; `createCsrfMiddleware()` takes
  `allowedOrigins`, not `secret`), documented the `Sec-Fetch-Site` behavior.
- `packages/cli/README.md` — documented `pledge docker --optimized`.
- `.changeset/fix-rsc-cloudflare-lambda-typecheck.md` — a proper changeset
  describing this whole batch for the next release.

**In `pledgejs-site` (the public docs site, `../pledgejs-site`):**
- `src/lib/docs-content.ts` — same `cors.origins`/`cdn.token`+`paths` fixes as
  above, added a `geoRestriction` example, documented `pledge docker --optimized`,
  noted that RSC flight payloads now stream progressively.
- `src/lib/blog-posts.ts` — bumped the "805 tests" claim in the 0.1
  announcement to 810, and added a new post
  ("PledgeJS 0.1.1 — Real Type-Checking, RSC Streaming, and a CSRF Hardening
  Fix") summarizing this release for site visitors.
- Verified with `next build` after the edits — this Next.js 16 site has its
  own generated `LayoutProps` types, so a plain `next build` (not just `tsc`)
  is the real check; confirmed clean and unrelated to these edits.

## 5. Verification

- `pnpm typecheck` (the new, real one): **0 errors** across all 39 packages
  and the 4 standalone tools (create-pledge-app, eslint-plugin-pledge,
  both VS Code extensions). Confirmed it actually catches errors by
  injecting a deliberate type error, watching it fail across every dependent
  package, then removing it.
- `pnpm test` (vitest): **810/810 passing** (805 original + 5 new CSRF tests),
  re-run after every batch of changes — stayed green throughout.
- `pledgejs-site`: `next build` clean.

## 6. What's still open

These were identified but intentionally **not** changed — either out of
scope for a bug-fix pass, or genuinely unowned by this repo:

- **PSX Integrations** (SQLx, Redis, Argon2, image/PDF processing, etc. —
  13 wrappers) have no corresponding Rust crate source anywhere in this repo,
  so they always run their JS fallback regardless of whether the 16 real
  `rust-*` native addons are compiled. Fixing the *resolution path* (this
  session's Rust-acceleration fix) doesn't change that — there's nothing to
  compile yet.
- **macOS/Linux PledgePack binaries** aren't bundled in this repo (only
  Windows x64 is); those platforms rely on a postinstall download from a
  GitHub release.
- Several `packages/core/src/psx/*` modules (multi-region, monitoring
  dashboard, Lambda-PSX, serverless cold-start, edge durable objects) are
  exported publicly but not consumed anywhere in the request path — breadth
  without integration. Left as-is; flagging for awareness, not removed.
