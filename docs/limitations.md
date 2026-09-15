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
| 257 | Sea-ORM | sea-orm | Throws "addon not found" (no fallback) |
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
| 270 | ML Inference | candle-core/ort | Throws "addon not found" (no fallback) |

**Impact:** Applications using these integrations work via JS fallbacks but
don't get the Rust performance benefit. Two integrations (Sea-ORM #257 and
ML Inference #270) have no JS fallback and will throw at runtime.

**Workaround:** Use the JS fallback APIs directly (pg, mysql2, node:crypto,
nodemailer, etc.) until the Rust crates are implemented.

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

16 Rust NAPI addons in `packages/core/native/` provide optional acceleration
for rendering, caching, compression, and more. These are **not compiled by
default** — they require `cargo build` in `packages/core/native/`.

When not compiled, all paths fall back to JavaScript implementations. This
is by design (the framework works without Rust), but means production
deployments don't get the Rust performance benefit unless explicitly built.

**Affected modules:** rust-html, rust-ssr, rust-rsc, rust-html-transformer,
rust-dom-renderer, rust-rsc-deserializer, rust-ssr-profiler, rust-hydration,
rust-og-renderer, rust-kv-store, rust-rate-limiter, rust-static-server,
rust-compression, rust-search, rust-jit-templates, rust-ws-compression.

**Workaround:** Run `cd packages/core/native && cargo build --release` to
compile the addons. The framework auto-detects their presence.

## Workspace Version Drift

Package versions span 0.0.1 to 0.2.8 with no versioning policy:

- Root: 0.1.12
- CLI: 0.1.12
- Most packages: 0.1.x or 0.2.x
- Some packages: 0.0.1

**Impact:** No semantic versioning enforcement means breaking changes may
not be communicated via version bumps. Only the CLI is published to npm, so
this is primarily an internal concern.

**Recommendation:** Adopt changesets (already configured) for versioning.

## Only CLI Published to npm

The release workflow publishes only `packages/cli` to npm:

```
pnpm --filter "./packages/cli" publish --no-git-checks
```

The CLI bundles all workspace packages via esbuild, so the published
`pledgestack` package contains everything. Individual packages are not
published separately.

**Impact:** Users can't install individual packages (e.g.
`@pledgestack/auth` alone). This is by design (single-package distribution),
but means the package is large.

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

Two IDE diagnostics are pre-existing and not caused by the 50-goal work:

1. **`baseUrl` deprecation** (`packages/create-pledge-app/tsconfig.json`) —
   inherited from root `tsconfig.json`. Root has
   `"ignoreDeprecations": "5.0"` (valid for TS 5.9.3). The `"6.0"` hint
   targets TS 7.0 (unreleased). Not a real error.

2. **Missing `tsconfig-base.json`**
   (`packages/create-pledge-app/templates/pledge/tsconfig.json`) — by
   design. The template extends `./node_modules/pledgestack/tsconfig-base.json`
   which only exists after `pledge create` scaffolds and installs. The root
   tsconfig excludes this directory. Not a real bug.

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

- **PSX playground:** `pledge playground` simulates Rust→WASM but doesn't
  actually compile to WASM
- **PSX bench:** `pledge bench --psx` simulates benchmarks
- **Multi-region routeByLatency:** Has a known bug in the latency-based
  routing logic (documented in `REMAINING-ISSUES.md`)
- **VS Code PSX debug adapter:** Stub implementation
- **Release provenance/SBOM:** Not yet generated
- **Build manifests:** Not yet emitted by bundlers
- **Stable hydration IDs:** Still uses import-order counters (goal was
  identified but not yet implemented — see `packages/client/src/pledge.ts`)
