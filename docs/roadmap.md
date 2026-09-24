# Next 50 Goals — Production Readiness

Scope: **no new features.** Every item below is a concrete production-readiness
gap found by a full-codebase audit on 2026-09-14 using 5 parallel analysis passes
(server/handler, auth/security, render/router, build/CLI/devops, feature
packages). All 50 goals are things the codebase *claims* to do but doesn't do
safely enough for production. Ordered by severity within each tier.

Legend: 🔴 security-critical · 🟠 reliability/correctness · 🟡 performance/ops · ⚊ build/devops

> **Status (2026-09-20, 0.2.0):** The 50 goals below were worked through in
> source with unit tests, and the workspace is green (`pnpm typecheck`: 0 errors;
> `pnpm test`: **1692 passing, 0 failing, 6 skipped across 206 files**). An earlier
> revision of this page claimed "all 50 IMPLEMENTED and VERIFIED"; that overstated
> it — the goals were not each independently re-verified, and a 2026-09-20 spot
> check found at least one only partially done:
>
> - **#46 asset fingerprinting — partial.** Webpack now emits `[contenthash]`
>   bundle names, but the renderers still emit the literal
>   `/__pledge__/client.js` / `client.css` URLs, so browsers/CDNs still cannot
>   cache them immutably.
>
> Treat [AUDIT-STATUS.md](../AUDIT-STATUS.md) as the single source of truth for
> what is fixed and what is open, and [limitations.md](./limitations.md) for the
> known gaps. The history of the earlier tiers (1–3, 2026-08-25) is in
> [SESSION-LOG.md](../SESSION-LOG.md). Goals in this file were found by deeper
> full-codebase analysis on 2026-09-14; their descriptions below are kept as
> originally written (file paths and line numbers are as of commit `3a4dd5a`).

---

## Tier 1 — Security-Critical (auth, session, data protection)

**1. 🔴 No session regeneration on login (session fixation)**
`packages/auth/src/index.ts` — `SessionManager` has `createSession`/`destroyCookie` but no `regenerateSession`. A pre-auth session cookie remains valid after login. Add a `regenerateSession()` that destroys the old session and issues new random material, and enforce its use in login flows.

**2. 🔴 No password complexity validation**
`packages/auth/src/index.ts:148-184` — `hashPassword()`/`verifyPassword()` accept any string, including empty. No minimum length, complexity, or breach-dictionary checks. Add `validatePasswordStrength()` enforcing ≥12 chars, character classes, and optional HIBP k-anonymity check.

**3. 🔴 No email verification flow**
`packages/auth/src/` — No `generateVerificationToken()`/`verifyEmailToken()` anywhere. Users register with any email and immediately gain access. OAuth `normalizeUserInfo` ignores the `email_verified` claim. Add verification tokens, require verification before full access, and check IdP `email_verified`.

**4. 🔴 No account lockout / brute-force protection on auth endpoints**
`packages/auth/src/` — No failed-attempt counter, lockout, or throttling. `verifyPassword` and `verifyTOTP` are pure functions with no rate-limiting. `AuditLogger.logAuth()` exists but nothing consumes it. Add an `AccountLockoutManager` tracking failed attempts per identifier/IP with exponential backoff.

**5. 🔴 JWT refresh token usable as access token (no `typ` check)**
`packages/auth/src/jwt.ts:307-329` — `createTokenPair` sets `typ: 'refresh'` but `verifyJWT` never checks the `typ` claim. A 7-day refresh token is accepted where a 15-minute access token is expected. Add `tokenType` to `JWTVerifyOptions` and reject mismatched tokens.

**6. 🔴 TOTP replay — no tracking of consumed codes**
`packages/auth/src/totp.ts:125-145` — `verifyTOTP` checks ±1 time windows but doesn't track used codes. The same code can be replayed within its 90s validity. Violates RFC 6238 §5.2. Track the last successfully used `(counter, code)` pair per user and reject replays.

**7. 🔴 OAuth redirect URL not validated against allowlist (open redirect)**
`packages/auth/src/oauth.ts:116-134,329-348` — `createOAuthStateParam` embeds `redirect` verbatim; `handleCallback` returns it without calling `validateRedirect()`. An attacker can craft state with an arbitrary redirect. Validate `redirect` against an allowlist in `initiateAuth()` before embedding.

**8. 🔴 SSRF TOCTOU / DNS rebinding in `createSafeFetch`**
`packages/auth/src/ssrf.ts:39-90,120-128` — `isSafeUrl()` resolves DNS and validates the IP, but `createSafeFetch()` re-resolves via `fetch()`. A malicious DNS server can return a safe IP for the check and `169.254.169.254` for the fetch. Pin the resolved IP for the actual request via a custom `lookup` function.

**9. 🔴 Encryption salt lost on process restart**
`packages/privacy/src/encryption.ts:33-58` — `encrypt()` never populates `EncryptedPayload.salt`. On restart, a new random salt produces a different key, making all previously encrypted data undecryptable. Always emit the salt in the payload and use it during decryption.

**10. 🔴 SAML XML injection in metadata/request generation**
`packages/auth/src/saml.ts:55-101,238-265` — `generateSPMetadata`/`generateAuthnRequest`/`generateLogoutRequest` interpolate `entityId`, `acsUrl`, `nameId` directly into XML without escaping. `nameId` is user-controlled. XML-escape all interpolated values (`&`, `<`, `>`, `"`, `'`).

**11. 🔴 Upload trusts client MIME type — no magic byte verification**
`packages/api/src/upload.ts:52-80` — `file.type` comes from the browser's `Content-Type` (trivially spoofed). An attacker uploads a malicious file with `image/png` MIME. Add server-side magic-byte verification (e.g., `file-type` library), `Content-Disposition: attachment`, and `X-Content-Type-Options: nosniff`.

**12. 🔴 RSS `item.custom` allows arbitrary XML element names — injection**
`packages/rss/src/index.ts:84-88` — `<${key}>${escapeXml(value)}</${key}>` — the `key` (element name) is not validated. A key like `foo></item><item><script>...` injects arbitrary XML. Validate `key` against `/^[a-zA-Z_][a-zA-Z0-9_.-]*$/`.

**13. 🔴 OG response missing `nosniff` header + no depth limit**
`packages/og/src/index.ts:85,108-123` — Body is serialized JSON but `Content-Type: image/png` with no `X-Content-Type-Options: nosniff`. Browsers may content-sniff as HTML. `serializeElement` has no depth cap — deep trees cause stack overflow. Add `nosniff` header and a max depth (e.g., 100).

**14. 🔴 CCPA opt-out cookie is forgeable (no HMAC)**
`packages/privacy/src/ccpa.ts:95` — `Set-Cookie: __pledge_ccpa_opt_out=true` is a plain boolean with no signature. A client can forge it to `false` to re-enable data selling. HMAC-sign the cookie like `ConsentManager` does.

**15. 🔴 Transport security trusts `X-Forwarded-Proto` by default**
`packages/privacy/src/transport.ts:41,83-85` — `trustProxy` defaults to `true`. An attacker sets `X-Forwarded-Proto: https` to bypass HTTPS redirect. Default `trustProxy` to `false` and document that it must only be enabled behind a trusted reverse proxy.

---

## Tier 2 — Server Reliability & Request Safety

**16. 🟠 No request body size limit (DoS / memory exhaustion)**
`packages/server/src/node.ts:107-114`, `edge.ts:36-38`, `handler.ts:279-288` — Body is read in an unbounded loop with no max-size check. A malicious client POSTs 10GB, exhausting memory before the handler runs. Add a configurable `maxBodySize` (default 1MB) and reject with 413 on overflow.

**17. 🟠 `withTimeout` doesn't cancel work — no AbortController**
`packages/server/src/handler.ts:799-801` — `withTimeout` rejects the outer promise on timeout, but the underlying handler (rendering, DB calls) continues consuming CPU/memory. Pass an `AbortSignal` down to the handler and propagate cancellation.

**18. 🟠 Server action 500 leaks `err.message` to client**
`packages/server/src/handler.ts:297-303` — `body: JSON.stringify({ message: err.message })` leaks internal error details (stack traces, DB errors, file paths). In production, return a generic message and log the full error server-side.

**19. 🟠 Dev error page XSS via unescaped error messages**
`packages/server/src/node.ts:193` — `${String(err).replace(/</g, '<')}` only escapes `<`, not `>` or quotes. If an attacker can influence the error content, this is an XSS vector. Escape all HTML metacharacters or use `textContent`.

**20. 🟠 CSRF protection silently disabled when `securityHeaders === false`**
`packages/server/src/handler.ts:259,418` — CSRF check is gated on `config.securityHeaders !== false`. Disabling headers silently disables CSRF. Decouple CSRF from security headers — CSRF should be a separate config flag.

**21. 🟠 Request ID from client header without sanitization (log injection)**
`packages/server/src/handler.ts:232` — `req.headers['x-request-id']` is used directly. An attacker injects newlines or JSON-breaking characters for log poisoning. Sanitize/validate the format (e.g., UUID pattern) before using.

**22. 🟠 Middleware rewrite open redirect**
`packages/server/src/handler.ts:337` — `new URL(mwResult.rewrite, req.url.origin)` — if `mwResult.rewrite` is an absolute URL (`https://evil.com/path`), the rewrite silently redirects to an external origin. Validate that rewrites stay same-origin.

**23. 🟠 Health `degraded` returns HTTP 200, not 503**
`packages/server/src/health.ts:75` — Degraded status returns 200. Load balancers won't remove degraded instances. Return 503 for `degraded` so LBs drain traffic.

**24. 🟠 Brute force protection is per-worker (in-process Map)**
`packages/server/src/safety-net.ts:134` — `attemptStore` is an in-process `Map`. In clustered deployments, effective max attempts = `maxAttempts × workerCount`. Use a shared store (Redis, KV) or document the limitation.

**25. 🟠 WebSocket upgrade doesn't validate `Origin` header**
`packages/server/src/node.ts:217-223` — Any origin can initiate a WebSocket connection (CSRF-WS). It also `socket.destroy()`s without an HTTP error response. Validate `Origin` against an allowlist and send a 403 before destroying.

**26. 🟠 Edge handler doesn't decode base64 binary + has no error handling**
`packages/server/src/edge.ts:24-53` — Unlike `node.ts`, the edge handler never handles `result.isBase64`, so OG images and binary downloads return corrupted bodies. It also has no try/catch — if `handler()` throws, the unhandled rejection crashes the edge worker.

**27. 🟠 Image optimization params not bounded (DoS)**
`packages/server/src/virtual-modules.ts:151-154` — `width`, `height`, `quality` are parsed with `parseInt` but not bounded. An attacker requests `?w=99999999` causing sharp to attempt a massive resize. Clamp to a max (e.g., 4096) and validate `format` against an allowlist.

**28. 🟠 ISR cache key ignores locale — serves wrong-language content**
`packages/server/src/handler.ts:688` — `const isrKey = req.url.pathname` doesn't include the locale. Different locales sharing the same pathname get the same cache entry. Include locale in the cache key.

**29. 🟠 `ensureContext()` race condition on concurrent first requests**
`packages/server/src/handler.ts:117,150-212` — `localCtx` is a mutable module-level variable. Two concurrent first-requests both see `null` and both run full initialization. Guard with a promise singleton (initialize once, share the promise).

**30. 🟠 Graceful shutdown registers signal handlers but never removes them**
`packages/server/src/graceful-shutdown.ts:104-105` — `process.on('SIGTERM'/'SIGINT')` handlers are never removed. If `setupGracefulShutdown` is called multiple times (tests, HMR), multiple handlers fire. Also, `shutdownServers` is empty at call time — the actual server is pushed later, so early signals kill it abruptly.

---

## Tier 3 — Render, Router & Streaming Correctness

**31. 🟠 No default error boundary when `error.tsx` is absent**
All renderers (`server.ts:172`, `stream.ts:97`, `ppr.ts:63`, `hybrid-ssr.ts:95`, `rsc-stream.ts:107`, `renderer-react:202`) — Error boundaries are only added if `match.route.errorFilePath` exists. A page with no `error.tsx` that throws crashes the entire response. Wrap every render in a default boundary emitting a minimal 500 page.

**32. 🟠 ReactRendererAdapter JIT cache cross-request content leak**
`packages/renderer-react/src/index.ts:345-354` — `renderToString` uses `getCompiledTemplate(match.route.pattern)` for any route with no guard on params/searchParams. A dynamic route like `/blog/:slug` gets its first-rendered HTML cached and replayed for every slug. Gate the JIT cache behind `isCacheable` (like `server.ts:248-264`).

**33. 🟠 Streaming render timeouts never cleared / hanging requests**
`packages/core/src/render/stream.ts:181-190` — The 5s `setTimeout` fallback is never cleared when `onShellReady` fires first, causing a double-render. No timeout on `onAllReady` — a hung Suspense boundary hangs the request forever. `clearTimeout` on shell ready and add an `onAllReady` deadline.

**34. 🟠 Client navigation race condition (no AbortController)**
`packages/client/src/router.ts:230-269` — Rapid link clicks launch concurrent `fetchPageContent` calls; the last to resolve wins, which may not be the most recent navigation. No `AbortController`, no sequence token. Add abort for in-flight fetches on new navigation.

**35. 🟠 `decodeURIComponent` crash on malformed input**
`packages/core/src/router/match.ts:157-159` — `decodeURIComponent(match[i+1])` throws on malformed `%` sequences (e.g., `%zz`). A malformed path crashes the router with an unhandled exception. Wrap in try/catch and return 400/404.

**36. 🟠 SSG output missing HTML shell, no hydration script**
`packages/core/src/render/static.ts:30-36` — Output is `<!DOCTYPE html>\n${html}` with no `<head>`, no `#__pledge_root__`, no manifest, no `client.js`. SSG pages can't hydrate and lack metadata. Wrap in the full HTML shell like `generateStaticExport` does.

**37. 🟠 `compilePattern` recompiles regex on every request**
`packages/core/src/router/match.ts:142-170` — `matchRoute` calls `compilePattern(route.pattern)` for every route on every request, building a new `RegExp` each time. Compile once at router construction and cache.

**38. 🟠 `flight.ts` streaming decoder doesn't reconstruct `moduleMap`**
`packages/core/src/render/flight.ts:142-190` — The streaming decoder parses M/L chunks but discards `chunkPath` and never rebuilds `moduleMap`. `getChunks()` returns chunks with no module map, breaking client-side reference resolution for the streaming path.

---

## Tier 4 — Performance & Memory Safety

**39. 🟡 Unbounded caches across the stack (memory leaks)**
- `packages/core/src/psx/jit-templates.ts:60` — `jsProfiles` Map, no eviction
- `packages/core/src/render/isr-cache.ts:34-38` — FIFO not LRU, no TTL sweep
- `packages/client/src/router.ts:74` — `prefetchedPages` Map, full HTML strings, no cap
- `packages/server/src/metrics.ts:11-14` — counters/gauges/timings Maps, unbounded by raw path labels
- `packages/core/src/psx/kv-store.ts:46` — JS fallback KV store, no entry/size cap
- All bundler adapters — `TRANSFORM_CACHE` Map, keys include `Date.now()`, never evicted

Add max-entries + LRU eviction + TTL sweep to each. For metrics, normalize path labels (strip dynamic segments).

**40. 🟡 `/metrics` endpoint exposed with no authentication**
`packages/server/src/node.ts:84-89` — Prometheus metrics (request counts, paths, status codes, timings) are publicly accessible. Leaks route structure and traffic patterns. Require auth (bearer token or basic auth) or restrict to localhost.

**41. 🟡 KV store write amplification — full flush on every `kvSet`/`kvDelete`**
`packages/core/src/psx/kv-store.ts:68-85,119-121,131-133` — Every single `kvSet` or `kvDelete` triggers `jsFlush()`, which serializes ALL entries to JSON and writes to disk. For 10,000 entries, a single `kvSet` writes megabytes. Debounce/batch writes or use an append-only log.

**42. 🟡 WS decompression bomb — no max decompressed size**
`packages/core/src/psx/ws-compression.ts:56-61` — `inflateSync(data)` decompresses synchronously with no size limit. A small compressed input that expands to gigabytes causes immediate OOM. Enforce a max decompressed size and use async `inflate`.

**43. 🟡 WebSocket rooms: no max connections, empty topics leak, sequential send**
`packages/ws/src/index.ts:127-129,155-157,138-142` — `WSRoom.addClient` has no cap. `unsubscribe` never deletes empty topic Sets. `broadcast`/`publish` abort on first failed send. Enforce `maxConnections`, delete empty topics, wrap each send in try/catch or use `Promise.allSettled`.

**44. 🟡 WS auth accepts tokens from URL query params (log/referrer leakage)**
`packages/ws/src/auth.ts:163-165` — `query['token']` and `query['access_token']` are accepted as fallback auth. Query params appear in server logs, browser history, and `Referer` headers. Only accept tokens from headers or subprotocols.

**45. 🟡 State store listener no error isolation + `reset()` reuses reference**
`packages/state/src/store.ts:28,35` — `listeners.forEach((l) => l())` — if one listener throws, remaining listeners are never notified. `reset()` assigns the same `initialState` reference (restores mutated state). Wrap each listener in try/catch and shallow-copy initial state on reset.

---

## Tier 5 — Build, Deploy & CI/CD

**46. ⚊ No asset fingerprinting / content hashing in any bundler**
All renderers emit literal `/__pledge__/client.js` and `/__pledge__/client.css` with no content hash. `build.ts:181-208` copies public assets verbatim. Webpack (`bundler-webpack/src/index.ts:79`) uses `[name].js` with no `[contenthash]`. Same for Rsbuild, Turbopack, Rollup. Browsers/CDNs can't safely cache. Add content hashing to all bundler output and update the renderers to emit hashed filenames.

**47. ⚊ Source maps disabled in all production builds**
- `bundler-vite/src/index.ts:69,96` — `sourcemap: false` (server + client)
- `bundler-rollup/src/index.ts:81,111` — `sourcemap: false`
- `cli/scripts/build.mjs:37` — CLI itself: `sourcemap: false`
- `build.ts` never forwards `config.pledgepack.sourceMaps` to the bundler
- `config.ts:128` defaults `sourceMaps: false`

Production error stack traces are useless. Enable sourcemaps (hidden, not inline) in production builds and upload to error tracking.

**48. ⚊ Webpack minification disabled in production**
`packages/bundler-webpack/src/index.ts:110` — `optimization: { minimize: false }`. Production builds ship unminified code, significantly increasing bundle size. Enable minification for production builds.

**49. ⚊ No environment variable validation before build or start**
`packages/cli/src/commands/build.ts:30`, `start.ts`, `dev.ts:38` — `loadEnv()` loads `.env` files but never validates them. `validateEnv()`/`createEnvGuard()` exist in `packages/auth/src/env.ts` but are never called. A production build/server starts with missing `DATABASE_URL`, failing at runtime. Add `PledgeConfig.envSchema` and validate env vars at build/start.

**50. ⚊ Dockerfile broken: no pnpm, missing workspace files, unbuilt CLI, devDeps in prod image**
`Dockerfile` — `node:20-alpine` has no pnpm (no `corepack enable`). Only root `package.json` is copied (missing `pnpm-workspace.yaml` and `packages/*/package.json`). `pledge build` runs before `pnpm build:packages` (CLI `dist/` doesn't exist). Full `node_modules` (including devDeps) copied to production. `CMD ["node", ".pledge/server.js"]` doesn't match the `server/` subdirectory output. No `.dockerignore` at repo root. Fix: add `corepack enable`, copy workspace files, build CLI before app, use `pnpm install --prod` in runner, fix CMD path, add `.dockerignore`.

---

## CI/CD gaps (not in the 50, but critical for production)

Status as of 2026-09-20:

- ✅ **CI lint job** now runs `pnpm typecheck`, `pnpm lint`, `pnpm build:packages` and the release check.
- ✅ **CI runs the build** (`pnpm build:packages`) and an end-to-end smoke job.
- ✅ **CI generates coverage** (`vitest run --coverage`) and enforces the thresholds in `vitest.config.ts`.
- ✅ **CI runs the Rust crates' checks** (`cargo fmt`, `clippy`, `build`, `test` in the Rust Checks job).
- ✅ **Release workflow has a test gate** (typecheck, lint, build, test, release check) and publishes all 34 public packages through Changesets (33 in the shared-version `fixed` group; `create-pledge-app` versions independently).
- ✅ **Root `.dockerignore`** exists.

---

## Verification status

- `pnpm typecheck`: 0 errors (2026-09-21)
- `pnpm lint`: 0 errors, 76 warnings (2026-09-21)
- `pnpm test`: 1692 passing, 0 failing, 6 skipped across 206 files (2026-09-21)
- `pnpm audit`: no known vulnerabilities (2026-09-20; vitest 4.1.11)

Each of the 50 goals above was found by reading actual source files, not from
generic checklists. File paths and line numbers are accurate as of commit
`3a4dd5a` + the 2026-09-14 operational fixes and may have drifted since.
