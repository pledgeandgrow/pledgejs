# Limitations & Known Issues

## PSX Rust Crate Integrations (15 stubs)

The PSX (.psx) file format combines Rust and TypeScript/JSX in a single file.
The PSX toolchain itself (parser, codegen, transform, batch compilation,
HMR, audit, security, etc.) is fully implemented in TypeScript. However,
**all 15 Rust crate integration wrappers are stubs** — they attempt to load
a native `.node` addon that doesn't exist, then fall back to a JavaScript
implementation or throw an error.

| # | Integration | Rust Crate | Fallback Behavior |
|---|------------|------------|-------------------|
| 256 | SQLx | sqlx | JS fallback (pg/mysql2) |
| 257 | Sea-ORM | sea-orm | No built-in fallback: **throws at construction** unless a `driver` is supplied |
| 258 | Redis | redis | JS fallback (in-memory) |
| 259 | Rust Auth | argon2/jsonwebtoken | JS fallback (node:crypto) |
| 260 | Image Processing | image | JS fallback (sharp-less) |
| 261 | PDF Generation | printpdf | Puppeteer fallback |
| 262 | Background Jobs | apalis | In-memory fallback |
| 263 | Cron Scheduler | tokio-cron-scheduler | setInterval fallback |
| 264 | Email Sending | lettre | nodemailer fallback |
| 265 | HTTP Client | reqwest | Native fetch fallback |
| 266 | WebSocket Server | tokio-tungstenite | In-memory fallback |
| 267 | File Processing | calamine/csv | JS fallback |
| 268 | Observability | tracing/opentelemetry | JS fallback |
| 269 | Crypto | aes-gcm/sha2/uuid | JS fallback (node:crypto) |
| 270 | ML Inference | candle-core/ort | No built-in fallback: **throws at construction** unless an `executor` is supplied |

**Impact:** Applications using these integrations work via JS fallbacks but
don't get the Rust performance benefit. Two integrations (Sea-ORM #257 and
ML Inference #270) have no JS fallback of their own. They now fail
**at config time**: `new SeaOrmDatabase({ url })` / `new MlModel({ modelPath })`
throw an actionable error unless you pass a `driver` (a `SeaOrmDriver`
implementation, e.g. wrapping `pg`/`mysql2`/`better-sqlite3`/Prisma) or an
`executor` (an `MlExecutor`, e.g. wrapping `onnxruntime-node`). With a
driver/executor they work in pure JavaScript (covered by tests).

**Remaining PSX stub integrations:** the other 13 wrappers (SQLx, Redis, Rust
Auth, Image, PDF, Jobs, Cron, Email, HTTP, WebSocket, File Processing,
Observability, Crypto) have no compiled Rust crates behind them. Each one
either runs its JavaScript fallback or, for the few calls with no fallback
(`SqlxPool.transaction`, `SqlxTransaction.query`, Redis `subscribe`/`publish`,
`PdfGenerator.fromTemplate`), throws a clear "needs the native addon" error.
Their fallbacks depend on optional packages you install yourself (`pg`,
`mysql2`, `redis`/`ioredis`, `argon2`/`bcryptjs`, `jsonwebtoken`, `sharp`,
`puppeteer`, `nodemailer`, `xlsx`).

**Orphaned PSX modules:** `multi-region`, `monitoring-dashboard`, `lambda-psx`,
`serverless-cold-start`, `edge-durable-objects`, `worker-pool`, `rollback`,
`canary`, `dead-code`, `cross-compile`, `sccache` and `jit-templates` are
exported from `pledgestack-core` and unit-tested, but are not wired into any
CLI command or request path. They are kept exported (removing public exports
is a breaking change) and should be treated as unsupported building blocks.

**Workaround:** Use the JS fallback APIs directly (pg, mysql2, node:crypto,
nodemailer, etc.) until the Rust crates are implemented.

## Open Graph images (`ImageResponse`)

`ImageResponse` (`pledgestack-og`) only *serializes* the element tree. The
PledgeStack server (`maybeRenderOgResponse`, `pledgestack-server`) renders it:

1. `svg` element trees are used as-is; `div`/`span`/`p`/`h1..h6`/`img` trees are
   laid out by a built-in **flexbox subset** (width/height, padding, gap,
   flex direction/grow, justify/align, background/border colors, border radius,
   opacity, font size/weight/family/style, color, line height, text align,
   letter spacing) and converted to SVG.
2. The SVG is rasterized to a real PNG by the native `rust-og-renderer` addon
   when compiled, otherwise by the optional `sharp` package
   (`pnpm add sharp`).
3. With neither available the response is **`501`** with an actionable JSON
   message — never serialized JSX labelled `image/png`.

Not supported: margins, absolute positioning, flex-wrap, gradients, shadows,
transforms, background images, remote/`file:` images (only inline `data:` PNG,
JPEG, GIF and WebP images are drawn), custom font bytes (the `fonts` option is
recorded but the rasterizer uses the system's fonts) and text shaping for
complex scripts. Text wrapping uses average glyph metrics, so line breaks are
approximate. Function components are expanded by calling them with their props
(no hooks). This is not a Satori replacement; for pixel-exact typography use a
dedicated renderer and return the PNG yourself.

## Bundler HMR (hot module replacement)

HMR is only as real as the underlying bundler's dev server:

| Bundler | Dev server | Live update |
|---|---|---|
| vite | Vite's own (`hmr: true`) | Yes. `handle.reload(id)` invalidates the module and sends `full-reload`; `.psx`/`.ps` changes trigger a full reload |
| webpack | `webpack-dev-server` when installed (`hot: true`) | Yes with `webpack-dev-server`; `reloadAll()` sends the WDS `content-changed` message |
| rsbuild | `@rsbuild/core` when installed | Rsbuild's own HMR; the adapter's `reloadAll()` is best-effort |
| rollup, turbopack (no `@utoo/pack`), rsbuild/webpack fallbacks | small esbuild transform-on-request HTTP server | **No** live reload / HMR — refresh the browser |
| pledgepack (default) | the native `pledgepack` binary | Provided by the binary |

`pledge dev` runs PledgeStack's own SSR server next to the bundler dev
server; it invalidates server modules on file change (`createHMRWatcher`) but
does not push browser updates through the fallback servers. `handle.reload` /
`handle.reloadAll` are optional on `DevServerHandle` and nothing in the CLI
calls them today.

## `pledge upgrade`

`pledge upgrade` checks the latest published version (prerelease-aware),
updates `package.json` and installs. It intentionally has **no codemod
stage**: PledgeStack has not shipped a version-to-version breaking change that
needs a source rewrite, and the Next.js-migration codemods must never run
implicitly. Run them explicitly with `pledge codemod <name> <path>`.
`--skip-codemods` is accepted for compatibility and does nothing.

## MDX Plugin (partial) — with first-party compiler fallback

**Files:** `packages/mdx/src/index.ts`, `packages/content/src/index.ts`

The MDX plugin registers with PledgePack's transform pipeline but has
limited functionality:

- ✅ File extension registration (`.mdx`, `.md`)
- ✅ MDX provider wrapper injection
- ✅ Frontmatter extraction (simple YAML-like parser)
- ❌ `frontmatter` option has no forwarding channel yet
- ❌ `remarkPlugins` option has no effect
- ❌ `rehypePlugins` option has no effect

**Impact:** Complex MDX with custom remark/rehype plugins won't work through
the plugin options. Actual MDX→JS compilation is deferred to PledgePack.

**First-party `compileMdx` (content package):** The `packages/content` package
now includes a lightweight, zero-dependency `compileMdx()` that handles:
- Stripping import/export statements
- Extracting JSX elements (self-closing and with children)
- Rendering markdown segments via `renderMarkdown`
- Rendering JSX via `registerMdxComponents()` or fallback placeholders
- Props parsing (string, expression, boolean)

This is **not** a full `@mdx-js/mdx` replacement — it doesn't support
remark/rehype plugins, JSX expressions in attributes beyond simple values,
or complex component composition. For full MDX, install `@mdx-js/mdx` and
pass it to `setBodyRenderer()`.

**Workaround:** For complex MDX, configure PledgePack directly, install
`@mdx-js/mdx` and use `setBodyRenderer()`, or use a custom transform pipeline.

## Native Rust Addons (optional, not compiled by default)

17 Rust NAPI addons in `packages/core/native/` provide optional acceleration
for rendering, caching, compression, and more. These are **not compiled by
default** — they require `cargo build` in `packages/core/native/`.

When not compiled, all paths fall back to JavaScript implementations. This
is by design (the framework works without Rust), but means production
deployments don't get the Rust performance benefit unless explicitly built.

**Affected modules:** rust-html, rust-ssr, rust-rsc, rust-html-transformer,
rust-dom-renderer, rust-rsc-deserializer, rust-ssr-profiler, rust-hydration,
rust-og-renderer, rust-kv-store, rust-rate-limiter, rust-static-server,
rust-compression, rust-search, rust-jit-templates, rust-ws-compression,
rust-bench.

**Workaround:** Run `cd packages/core/native && cargo build --release` to
compile the addons. The framework auto-detects their presence.

## Release model (1.0.0-rc)

All 34 public packages (the CLI `pledgestack`, `create-pledge-app`, every
`pledgestack-*` library, the four `pledgestack-renderer-*` adapters and six
`pledgestack-bundler-*` adapters, and `pledgestack-eslint-plugin`) share one
version, managed by Changesets' `fixed` group, and are published together
through `.github/workflows/release.yml`. While `.changeset/pre.json` exists the
repo is in prerelease mode: versions are `1.0.0-rc.N` and are published under
the `rc` dist-tag (`npm i pledgestack@rc`). The two VS Code extensions
(`pledgestack-vscode`, `pledgestack-psx`) are private and ship through the
Marketplace, not npm.

- The CLI still bundles every workspace package with esbuild, so the
  `pledgestack` package alone is enough to build an app; the individual
  packages exist for people composing pieces themselves.
- All packages are **ESM-only** (Node >= 20). Their JS is bundled with esbuild
  (`scripts/bundle-package.mjs`) because `tsc` output has extensionless
  relative imports that Node ESM cannot load; `pnpm check:release --dist`
  verifies this and every `exports` target.
- Native Rust addons (`packages/core/native`) are **not** shipped in any npm
  package; every native path has a JavaScript fallback or fails with an
  actionable error.
- The `pledgestack` package's type declarations live in `dist/packages/*` and
  are re-exported by `dist/<entry>.d.ts`.

## WebSocket routes (`/ws/*`) on the Node production server

**File:** `packages/server/src/node.ts`, `packages/ws/src/index.ts`

`pledge start` (Node) validates the `Origin` of `/ws/*` upgrades and then
answers **501 Not Implemented**: the Node server does not perform the
WebSocket handshake itself, and no `ws`-style dependency is bundled.
`WSRoom`, `defineWebSocketRoute` and `createAuthenticatedWSRoute` are
building blocks with no built-in production transport. To serve WebSockets
today, attach your own upgrade handler (e.g. the `ws` package on the
`http.Server` you get from a custom entry point) or use the PledgePack Rust
production server / a platform that terminates WebSockets for you.

## Server action / server function ids

Action ids are sent by the client bundle and looked up in the server bundle's
registry, so they must match across both builds. They are derived from the
explicit `{ id }` (recommended: `"<file path>#<export name>"`), else the
action's `name`; only anonymous, id-less functions fall back to a hash of the
function source, which can differ between bundles (a production warning is
logged). Pass `{ id }` to `serverAction()` / `createServerFn()`. Two
different functions registering the same id throws in production.

## Middleware in production

`pledge start` loads the **built** middleware (`.pledge/server/middleware.js`,
produced for `app/middleware.ts`), imports plain `middleware.js` directly, and
**refuses to start** (request handling returns 500) if middleware exists but
cannot be loaded, instead of silently serving without it. A root-level
`middleware.ts` outside `app/` is not bundled — move it under `app/`. Server
action POSTs run through the middleware; when the middleware declares a
`matcher`, an action is exempted only if its same-origin `Referer` page is
provably outside the matcher. `Referer` is client-supplied, so actions that
need authorization must still authenticate themselves.

## Signed cookies

Signed cookies are now name-bound (`v2.` format). Existing name-unbound `v1.`
cookies are rejected unless `PLEDGE_ACCEPT_LEGACY_COOKIES=1` is set for a
migration window (v1 signatures allow cross-cookie replay — remove the flag
once old cookies have expired).

## Brute-force protection

The built-in guard counts a `401` response to a `POST` on an auth path
(`/login`, `/auth`, `/signup`, …, plus `config.authPaths`) as a failed attempt
for the client automatically. Successful logins do not clear the counter (so an
attacker's own valid account can't reset it). Apps using other status codes for
failed logins should call `recordFailedAttempt()` themselves.

## SAML Signature Canonicalization

**File:** `packages/auth/src/saml.ts`

The SAML XML injection fix (goal #10) addresses XML injection by escaping
user-controlled values. However, **SAML signature canonicalization** (XML
Canonicalization / C14N) is not implemented. Full SAML security requires:

1. ✅ XML injection prevention (done)
2. ❌ Canonicalization of signed XML (C14N)
3. ❌ Signature verification against canonicalized form

**Impact:** SAML responses are generated correctly but signature
verification may not be fully secure against canonicalization attacks.

**Recommendation:** Use a dedicated SAML library for production SSO that
implements full C14N (e.g. `saml2-js` or `@node-saml/passport-saml`).

## Session Regeneration Semantics

**File:** `packages/auth/src/index.ts`

Session regeneration was added (goal #1), but `SessionManager` uses
stateless HMAC-signed cookies. "Regeneration" in a stateless design means
issuing a new cookie with new random material — the old cookie remains
cryptographically valid until it expires.

**Impact:** True session invalidation requires a server-side session store
or a token blocklist. The current implementation rotates the session ID but
can't revoke the old cookie if the client retains it.

**Workaround:** Use short session expiry and rotate the signing key to
invalidate all outstanding sessions if needed.

## OAuth Email Verification Enforcement

**File:** `packages/auth/src/oauth.ts`

The `normalizeUserInfo` function now extracts `email_verified` (goal #3),
but **enforcement** (rejecting unverified emails) is left to the application.
The framework surfaces the claim; the app must check it.

**Impact:** An app that doesn't check `email_verified` will accept users
with unverified emails from the IdP.

**Recommendation:** Check `user.emailVerified` in your auth callback and
restrict access for unverified users.

## ISR Locale Key

**File:** `packages/server/src/handler.ts`

The ISR cache key uses the request pathname, which already includes the
locale prefix when i18n is configured (e.g. `/en/blog/hello`). This was
verified during implementation and the locale was NOT added separately to
avoid double-prefixing.

**Impact:** If i18n is configured but the locale is NOT in the pathname
(e.g. using cookies for locale detection), ISR cache keys would collide
across locales. This is an edge case — the default i18n behavior includes
the locale in the URL.

**Recommendation:** If using cookie-based locale detection, manually include
the locale in the ISR cache key.

## Deploy Package Edge Config

**Files:** `packages/deploy/src/index.ts`, `packages/shared/src/config.ts`

The deploy adapters read `config.pledgepack?.edge?.target` (not
`config.edge?.target`) for platform detection. This was fixed during this
session. The `PledgeConfig` type's `edge` property is nested under
`pledgepack`, not at the top level.

**Status:** ✅ Resolved. Use `config.pledgepack.edge.target` for platform
detection. The `detectTarget()` function now validates the edge target
against supported platforms (cloudflare/vercel/netlify).

## Pre-Existing IDE Diagnostics

One IDE diagnostic is pre-existing and not caused by the 50-goal work:

1. **`baseUrl` deprecation** (`packages/create-pledge-app/tsconfig.json`) —
   inherited from root `tsconfig.json`. Root has
   `"ignoreDeprecations": "5.0"` (valid for TS 5.9.3). The `"6.0"` hint
   targets TS 7.0 (unreleased). Not a real error.

(An earlier entry about `templates/pledge/tsconfig.json` extending
`./node_modules/pledgestack/tsconfig-base.json` is obsolete — the templates no
longer ship a `tsconfig.json`; the scaffolder writes a self-contained one via
`generateTsConfig`.)

## Test Notes

### sccache Test Timeout (Windows)
**File:** `packages/core/src/psx/sccache.test.ts`

`generateCacheKey()` calls `execSync('rustc --version')` which is slow on
Windows (subprocess spawn + PATH search). Test timeout increased to 30s.
May still be flaky on very slow Windows machines.

### JWT Key Generation Tests
**File:** `packages/auth/src/jwt.test.ts`

RSA key pair generation tests take ~13s due to crypto operations. This is
expected and not a bug.

## Not Yet Implemented

The following are documented gaps (not part of the 50 goals):

- **PSX playground:** `pledge playground` compiles Rust→WASM with the real
  toolchain (`cargo build --target wasm32-unknown-unknown`) when it's
  installed; when unavailable it runs a clearly-labeled simulation. The WASM
  path requires the wasm32 target, which isn't checked by `pnpm test`.
- **PSX bench:** `pledge bench --psx` benchmarks the real `rust-bench.node`
  addon when the native crates are compiled (`packages/core/native/` now
  includes a real `rust-bench` crate with `#[napi]` functions); when it's not
  compiled it benchmarks the real JS fallback implementations instead — the
  numbers are real either way, but without the addon there is no Rust-vs-JS
  comparison.
- **Release provenance:** SBOM generation (CycloneDX/SPDX) is wired into
  `pledge build` (`packages/server/src/supply-chain.ts`), but release
  provenance attestation / Sigstore signing of published artifacts is not
  yet implemented.
- **Build manifests:** Not yet emitted by the bundler adapters
  (vite/webpack/rollup/etc.); the `__pledge_ps_manifest.json` route manifest
  consumed by `bundler-pledgepack` comes from PledgePack itself, not these
  adapters.
- **Stable hydration IDs:** Still uses import-order counters (goal was
  identified but not yet implemented — see `packages/client/src/pledge.ts`)
