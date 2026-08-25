# Next 50 Goals — Make Existing Features Actually Work

Scope: **no new features.** Every item below is something the codebase *claims* to do
(via README, docstrings, exported names, or docs) but does not actually do correctly.
Found via a full-codebase audit on 2026-08-25. Ordered by severity.

Legend: 🔴 security-critical · 🟠 broken core functionality · 🟡 broken feature/CLI · ⚪ docs/coverage

> **Status update (2026-08-25):** Tiers 1, 2, AND 3 are **DONE** — all fixed, typechecked, and
> covered by regression tests. Full workspace suite: **896 tests passing** across 105 files (was
> ~813). See the "Runner-ups" section below — every item there has now been addressed.
>
> Tier 3 (runner-ups): CLI documented flags no longer crash the parser (`--framework`, `--watch`,
> `--version` added); `pledge test` no longer swallows real Vitest failures (`--passWithNoTests`);
> `pledge add/remove/update` report cargo-missing instead of faking success; `config-loader`
> surfaces malformed-config errors; `pledge analyze` resolves the native dir in real projects;
> `pledge docker --optimized` honors `--output`; `pledge storybook` picks the framework-correct
> config; `init` fixes the Windows relative-path bug; `pledge lint --fix`/`info --verbose` fixed.
> Feature packages: RSS `<guid isPermaLink>` + Atom `<updated>`/`<author>` (#rss/#atom); Google
> Fonts axis-tuple URL (#font); `binary()` base64-encodes bytes (#api); `defineApiRoute` applies
> middleware + rate limiting (#api); GraphQL `...` tokenizer (#api); `CronScheduler` accepts
> standard cron expressions (#api); `getWSUserId` is usable (#ws); overlay `renderTime === 0`
> render (#overlay); `ImageResponse`/MDX option docs made honest. Docs: README test counts, PSX
> integration count (15), CI cross-compile claim, and TypeDoc claim corrected; version drift
> aligned (0.1.12); dead `AUDIT-AND-FIXES.md` link fixed. Added coverage for previously-untested
> security modules (encryption, sql-injection, proto-pollution, webauthn, saml, consent).
>
> Tier 2 highlights: dead Pledge-System hydration reconnected (#28); edge adapters now pass request
> bodies (#29); PPR reuses its prerendered shell and threads real searchParams (#30, #32); static
> export writes correct filenames (#33); OG images resolve for dynamic routes (#34); RSC flight
> preserves its module map (#37); rust-rsc uses Fragment not `<div>` (#38); `renderRSCStream` is now
> genuinely progressive (#39); router no longer matches layouts as pages and ranks specificity
> correctly (#41, #42); Vue nests all layouts (#43); Solid/Svelte hydrate with real params (#44);
> JIT cache can't leak across requests (#45); KV fallback is crash-safe (#46); Lambda/Netlify fix
> path routing + binary bodies (#47, #48); health tri-state + metrics Prometheus format corrected
> (#49, #50). Orphaned modules (#31 rust-ppr, #35 hybrid-ssr, #36 lazy-layouts) had their bugs fixed
> and docstrings corrected to stop overclaiming.

---

## Tier 1 — Security-critical (auth, session, edge) — ✅ COMPLETE

1. 🔴 **Password hashing is a single HMAC-SHA256, no key stretching** — [auth/src/index.ts:121](packages/auth/src/index.ts) claims PBKDF2. Stolen hashes crack at billions/sec. (README also shows `await` on a sync fn.)
2. 🔴 **OAuth PKCE S256 uses HMAC over an empty message** instead of `SHA256(verifier)` — [auth/src/oauth.ts:73](packages/auth/src/oauth.ts). Every real IdP rejects the exchange; OAuth can't complete.
3. 🔴 **WebAuthn authentication never verifies the assertion signature** — [auth/src/webauthn.ts:160](packages/auth/src/webauthn.ts). Anyone with a credential ID + challenge can forge a login.
4. 🔴 **WebAuthn registration stores raw attestationObject, never extracts the COSE key** — [auth/src/webauthn.ts:147](packages/auth/src/webauthn.ts). Stored "public key" is unusable, so #3 has nothing to check against.
5. 🔴 **SAML accepts unsigned assertions by default** — `if (!config.wantSignedAssertions) return true` with `undefined` being falsy — [auth/src/saml.ts:143](packages/auth/src/saml.ts). Attacker posts unsigned XML and is authenticated.
6. 🔴 **SAML signature not bound to assertion body** (no canonicalization, DigestValue never compared) — [auth/src/saml.ts:154](packages/auth/src/saml.ts). NameID can be swapped while signature still "validates."
7. 🔴 **SAML `NotOnOrAfter` never enforced and parse never calls verify** — [auth/src/saml.ts:125](packages/auth/src/saml.ts). Expired/unsigned assertions grant identity.
8. 🔴 **JWT ES256/384/512 emit DER signatures, not raw `r‖s`** — [auth/src/jwt.ts:63](packages/auth/src/jwt.ts). Tokens are rejected by every other JWT library and vice-versa.
9. 🔴 **JWKS `n`/`e` fabricated by blindly slicing SPKI DER bytes** — [auth/src/jwt.ts:242](packages/auth/src/jwt.ts). Published JWKS is nonsense; all external verification fails.
10. 🔴 **TOTP secret has far less entropy than advertised** (overlapping bit slices, no index advance) — [auth/src/totp.ts:39](packages/auth/src/totp.ts).
11. 🔴 **Server-action endpoint has zero CSRF/origin/Sec-Fetch check** — excluded from CSRF with a comment claiming it has "its own," which doesn't exist — [server/src/handler.ts:185](packages/server/src/handler.ts). Any site can invoke actions with victim cookies.
12. 🔴 **CSRF check skipped entirely when the `Origin` header is absent** — gated on `if (origin && …)` — [server/src/handler.ts:330](packages/server/src/handler.ts).
13. 🔴 **Rate-limit & brute-force counters keyed on client-supplied `X-Request-Id`** — [server/src/handler.ts:288](packages/server/src/handler.ts). Rotate the header → fresh bucket & fresh lockout every request.
14. 🔴 **Bot detection inverted at the top end** — high-confidence bots (≥0.7) pass; only borderline 0.5–0.7 are blocked — [server/src/safety-net.ts:99](packages/server/src/safety-net.ts).
15. 🔴 **Default rate-limiter key is always `'unknown'`** (called with a hardcoded empty request) — [server/src/rate-limiter.ts:62](packages/server/src/rate-limiter.ts). One global bucket for the whole planet.
16. 🔴 **CORS disallowed-origin preflight returns 204 success**, not 403 — [server/src/cors.ts:92](packages/server/src/cors.ts).
17. 🔴 **CORS never enforced for non-preflight requests** — handler runs first, headers merged after — [server/src/cors.ts:6](packages/server/src/cors.ts). Disallowed origins still trigger side effects.
18. 🔴 **`api/upload` path traversal in the default `uniqueNames:true` path** — extension taken from untrusted filename without slash sanitization — [api/src/upload.ts:62](packages/api/src/upload.ts). Can write outside upload dir.
19. 🔴 **Privacy consent cookie is unsigned** despite "signed cookie" docstring — [privacy/src/consent.ts:39](packages/privacy/src/consent.ts). Any client forges consent to bypass gating.
20. 🔴 **GDPR CSV export is formula-injectable** (no `= + - @` escaping) — [privacy/src/gdpr.ts:176](packages/privacy/src/gdpr.ts). Attacker-controlled data executes when admin opens export.
21. 🔴 **NoSQL sanitizer lets `$ne`/`$gt`/`$regex`/`$in` through by default** — only strips `$where`/`$function`/`$expr` — [api/src/nosql-injection.ts:58](packages/api/src/nosql-injection.ts). `{password:{$ne:null}}` sails through.
22. 🔴 **Edge geo-restriction is fail-open in allowlist mode** — returns allowed when no country header — [adapters/src/edge-security.ts:355](packages/adapters/src/edge-security.ts).
23. 🔴 **Edge JWKS cache not keyed by issuer** — worker serves issuer A's keys for issuer B's tokens — [adapters/src/edge-security.ts:185](packages/adapters/src/edge-security.ts).
24. 🔴 **Edge JWT verify hardcodes RS256 and never validates `header.alg`** + base64url `atob` without char conversion — [adapters/src/edge-security.ts:219](packages/adapters/src/edge-security.ts).
25. 🔴 **Cloudflare serves assets before all four security layers** (rate-limit/bot/geo/CSP) — [adapters/src/cloudflare.ts:59](packages/adapters/src/cloudflare.ts). Asset paths bypass everything.
26. 🔴 **Edge rate-limit `Map` is unbounded** (no eviction) — [adapters/src/edge-security.ts:114](packages/adapters/src/edge-security.ts). Unique-IP scan OOMs the isolate.
27. 🔴 **PSX rate-limiter fallback is a per-worker `Map`** despite "cross-worker/shared" docs — [core/src/psx/rate-limiter.ts](packages/core/src/psx/rate-limiter.ts). Effective limit = `maxTokens × workers`.

## Tier 2 — Broken core functionality — ✅ COMPLETE

28. 🟠 **The headline "Pledge System" hydration is dead** — `pledge()` writes to `pledgeRegistry`, hydration reads a separate `componentRegistry` nothing populates — [client/src/pledge.ts](packages/client/src/pledge.ts) / [client/src/hydrate-pledges.ts:35](packages/client/src/hydrate-pledges.ts). No `pledge()` component ever hydrates.
29. 🟠 **Every edge adapter drops the request body** — `createEdgeHandler` never reads `request.body` — [server/src/edge.ts:32](packages/server/src/edge.ts). POST/PUT to Cloudflare/Vercel/Deno/Lambda/Netlify sees empty body; server actions get `args=[]`.
30. 🟠 **PPR discards the prerendered static shell and full-re-renders every request** — [core/src/render/ppr.ts:152](packages/core/src/render/ppr.ts). Defeats the entire point of PPR (no TTFB win).
31. 🟠 **rust-ppr ignores both the shell and the `holes` array** — re-renders the whole page as one blob — [core/src/render/rust-ppr.ts:314](packages/core/src/render/rust-ppr.ts).
32. 🟠 **PPR/rust-ppr always pass empty `searchParams`** — `match.pathname` never contains `?`, so `split('?')[1]` is always undefined — [core/src/render/ppr.ts:163](packages/core/src/render/ppr.ts).
33. 🟠 **Static export writes literal `:slug` filenames** — `getOutputPathWithParams` looks for `[slug]` but patterns use `:slug` — [core/src/render/static-export.ts:142](packages/core/src/render/static-export.ts). All param variants collide onto one invalid (Windows-illegal) filename.
34. 🟠 **Auto-injected OG-image URL is never routable → 404** — `renderOgImage()` is never called by any request path — [core/src/render/server.ts:141](packages/core/src/render/server.ts).
35. 🟠 **"Hybrid SSR" is never hybrid** — `renderHybrid` calls plain `renderToPipeableStream`; the real Rust/React-splitting code is dead — [core/src/render/hybrid-ssr.ts:263](packages/core/src/render/hybrid-ssr.ts).
36. 🟠 **`lazy-layouts.ts` is entirely dead code** — exported but no render path calls it; `getActiveLayouts` filter is also a no-op — [core/src/render/lazy-layouts.ts](packages/core/src/render/lazy-layouts.ts).
37. 🟠 **RSC flight encode/decode drops the moduleMap** — `decodeFlight` always returns `{}` — [core/src/render/flight.ts:39](packages/core/src/render/flight.ts). Round-trip loses all reference dedup.
38. 🟠 **rust-rsc deserializer wraps fragments in `<div>`** instead of `React.Fragment` — [core/src/render/rust-rsc-deserializer.ts:243](packages/core/src/render/rust-rsc-deserializer.ts). Breaks flex/grid/table layouts.
39. 🟠 **`rsc-stream` doesn't actually stream** — builds the ReadableStream inside `onAllReady`, after everything is buffered — [core/src/render/rsc-stream.ts:63](packages/core/src/render/rsc-stream.ts).
40. 🟠 **Streaming metadata blocks TTFB** — `renderSSRStream` returns `Promise<string>` and awaits the full `generateMetadata()`, the exact thing the `#222` comment says it avoids — [core/src/render/stream.ts:164](packages/core/src/render/stream.ts).
41. 🟠 **Router can match a layout route as a page** — `flattenRouteTree` pushes `isLayout:true` routes and `matchRoute` never filters them — [core/src/router/match.ts:142](packages/core/src/router/match.ts). Layout-only dir renders broken output instead of 404.
42. 🟠 **Route specificity scoring ties `:slug` and `*catchall`** (only static segments counted) — [core/src/router/match.ts:142](packages/core/src/router/match.ts). Resolution is file-scan-order-dependent/nondeterministic.
43. 🟠 **Vue renderer drops all but the innermost layout** — rebuilds `app` from the page each loop iteration — [renderer-vue/src/index.ts:182](packages/renderer-vue/src/index.ts).
44. 🟠 **Solid & Svelte hydrate with hardcoded empty params** on dynamic routes — [renderer-solid/src/index.ts:246](packages/renderer-solid/src/index.ts) / [renderer-svelte/src/index.ts:239](packages/renderer-svelte/src/index.ts). Hydration mismatch on every `[id]` page.
45. 🟠 **JIT template cache serves the first request's HTML to all subsequent requests** — stored raw output has no `{{param}}` markers, so `fillCompiledTemplate` returns it verbatim — [core/src/render/server.ts:239](packages/core/src/render/server.ts). Cross-request content leak.
46. 🟠 **Lambda v2 named-stage double-prefixes the path** (`/prod/prod/about`) → 404 — [adapters/src/lambda.ts:95](packages/adapters/src/lambda.ts); binary responses also corrupted (`isBase64Encoded` never set, [lambda.ts:111](packages/adapters/src/lambda.ts)).
47. 🟠 **Netlify adapter hardcodes host `netlify.app`** — breaks same-origin CSRF (#12) and redirects on every real Netlify site — [adapters/src/netlify.ts:53](packages/adapters/src/netlify.ts).
48. 🟠 **`SelectiveHydration` omits its children from SSR HTML entirely** (`hydrated` starts false, only flips in `useEffect`) — [client/src/selective-hydration.ts:141](packages/client/src/selective-hydration.ts). Breaks SEO/no-JS for wrapped content.
49. 🟠 **Health endpoint: `degraded` state is unreachable and reports `healthy` with zero checks configured** — [server/src/health.ts:47](packages/server/src/health.ts); `attachHealthCheck` also double-writes responses ([health.ts:78](packages/server/src/health.ts)).
50. 🟠 **Metrics `export()` emits malformed Prometheus** (`_sum` suffix after labels, invalid `_avg`) — Prometheus rejects the whole scrape — [server/src/metrics.ts:63](packages/server/src/metrics.ts).

---

## Runner-ups (Tier 3) — ✅ COMPLETE

- CLI: `pledge create --framework vue` **crashes** (`parseArgs` strict, no `framework` option) — [cli/src/bin.ts:5](packages/cli/src/bin.ts); `--watch`, `--fix`, `--optimized --output` are parsed-then-ignored or crash.
- CLI: `pledge test` **swallows real Vitest failures** as "no test files found" — [cli/src/commands/test.ts:77](packages/cli/src/commands/test.ts).
- CLI: `pledge lint` runs PSX-block linting, **not ESLint** as documented — [cli/src/commands/lint.ts](packages/cli/src/commands/lint.ts); `config-loader` silently swallows malformed-config errors.
- CLI: `add`/`remove`/`update` print success even when `cargo` isn't installed — [cli/src/commands/add.ts:176](packages/cli/src/commands/add.ts); `playground` fakes Rust→WASM compilation.
- `og/ImageResponse` returns JSON body labeled `image/png`; `api/response-typing.binary()` corrupts all binary data; `api/defineApiRoute` ignores `validate`/`rateLimit`/`middleware`.
- `font/buildGoogleFontsUrl` emits malformed multi-`wght=` URLs (needs axis-tuple syntax); `mdx` ignores `extensions`/`frontmatter`/`remarkPlugins`/`rehypePlugins`.
- `api/cron` + PSX cron reject standard cron expressions and silently run daily jobs every minute; `JobQueue.start()` fallback drains once and never processes later jobs.
- PSX `integrations.ts` advertises **14 Rust integrations with zero backing crates** (all `require('../../native/*.node')` unreachable); fallbacks need `pg`/`sharp`/`argon2`/`puppeteer`/`nodemailer` that aren't declared deps.
- `overlay` renders literal `"0"` when `renderTime === 0` (`&&` on a number).
- Docs: README "810 tests" is stale (813); claims CI cross-compiles 6 targets (no matrix exists); PSX integration count listed as 13/14/15 in three places; `AUDIT-AND-FIXES.md` link is dead; root pkg `0.1.11` vs CLI `0.1.12`; no `--version` flag exists.
- Zero test coverage on security-sensitive modules: `privacy/encryption.ts`, `privacy/pii.ts`, `auth/ssrf.ts`, `auth/proto-pollution.ts`, `auth/webauthn.ts`, `auth/saml.ts`, `auth/totp.ts`, `auth/oauth.ts`, `api/sql-injection.ts`, `api/nosql-injection.ts`.
- ~2100 LOC of orphaned PSX tooling (`dead-code`, `cross-compile`, `sccache`, `canary`, `rollback`, `worker-pool`, `multi-region`, `monitoring-dashboard`, `lambda-psx`, `serverless-cold-start`, `edge-durable-objects`) — exported, never wired to any command or request path.
