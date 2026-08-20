# Session Log

A running log of work done on this repo, one entry per work session, **newest
first**. Each entry follows the same shape: why the session happened, what was
fixed/changed, what was verified, and what's still open going into the next
session. See [REMAINING-ISSUES.md](./REMAINING-ISSUES.md) for the live,
un-fixed backlog — this file is the historical record of what was *done*.

---

## 2026-08-19 — Audit & Fixes: RSC streaming, adapters, CSRF, real workspace typecheck

Session across two repos: this framework (`pledgejs` / `pledgestack`) and its
marketing/docs site (`pledgejs-site`, at `../pledgejs-site`).

### Why

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

### Real bugs fixed

| Area | What was wrong | Fix |
|---|---|---|
| RSC streaming | `renderRSCStream()` in `renderer-react` generated a real flight payload via `react-server-dom-webpack`, then discarded it and returned plain SSR HTML instead. | Streams flight chunks progressively to the client as inline scripts, with a matching client-side reader. |
| Rust SSR acceleration | `renderer-react/src/rust-accel.ts` looked for the compiled `.node` addon at a relative path that could never resolve — the native code lives in a *different* package (`pledgestack-core`). | Resolves `pledgestack-core`'s real location via `import.meta.resolve` (works around `pledgestack-core`'s ESM-only `exports`), verified end to end with a manual smoke test. |
| Cloudflare adapter | `packages/adapters/src/cloudflare.ts` called `checkEdgeRateLimit`, `detectBot`, `checkGeoRestriction`, `edgeCspHeaders` with the wrong arguments — it had never actually compiled against its own `edge-security.ts`. | Fixed every call site; added a real `CloudflareKvNamespace` type instead of `unknown`. |
| Lambda adapter | The generated SAM template wires an `HttpApi` (payload format **v2**: `rawPath`, `requestContext.http.method`), but the handler only read **v1** fields (`httpMethod`, `path`) — a real, reachable payload-shape mismatch. | Handler now detects and supports both v1 and v2 payloads. |
| `create-pledge-app` | Picking a non-React framework with a non-`default` template (blog, api, saas, portfolio, dashboard, ecommerce — React-only content) silently copied React JSX into a Vue/Solid/Svelte-labeled project. | Interactive prompt now filters template choices by framework; a CLI-flags fallback rejects the bad combination with a clear message. |
| CSRF protection | `isSameSiteRequest()` treated a **missing** `Sec-Fetch-Site` header as same-site (trusted) by default — letting a forged cross-origin request skip Origin validation just by omitting the header. | Missing header is now treated as *not* confirmed same-site, falling through to Origin validation. 5 new tests added (`packages/auth/src/csrf.test.ts`). |
| `PledgeConfig` | `cdn`, `cors`, `csp`, `geoRestriction` were read via unchecked `as unknown as Record<string, unknown>` casts — `cdn` was even called with the wrong argument count, so CDN purge would have crashed the moment it ran. | Added real typed fields to `PledgeConfig` in `pledgestack-shared`; removed every unsafe cast. |
| Root CI typecheck | `tsc --noEmit` at the repo root only ever validated 2 ambient `.d.ts` files (see "Why" above). | New `scripts/typecheck-workspace.mjs` runs `tsc -b`/`tsc --noEmit` against every real project (composite leaves + standalone packages); wired into `pnpm typecheck` and `.github/workflows/ci.yml`. Verified with a deliberately-injected type error that it actually fails. |

Bugs found *while* fixing the above (not in the original audit):

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

### Cleanup

- **Deduplicated HTML/XML escaping.** The same `escapeHtml`/`escapeXml`
  function was copied nearly verbatim into `og`, `seo` (×2), `sitemap`,
  `rss` (×2), and all four renderer adapters. Consolidated into
  `packages/shared/src/escape.ts`.
- **Removed ~36 stale compiled `.d.ts` files accidentally committed to git**
  under `packages/{client,core,server}/src/` — leftover `tsc` output that had
  been checked in and was shadowing real source in some resolution paths.
  (A separate ~176 *untracked* stray build artifacts, from local builds, were
  also cleaned up but were never a repo problem.)
- **Bumped 3 dev-dependency overrides** (`fast-uri`, `brace-expansion`,
  `nanoid`) for high-severity advisories disclosed after the existing
  `pnpm-workspace.yaml` overrides were written. `pnpm audit --audit-level=high`:
  6 → 3. The remaining 2 (`js-yaml`, via `@changesets/cli`) were left alone —
  forcing 4.x would drop the 3.x `safeLoad` API that `read-yaml-file` calls,
  risking a runtime break in `pledge changeset`/`version-packages`.
- **Fixed a broken local dev environment**: after the repo was moved from
  `GitHub\pledgejs` to `GitHub\language\pledgejs`, every pnpm symlink in every
  package's `node_modules` still pointed at the old absolute path (pnpm's
  `--frozen-lockfile` install doesn't re-verify existing symlinks). Full
  `node_modules` wipe + reinstall fixed it — this is an environment fix, not a
  repo change, but cost real time to diagnose.

### Documentation updated

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

### Verification

- `pnpm typecheck` (the new, real one): **0 errors** across all 39 packages
  and the 4 standalone tools (create-pledge-app, eslint-plugin-pledge,
  both VS Code extensions). Confirmed it actually catches errors by
  injecting a deliberate type error, watching it fail across every dependent
  package, then removing it.
- `pnpm test` (vitest): **810/810 passing** (805 original + 5 new CSRF tests),
  re-run after every batch of changes — stayed green throughout, including
  after the environment fix and the dependency-override bump.
- `pnpm audit --audit-level=high`: 6 → 3 findings.
- `pledgejs-site`: `next build` clean.

### Commits

- `fix: RSC streaming, Rust addon resolution, Cloudflare/Lambda adapters, CSRF default, real workspace typecheck` (pledgejs, 106 files)
- `chore: bump dev-dependency overrides for 3 newly-disclosed high-severity advisories` (pledgejs)
- `docs: sync config examples with pledgejs fixes, add 0.1.1 release post` (pledgejs-site)

### Still open going into next session

A follow-up audit pass targeting packages this session didn't touch (state,
seo, a11y, sitemap, api, font, the create-pledge-app templates, vscode-psx)
found new, unfixed bugs — see [REMAINING-ISSUES.md](./REMAINING-ISSUES.md) for
the full, current list. Highlights: a real state-corruption bug in
`pledgestack-state`'s `setValue`, a JSON-LD XSS in `pledgestack-seo`, and a
non-functional `create-pledge-app` `api` template.

Also still open (unowned by this repo / genuinely out of scope):
PSX Integrations (SQLx, Redis, etc.) have no Rust crate source at all, so they
always run their JS fallback; macOS/Linux PledgePack binaries aren't bundled;
several `packages/core/src/psx/*` modules are exported but never consumed in
the request path.
