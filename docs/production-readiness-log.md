# Production-Readiness Log — the 50 goals (historical)

> Moved from `docs/changelog.md` on 2026-09-20. This is the per-goal work log of the
> September 2026 hardening pass, kept for reference. The project changelog is now
> [changelog.md](./changelog.md); per-package changelogs live in each `packages/*/CHANGELOG.md`.
> Test counts quoted below are those of the time and are superseded by
> [AUDIT-STATUS.md](../AUDIT-STATUS.md).


All 50 goals identified in the full-codebase audit have been implemented and
verified. `pnpm typecheck`: 0 errors. `pnpm test`: 1097 passing, 0 failing,
5 skipped across 118 files (the 2 MDX/server-fn failures present when this
work landed were fixed in `730b5b3`).

## Tier 1 — Security-Critical (15 goals)

### 1. Session regeneration on login (session fixation)
**File:** `packages/auth/src/index.ts`

Added `regenerateSession()` to `SessionManager` that destroys the old session
and issues new random material. Prevents session fixation where a pre-auth
cookie remains valid after login.

### 2. Password strength validation
**File:** `packages/auth/src/index.ts`

Added `validatePasswordStrength()` enforcing minimum length (12 chars),
character class requirements (uppercase, lowercase, digit, special), and
returning a structured result with specific failure reasons.

### 3. Email verification + OIDC `email_verified`
**Files:** `packages/auth/src/index.ts`, `packages/auth/src/oauth.ts`

Added `generateVerificationToken()`/`verifyEmailToken()` for email
verification flows. OAuth `normalizeUserInfo` now extracts and surfaces the
`email_verified` claim from identity providers.

### 4. Account lockout / brute-force protection
**File:** `packages/auth/src/index.ts`

Added `AccountLockoutManager` tracking failed attempts per identifier with
exponential backoff. Integrates with `AuditLogger` for security event logging.

### 5. JWT token type enforcement
**File:** `packages/auth/src/jwt.ts`

`verifyJWT` now checks the `typ` claim. A refresh token (`typ: 'refresh'`)
can no longer be used as an access token, preventing privilege extension.

### 6. TOTP replay protection
**File:** `packages/auth/src/totp.ts`

Added `TotpReplayGuard` that tracks consumed TOTP codes within their validity
window, preventing replay of the same code. Backup code verification now
iterates all codes (constant-time) rather than returning on first match.

### 7. OAuth redirect URL validation
**File:** `packages/auth/src/oauth.ts`

Added `isSafeRedirect()` helper that validates redirect URLs against an
allowlist, preventing open-redirect attacks via the OAuth callback flow.
OAuth state now includes expiry validation.

### 8. SSRF DNS rebinding / TOCTOU
**File:** `packages/auth/src/ssrf.ts`

`createSafeFetch` now resolves and pins the validated IP address for the
actual fetch request, closing the time-of-check-to-time-of-use gap where DNS
could rebind to a private IP between validation and fetch.

### 9. Encryption salt persistence
**File:** `packages/privacy/src/encryption.ts`

Encrypted payloads now persist the salt used during key derivation. Decrypt
re-derives the key from the passphrase and the payload-specific salt, so
different encryptions use different keys (defense in depth).

### 10. SAML XML injection prevention
**File:** `packages/auth/src/saml.ts`

Added XML escaping helper applied to all user-controlled values interpolated
into SAML metadata, AuthnRequest, and LogoutRequest XML (nameId, issuer,
destination URLs).

### 11. Upload content verification (magic bytes)
**File:** `packages/api/src/upload.ts`

Upload handler now verifies file content using magic byte signatures rather
than trusting the client-supplied MIME type. Added `X-Content-Type-Options:
nosniff` to upload responses.

### 12. RSS custom element name validation
**File:** `packages/rss/src/index.ts`

Custom XML element names are validated against the XML Name production rule
before interpolation, preventing XML injection via malicious element names.

### 13. OG `nosniff` + serialization depth limit
**File:** `packages/og/src/index.ts`

Added `X-Content-Type-Options: nosniff` header to OG image responses. Added
a depth cap to element serialization to prevent stack overflow on deeply
nested JSX trees.

### 14. CCPA opt-out cookie HMAC signing
**File:** `packages/privacy/src/ccpa.ts`

CCPA "Do Not Sell" opt-out cookies are now HMAC-signed, preventing forgery.
The `CCPAManager` constructor retains a secret and verifies signatures on
read.

### 15. `trustProxy` default deny
**File:** `packages/privacy/src/transport.ts`

`meetsTLSMinimum` now defaults to deny when the `X-Forwarded-Proto` header is
absent, rather than trusting it by default. The `trustProxy` option must be
explicitly enabled.

---

## Tier 2 — Server Reliability (15 goals)

### 16. Request body size limits
**Files:** `packages/server/src/node.ts`, `packages/server/src/edge.ts`

Node and edge handlers enforce configurable body size limits (default 1MB).
Oversized requests receive 413 Payload Too Large.

### 17. Request timeout abort
**File:** `packages/server/src/handler.ts`

Request handling uses `AbortController` with a configurable timeout. When
the timeout fires, the underlying work is aborted rather than left running.

### 18. Server-action error masking
**File:** `packages/server/src/handler.ts`

Server action errors are no longer leaked to the client. Detailed error
messages are logged server-side; the client receives a generic "Internal
error" message.

### 19. Dev error page XSS fix
**File:** `packages/server/src/node.ts`

The development error page now HTML-escapes all error metacharacters before
interpolation, preventing reflected XSS via error messages.

### 20. CSRF config decoupling
**Files:** `packages/server/src/handler.ts`, `packages/shared/src/config.ts`

CSRF protection is now controlled by a separate `csrf` config option, not
coupled to `securityHeaders`. Added `csrf?: boolean` to `PledgeConfig`.

### 21. Request ID sanitization
**File:** `packages/server/src/handler.ts`

Request IDs are sanitized (alphanumeric + hyphen only, length-capped) before
use in headers and logs, preventing header injection via crafted IDs.

### 22. Middleware rewrite open-redirect validation
**File:** `packages/server/src/handler.ts`

Middleware rewrite targets are validated as same-origin, preventing open
redirects via crafted middleware rewrite rules.

### 23. Health endpoint tri-state
**File:** `packages/server/src/health.ts`

Health check now reports three states: healthy (200), degraded (200), and
unhealthy (503). Degraded returns 200 so load balancers don't drain
partially-healthy instances.

### 24. Brute-force route matching improvement
**File:** `packages/server/src/handler.ts`

Route matching uses the specificity-scored matcher rather than first-match,
so `/blog/:slug` correctly beats `/blog/*rest`.

### 25. WebSocket Origin validation
**File:** `packages/server/src/node.ts`

WebSocket upgrade requests validate the `Origin` header against an allowlist,
preventing cross-site WebSocket hijacking (CSWSH).

### 26. Edge base64 + error handling
**File:** `packages/server/src/edge.ts`

Edge handler now decodes base64-encoded binary request bodies and handles
errors gracefully with proper status codes.

### 27. Image optimization param bounding
**File:** `packages/server/src/virtual-modules.ts`

Image optimization parameters (width, height, quality) are bounded to
reasonable ranges, preventing resource exhaustion via extreme values.

### 28. ISR cache improvements
**File:** `packages/core/src/render/isr-cache.ts`

ISR cache now uses proper LRU eviction (Map insertion-order as ledger),
periodic TTL sweep of expired entries, and `tryStartRevalidation()` for
thundering-herd protection (only one request regenerates at a time).

### 29. Context initialization race fix
**File:** `packages/server/src/handler.ts`

Context initialization uses a promise singleton, so concurrent requests
don't race to initialize the context independently.

### 30. Graceful shutdown handler deduplication
**File:** `packages/server/src/graceful-shutdown.ts`

Shutdown handlers are deduplicated by reference, so registering the same
handler multiple times doesn't cause duplicate cleanup on shutdown.

---

## Tier 3 — Render/Router (8 goals)

### 31. Streaming timeout cleanup
**File:** `packages/core/src/render/stream.ts`

The streaming SSR fallback timer is now cleared on settlement (success or
error), preventing a dangling timer from keeping the event loop alive. Added
stream error handling and a settled flag to prevent double-resolution.

### 32. Hybrid SSR post-shell error handling + hard timeout
**File:** `packages/core/src/render/hybrid-ssr.ts`

`renderHybrid` now surfaces post-shell errors (previously only pre-shell
errors rejected), handles writable stream errors, and has a 10s hard
timeout so a stuck render can't hang the request indefinitely.

### 33. Compiled pattern memoization
**File:** `packages/core/src/router/match.ts`

`compilePattern` results are memoized (cap: 2000 entries), so route matching
doesn't rebuild RegExp objects on every request. LRU eviction when full.

### 34. Safe `decodeURIComponent`
**File:** `packages/core/src/router/match.ts`

Route params are decoded via `safeDecodeURIComponent` which returns the
original string on malformed input instead of throwing `URIError`, so a
malformed `%ZZ` sequence gets a 404 instead of a 500.

### 35. `generateStaticParams` failure surfacing
**File:** `packages/core/src/render/static.ts`

`generateStaticParams` failures now throw with the route pattern and file
path, rather than silently producing zero pages for the route.

### 36. Bounded prefetch cache + navigation race protection
**File:** `packages/client/src/router.ts`

The client prefetch cache is bounded (cap: 100 entries, LRU eviction).
Navigation uses a sequence counter so a slow in-flight fetch can't overwrite
a newer navigation's result.

### 37. Media hydration listener cleanup
**File:** `packages/client/src/hydrate-pledges.ts`

Media-strategy pledge hydration listeners are tracked and cleaned up on
route change (`rehydratePledges`), preventing listener leaks across
navigations.

### 38. ISR cache hardening (covered by #28)

The ISR cache improvements in goal #28 (LRU eviction, TTL sweep,
thundering-herd guard) fully address the ISR caching concerns.

---

## Tier 4 — Performance & Memory (7 goals)

### 39. JIT template profile cache bounding
**File:** `packages/core/src/psx/jit-templates.ts`

The JS-fallback JIT template profile map is bounded (cap: 2000 entries,
LRU eviction), so profiled routes don't accumulate without bound.

### 40. KV-store memory cap + debounced persistence
**File:** `packages/core/src/psx/kv-store.ts`

The JS-fallback KV store is bounded (cap: 5000 entries, LRU eviction).
Disk writes are debounced (50ms) so rapid mutations coalesce into a single
flush, reducing I/O. Oversized values are skipped from JSON snapshots.

### 41. WS decompression bomb limit
**File:** `packages/core/src/psx/ws-compression.ts`

`wsDecompress` rejects decompressed output larger than 16 MiB, preventing
compressed "zip bombs" from OOMing the process.

### 42. WS room client/topic caps + error isolation
**File:** `packages/ws/src/index.ts`

`WSRoom` now enforces `maxClients` (default 10,000) and `maxTopicSize`
(default 10,000). Empty topics are deleted. Per-send errors are isolated so
one bad socket doesn't abort a broadcast.

### 43. State store listener error isolation
**File:** `packages/state/src/store.ts`

`createStore` notifies listeners via a snapshot iteration with try/catch per
listener, so one throwing subscriber doesn't prevent the rest from being
notified.

### 44. Persistence quota error surfacing
**File:** `packages/state/src/persistence.ts`

`usePersistentState` now accepts an `onPersistError` callback that's invoked
when a storage write fails (e.g. `QuotaExceededError`), so the UI can surface
the error instead of silently dropping data.

### 45. URL-state redundant update prevention
**File:** `packages/state/src/url-state.ts`

`useUrlState`'s `setValue` now skips redundant updates (when the value is
unchanged), avoiding no-op history entries and needless re-render cycles.

---

## Tier 5 — Build & CI/CD (5 goals)

> **2026-09-25:** The webpack, rollup, turbopack and rsbuild adapters were
> removed; PledgePack is the default and Vite remains as the JS fallback.
> Goals 46 (webpack minification) is moot; 47 applies to Vite + PledgePack.

### 46. Webpack production minification + content hashes + split chunks
**File:** `packages/bundler-webpack/src/index.ts` *(adapter removed 2026-09-25)*

Webpack production builds now enable minification (`minimize: true`),
content-hashed filenames (`[name].[contenthash:8].js`), shared chunk
splitting (`splitChunks: { chunks: 'all' }`), and source maps (`source-map`).

### 47. Vite source maps + content hashes
**File:** `packages/bundler-vite/src/index.ts`

Vite server and client builds now enable source maps (`sourcemap: true`).
Server bundle entries use content hashes (`[name].[hash].js`) with chunk
file names.

### 48. CLI source maps
**File:** `packages/cli/scripts/build.mjs`

The CLI esbuild build now enables source maps (`sourcemap: true`), making
published CLI stack traces actionable for debugging.

### 49. Docker entrypoint fix
**File:** `packages/cli/src/commands/docker.ts`

The generated Dockerfile no longer hardcodes `node .pledge/server.js` (which
breaks with hashed filenames). It now uses `pledge start` which resolves the
actual entry point from the build manifest.

### 50. Env validation + CI gates + path alias fix
**Files:** `packages/shared/src/config.ts`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, `tsconfig.json`

Added `validateEnv()`/`assertEnv()` for startup environment validation with
a schema-based API. CI now runs build verification. Release workflow now
runs typecheck, lint, and test before publishing. Added missing
`pledgestack-privacy` path alias to root `tsconfig.json`.

---

## Additional work (user, same session)

The following changes were made by the user during the same session, after
the 50-goal implementation:

### Server function middleware
**File:** `packages/server/src/server-fn.ts`, `packages/server/src/handler.ts`

Added `.middleware()` chain support to `createServerFn()`. Middleware
functions run before the handler, receive context + `next()`, and can
short-circuit. The handler now dispatches server functions first, falling
back to legacy server actions.

### Content CLI command
**File:** `packages/cli/src/commands/content.ts`, `packages/cli/src/bin.ts`

Added `pledge content` command with subcommands: `list`, `validate`, `stats`,
`index`. Lists entries, validates against schemas, shows statistics, and
rebuilds the content cache index.

### Content markdown renderer + caching
**File:** `packages/content/src/index.ts`

Added `renderMarkdown()` (lightweight zero-dependency markdown-to-HTML),
`renderBody()` (pluggable body renderer with caching on the entry),
`setBodyRenderer()` (custom renderer registration), `getAllCollectionNames()`,
collection cache with mtime-based staleness (`getCollectionCached`,
`isCacheStale`).

### Deploy project name support
**File:** `packages/deploy/src/index.ts`, `packages/cli/src/bin.ts`

Added `--project <name>` flag to `pledge deploy`. Vercel uses `--name`,
Netlify uses `--site`. Defaults to the root directory name.

### Deploy edge config path fix
**File:** `packages/deploy/src/index.ts`

Fixed platform detection to read `config.pledgepack?.edge?.target` instead
of `config.edge?.target`. `detectTarget()` now validates the edge target
against supported platforms.

### Content package dependency
**File:** `packages/cli/package.json`, `packages/cli/tsconfig.json`

Added `pledgestack-content` as a workspace dependency and project reference.

### Shared tsconfig node types
**File:** `packages/shared/tsconfig.json`

Added `"types": ["node"]` to resolve IDE diagnostics for Node globals.

### MDX compiler (first-party)
**File:** `packages/content/src/index.ts`, `packages/content/src/index.test.ts`

Added `compileMdx()` — a lightweight, zero-dependency MDX-to-HTML compiler:
- Strips import/export statements
- Extracts JSX elements (self-closing and with children)
- Renders markdown segments with `renderMarkdown`
- Renders JSX via registered components (`registerMdxComponents`) or
  fallback `<div data-component="Name">` placeholders
- Props parsing: string, expression (`{value}`), boolean
- Markdown-inside-JSX-children rendering
- `renderBody` auto-selects `compileMdx` for `.mdx` files

### Server function input/output validators
**File:** `packages/server/src/server-fn.ts`, `packages/server/src/server-fn.test.ts`

Added `.inputValidator()` and `.outputValidator()` builder methods:
- `inputValidator(fn)` runs before the handler, throws on invalid input
- `outputValidator(fn)` runs after the handler, throws on invalid output
- Multiple validators chain in order
- Work with or without a `.validator()` transform
- Work with `dispatchServerFn()` server-side dispatch
