# PledgeStack — Audit Status (0.2.0)

Single source of truth for what is **fixed** and what is **open**. Every item is
in exactly one of the two sections below; the historical audit lists that used
to contradict each other ("still open" items that were already fixed) have been
folded in. Last verified: **2026-09-21**.

## Verified numbers (fresh runs on 2026-09-21)

| Check | Result |
|---|---|
| `pnpm typecheck` | 0 errors across all projects |
| `pnpm lint` | 0 errors (76 pre-existing warnings) |
| `pnpm build:packages` | passes (34 public packages + CLI) |
| `pnpm test` | **206 files, 1698 tests: 1692 passing, 6 skipped, 0 failing** |
| `pnpm test:coverage` | 29.2% statements / 27.7% branches / 30.9% functions / 29.9% lines; thresholds in `vitest.config.ts` (28 / 26 / 29 / 29) enforced |
| `pnpm check:release` | passes — 34 public packages at `0.2.0`, metadata, READMEs, changelogs, dist entry points |
| `pnpm audit` | no known vulnerabilities (vitest upgraded to 4.1.11) |

The 5 skipped tests are the Netlify real-CLI deploy tests, gated on
`NETLIFY_AUTH_TOKEN`.

Legend: 🔴 blocks a working app · 🟠 security · 🟡 feature · ⚪ stub/unwired · 📄 docs

---

## ✅ Fixed (verified in source and covered by tests)

### End-to-end blockers (2026-08-25)
- 🔴 Server actions (deterministic ids), binary responses, React hydration
  (real page + layout tree), pledge islands, multiple `Set-Cookie`, request
  bodies, static-export filenames, the `api` starter template.

### Security
- 🟠 Auth: scrypt hashing, PKCE (AES-GCM-protected verifier), SAML fail-closed
  with digest binding and issuer check, JWT ES256/JWKS and `typ` enforcement,
  TOTP replay guard, account lockout, session regeneration, open-redirect
  validation, CSRF fail-closed.
- 🟠 **WebAuthn** enforces the UV flag when `userVerification: 'required'` and
  stores the real user id (`options.userId`) — `webauthn.test.ts`.
- 🟠 Edge adapters: geo fail-closed, JWKS caching/`response.ok`/`aud`/`nbf`,
  bounded rate buckets, timeouts that cancel.
- 🟠 **API rate limiter** buckets pruned and hard-capped —
  `packages/api/src/rc-hardening.test.ts`.
- 🟠 **NoSQL sanitizers** drop `__proto__` / `constructor` / `prototype` —
  same test file.
- 🟠 Sentry envelope format, bundler dev-server path traversal (all esbuild
  fallback servers; covered by the new bundler adapter tests), JSON-LD escaping,
  RSS element-name validation.
- 🟠 **Prometheus** label values quoted/escaped, names sanitized —
  `packages/server/src/metrics.test.ts`.

### Features
- 🟡 Image handler (real `sharp` resize), ISR stale-while-revalidate, PPR shell
  lookup, client router re-hydration and params, state package fixes, a11y
  heading-order, sitemap `buildEnd`, font axis URLs, privacy consent HMAC and
  encryption salt.
- 🟡 **Open Graph images**: `ImageResponse` renders to a real PNG (flexbox subset
  -> SVG -> native addon or `sharp`), otherwise a clear `501` —
  `packages/server/src/og-response.test.ts`.
- 🟡 **`pledge init --skip-install`** works and init installs otherwise —
  `packages/cli/src/commands/init.test.ts`.
- 🟡 **`pledge upgrade`** has no dead codemod stage; prerelease-aware version
  compare — `upgrade.test.ts`.
- 🟡 **Vue renderer** hydrates with real route params —
  `packages/renderer-vue/src/index.test.ts`.
- 🟡 eslint-plugin Windows paths / exact `page|layout` names, a11y
  `extractTranslations` duplicates, image `sizes`/`srcset`/CSS-url, overlay
  `0ms` and devtools script injection.
- 🟡 VS Code PSX debug adapter (real CDP/WebSocket), `pledge playground`
  (real `cargo --target wasm32` when available), `pledge bench --psx`
  (real `rust-bench` crate / real JS fallbacks), `multi-region` latency lookup,
  SBOM generation in `pledge build`.

### Release engineering (this pass)
- 34 public packages with full npm metadata, one shared version, per-package
  README / LICENSE / CHANGELOG; Changesets `fixed` group + prerelease (`rc`) mode;
  release workflow publishes through Changesets after the full gate; ESM bundles
  that load in Node; type declarations for the CLI package; vitest 4.1.11.
- Tests added for every package that had none (renderers, bundlers,
  create-pledge-app, eslint plugin, a11y, image, og, overlay) and for each fix.
- Sea-ORM and ML inference wrappers fail at construction with an actionable
  error unless a `driver` / `executor` is supplied (or work through it).

### CLI correctness pass (2026-09-21)
- 🟠 **`pledge search`** persists documents to `.pledge/search-index.json` and
  hydrates before querying — indexing and querying previously ran in separate
  processes over an in-memory index, so queries could never return results.
- 🟠 **`pledge sync-aliases`** merges generated aliases into existing
  `compilerOptions.paths` instead of replacing them (it erased workspace
  `pledgestack-*` mappings at the monorepo root).
- 🟠 **`pledge deploy`** re-invokes the running CLI (`process.execPath` +
  `process.argv[1]`) for the build step — no longer requires `pledge` on PATH.
- 🟠 **`PLEDGEPACK_BINARY`** env var overrides native binary resolution —
  workaround for the `pledgepack@0.3.3` Windows `__pledge_router`
  resolution bug (fixed upstream in `0.4.0`, now published on npm).
- 🟡 Stale versions: `pledge info` reads the installed package version;
  `PLEDGE_VERSION` is `0.2.0` and enforced by `check:release`; scaffolded
  health routes return `PLEDGE_VERSION`.
- 🟡 `doctor` false positives: `pledgestack` meta package satisfies the core
  dependency check; `not-found.tsx` grouped with a page/layout is detected;
  `.pledge/` must contain build artifacts to count as a build.
- 🟡 `env-check` wired into the CLI (was dead code); validates
  `config.envSchema` like `build`/`start`/`dev`.
- 🟡 `create-pledge-app` resolves the dist-tag matching its own channel
  (`latest` for stable releases) before falling back to `latest`.
- 🟡 `why` anchors root-escaping specifiers to absolute paths; route types no
  longer emit a duplicate `| '/'`; `init` reports honestly when no
  package.json exists; `check-routes`/`generate-route-types` give friendly
  errors without `app/`; `bench` hints without a misleading header; `docs`
  scans `app/` and explains zero results; `list` reads `server/Cargo.toml`.

### Docs
- 📄 README/architecture/capabilities counts, roadmap status, changelog,
  limitations and this file were reconciled on 2026-09-20.

---

## ⏳ Open (known, documented, not blocking an RC)

Details and workarounds are in [docs/limitations.md](./docs/limitations.md).

| Area | What is open |
|---|---|
| ⚪ PSX integrations | 13 of the 15 wrappers (SQLx, Redis, Auth, Image, PDF, Jobs, Cron, Email, HTTP, WebSocket, Files, Observability, Crypto) have no compiled Rust crate: they run JS fallbacks (which need optional packages you install) or throw a clear error for the few calls without one |
| ⚪ Native addons | The 17 crates in `packages/core/native/` are not compiled or shipped in the npm packages; all paths fall back to JavaScript |
| ⚪ Orphaned PSX modules | `multi-region`, `monitoring-dashboard`, `lambda-psx`, `serverless-cold-start`, `edge-durable-objects`, `worker-pool`, `rollback`, `canary`, `dead-code`, `cross-compile`, `sccache`, `jit-templates` are exported and unit-tested but not wired to any command or request path (left exported: removing them would be a breaking API change) |
| ⚪ jit-templates (native) | `native/rust-jit-templates/src/lib.rs` profiling logic only compares the previous render's hash (first render can look like a repeat); the crate is not built by default |
| 🟡 Bundler HMR | Only real where the bundler's own dev server provides it (Vite, webpack-dev-server, Rsbuild, PledgePack binary). Rollup, Turbopack-without-`@utoo/pack` and the esbuild fallbacks have no live reload; `reload()`/`reloadAll()` are optional and not called by `pledge dev` |
| 🟡 Bundler entry collection | `collectRouteFiles` compiles every `.ts` under `app/` as an entry in all adapters |
| 🟡 OG images | Flexbox subset only; custom font bytes are not embedded; approximate text wrapping; requires `sharp` or the native addon |
| 🟡 Asset fingerprinting | Bundlers can hash filenames, but renderers still emit the literal `/__pledge__/client.js` / `client.css` URLs |
| 🟡 Scaffolding | Vue, Solid and Svelte only have the `default` template; the React-only content templates fall back to it with a warning (`pledge create` delegates to `create-pledge-app`, so both behave identically) |
| 🟡 Stable hydration IDs | Still import-order counters (`packages/client/src/pledge.ts`) |
| 🟡 Build manifests | `__pledge_ps_manifest.json` comes from PledgePack only, not from the other adapters |
| 🟠 SAML | XML canonicalization (C14N) is not implemented — use a dedicated SAML library for production SSO |
| 🟠 Sessions | Stateless HMAC cookies: "regeneration" rotates the cookie but cannot revoke a retained old one |
| 🟠 OAuth | `email_verified` is surfaced, not enforced — the app must check it |
| 🟠 Supply chain | SBOMs are generated; release provenance/signing is only configured through npm provenance in the release workflow (not yet exercised) |
| 🟡 Platforms | The PledgePack native binary is downloaded by the `pledgepack` package postinstall (GitHub Releases); the pnpm build script must be allowed (`allowBuilds`) |
| �� PledgePack on Windows | `pledgepack@0.3.3` failed `pledge build` on Windows (`Cannot resolve module: ./__pledge_router` — verbatim-path `/.` handling); fixed upstream and published in `pledgepack@0.4.0` (verified: fresh Windows build, 24 modules, no overrides). `PLEDGEPACK_BINARY=<path>` remains available for testing a locally-built binary |
| 🟡 Published `pledgestack@0.1.12` | The stable npm package ships no `.d.ts` for its root export, so `pledge typecheck` fails on a freshly scaffolded app (`TS7016`). Fixed in the `0.2.0` package; resolves on publish |
| �📄 Lint | 75 pre-existing `pnpm lint` warnings (unused vars, `prefer-const`, `no-unsafe-fetch` suggestions) |

---

## Bottom line

The framework serves a working app end to end, the security primitives are
fixed and tested, the whole workspace builds, typechecks, lints and tests
green, and the 34 public packages are set up to publish as `0.2.0` through
Changesets. What remains is the stub layer (Rust integrations without crates,
optional native addons), HMR only where bundlers provide it, and the documented
feature gaps above.
