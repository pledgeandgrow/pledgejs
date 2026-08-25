# PledgeStack — Working vs Not-Working Status (re-audit after commit 1678b3f)

Full-codebase re-audit on 2026-08-25, after the three-tier fix commit. Six parallel
subsystem audits, verified in source. `pnpm test` = 896 passing / 105 files.

Legend: 🔴 blocks a working app · 🟠 security still open · 🟡 broken/incomplete feature · ⚪ stub/unwired · 📄 doc drift

---

## ✅ Verified working (the ~90 fixes all landed correctly)

Every fix from Tiers 1–3 is present and correct in source. Confirmed:

- **Auth crypto** — scrypt password hashing, PKCE SHA-256, JWT ES256 P1363 + real JWKS export, TOTP base32, WebAuthn CBOR/COSE + real assertion signature verification, SAML fail-closed with digest binding + NotOnOrAfter.
- **Server pipeline** — server-action CSRF, fail-closed `passesCsrf`, `clientIdentifier` (no more X-Request-Id), bot-detection gate fixed, CORS 403 preflight + wildcard-credentials reflection, `runRouteMatch` wired in, edge handler passes body, health tri-state, metrics `_sum`/`_count` placement.
- **Edge adapters** — geo fail-closed, per-issuer JWKS cache, JWT alg allow-list, bounded rate buckets, Cloudflare security-before-assets + real CSP, Lambda stage-strip + base64, Netlify real host.
- **Render/router** — layout routes no longer match as pages, weighted specificity, PPR threads searchParams + reuses shell envelope, static-export filename substitution, flight moduleMap round-trip, rust-rsc Fragment, progressive `renderRSCStream`, buffered `renderSSRStream` real head tags, JIT cache gated to static routes, OG URL from real pathname.
- **Client/renderers** — Pledge hydration reconnected (`resolvePledgeComponent`), Vue nests all layouts, Solid/Svelte emit `__PLEDGE_ROUTE__` with real params.
- **Feature packages** — RSS guid/Atom, font axis-tuple URL, api `binary()`/`defineApiRoute`/graphql tokenizer/cron/upload/nosql, privacy consent HMAC + CSV escape, ws `getWSUserId`, seo XSS, sitemap `buildEnd`, state identity-guard, a11y heading-order.
- **PSX/docs** — rate-limiter bounded + honest, KV atomic flush, README counts/PSX count/CI claim/TypeDoc/version drift/dead link all corrected.

---

## 🔴 Critical — ✅ FIXED (2026-08-25)

All eight critical end-to-end blockers are now fixed, typechecked, and the suite is green (901 tests):

1. ✅ **Server actions** — `server/src/actions.ts` now derives a **deterministic** id (portable FNV-1a hash of name + function source via `stableActionId`), so the server and client bundles produce the same id and the POST matches the registry.
2. ✅ **Binary responses** — `server/src/node.ts` decodes base64 bodies to a Buffer and sends them (the branch is now reachable); OG images and `binary()` responses work.
3. ✅ **React hydration** — the client script now rebuilds the real page+layout tree via `resolveRouteElement(routes, window.__PLEDGE_ROUTE__)` and hydrates it (the SSR now emits `__PLEDGE_ROUTE__`; the generated `/__pledge_router` re-exports the runtime).
4. ✅ **Pledge hydration** — the React client script now calls `initPledgeHydration()` after hydration.
5. ✅ **Multiple Set-Cookie** — added `PledgeResponse.cookies`; the handler extracts Set-Cookie via `getSetCookie()`, and node/edge/Lambda(v2 `cookies`)/Netlify(`multiValueHeaders`) emit them separately.
6. ✅ **Request body** — `node.ts` reads the body for any non-GET/HEAD method as a Buffer (binary-safe); the handler decodes it for JSON actions.
7. ✅ **Static export filenames** — `generateStaticExport` now writes the HTML itself at the param-substituted path; the build callback only renders. Dynamic routes no longer collide.
8. ✅ **api starter template** — `route.ts` and `[id]/route.ts` now import a shared `store.ts`, so CRUD works out of the box.

Bonus fixes in the same pass: the `405 Allow` header now lists only HTTP methods; `useRouter().params` seeds from the SSR route data.

## 🟠 Security backlog — ✅ FIXED (2026-08-25)

- ✅ **PKCE** — the `code_verifier` is now AES-256-GCM encrypted inside the state, so observers can't recover it ([oauth.ts](packages/auth/src/oauth.ts)).
- ✅ **SAML signature-wrapping** — claims are parsed only from the digest-bound assertion (chosen among all assertions by matching digest), and the issuer is checked against the configured IdP ([saml.ts](packages/auth/src/saml.ts)).
- ✅ **Edge-JWT** — checks `response.ok` before parsing JWKS, bounds the cache, handles array `aud`, and enforces `nbf` ([edge-security.ts](packages/adapters/src/edge-security.ts)).
- ✅ **Timeouts** — `withEdgeTimeout` now passes an abort signal to the handler so it's actually cancelled.
- ✅ **Sentry** — correct newline-delimited envelope to the right ingest URL with the key in `X-Sentry-Auth` (no DSN in the body) ([observability.ts](packages/server/src/observability.ts)).
- ✅ **Bundler dev-server path traversal** — all four esbuild fallback servers reject `/../` escapes.

## 🟠 Security still open (remaining, not yet addressed)

9. **PKCE defeated** — `auth/oauth.ts:91-100` embeds the `code_verifier` in the browser-visible signed `state`; anyone observing it recovers the verifier. Callback also never validates the OIDC `id_token`/`nonce`.
10. **SAML signature-wrapping** — `auth/saml.ts:127-133` extracts claims by regex over the whole document while only the first `<Assertion>` is digest-bound; a forged outer assertion yields attacker-chosen identity. No issuer/Destination/InResponseTo/audience/replay checks.
11. **Edge JWT gaps** — `adapters/edge-security.ts`: `getJwks` never checks `response.ok` (refetches on every request); `aud` compared with `!==` so array `aud` always fails; `nbf` unchecked; JWKS cache map unbounded.
12. **`withEdgeTimeout`/`withTimeout` don't cancel** — `adapters/edge-security.ts:591` and `handler.ts:722` return 504 but the handler keeps running; the server one's `finally` can wipe an unrelated request's async-local context.
13. **Sentry DSN leak + broken format** — `server/src/observability.ts:266-290` POSTs a single JSON object (not the newline-delimited envelope) and leaks the full DSN in the body; every report is rejected.
14. **Bundler dev-server path traversal** — the esbuild fallback servers in bundler-webpack/turbopack/rsbuild/rollup build the path as `join(cwd, url)` with no containment, so `GET /../../secrets.ts` reads arbitrary files.
15. **WebAuthn**: user-verification never enforced even when `required` (`webauthn.ts:264`); stored credential `userId` is always empty (`:233`).
16. **api hardening gaps** — `route.ts` rate-limit buckets never pruned (memory leak) + `x-forwarded-for` trusted unconditionally; nosql sanitizer lets `__proto__`/dotted keys through; upload MIME is client-declared (no magic-byte check).
17. **Prometheus still invalid** — `server/src/metrics.ts:17` emits unquoted label values (`{k=v}`) and dotted metric names; the scrape still fails despite the `_sum` fix.

## 🟡 Broken features — partially FIXED (2026-08-25)

- ✅ **Image optimization** — the server now serves both `/_pledge/image?src=` and `/__pledge__/image/`, does real sharp resize/convert when sharp is installed, and never mislabels content-type on passthrough ([virtual-modules.ts](packages/server/src/virtual-modules.ts)).
- ✅ **ISR** — added a stale-while-revalidate cache wired into the SSR path (pages exporting `revalidate`), with `revalidatePath()` invalidation ([isr-cache.ts](packages/core/src/render/isr-cache.ts), [handler.ts](packages/server/src/handler.ts)).
- ✅ **State package** — fixed persistence re-hydration, optimistic `serverState` propagation, derived memo, url-state/cross-tab side-effects-in-reducer, and store notify-on-identical ([packages/state/src](packages/state/src)).
- ⚠️ **OG `ImageResponse`** — still returns serialized JSX (needs a Satori render step); the file-based OG path (`opengraph-image.tsx`) works via `tryServeOgImage`.
- ⚠️ **Bundler HMR** — the path-traversal hole is closed, but the HMR no-ops (sourcemap hardcoded, `full-reload` misuse) remain (dev-experience only).

## 🟡 Broken / incomplete features (original list, for reference)

18. **Image optimization has no server** — `image/src/types.ts` only emits `/_pledge/image?...` URLs; nothing serves that path, so every `src`/`srcSet` 404s. `generateResponsiveSrcSet` also emits an invalid multi-format srcset; `generateSizesAttr('fixed')` returns `'1px'`.
19. **OG image rendering has no interceptor** — `og/src/index.ts` returns serialized JSX labeled `image/png`; nothing reads `X-Pledge-OG`, so it never becomes a PNG (docs are honest, feature is absent). Custom font bytes dropped.
20. **ISR entirely absent** — `revalidate` is only a type field; no revalidation timer / SWR / cache invalidation anywhere in `render/**`.
21. **PPR isn't streaming and can't find shells** — `render/ppr.ts:259` buffers then emits in `onAllReady`; `handler.ts:538` omits the param suffix that shells are written with, so dynamic-route shells are never found.
22. **hybrid-ssr / lazy-layouts / rust-ppr / rust-ssr / streaming-metadata** — dead code, but `server.ts` still routes SSR through `renderHybridSSR` when the (uncompiled) Rust addon exists.
23. **Route-group sibling layouts + root layout** — `router.ts` pushes every `(group)/layout` onto pattern `/` so all render on every route; `fs/resolver.ts:91` drops `app/layout.tsx` when `app/page.tsx` exists (root layout never renders).
24. **Client router broken** — `client/src/router.ts`: `swapRootContent` never re-hydrates (pledges/islands dead after navigation), `params` always `{}`, `prefetchedPages` unbounded/never-invalidated (stale HTML), content extraction keys off a literal `</div>\n  <script`.
25. **Non-React 404 pages skip layouts** — Vue/Solid/Svelte `renderNotFound` don't run the layout chain; Vue's client script still hydrates by exact pathname with empty props; Solid/Svelte hydrate only the page (not layout-wrapped SSR) → mismatch.
26. **selective-hydration / islands render empty SSR** — content dropped until JS runs (blank + layout shift); `concurrent.ts` `useDeferredState` misuses React 19's `initialValue` param; `client-only.ts` throws unconditionally; `fast-refresh.ts` calls a non-existent runtime export.
27. **Bundler HMR is no-ops** — vite/rollup hardcode `sourcemap:false`; vite/webpack "reload" broadcasts a Vite-only `full-reload` (webpack) or forces full reload on targeted reload (vite); turbopack fallback has no HMR; `collectRouteFiles` compiles every `.ts` under `app/` as an entry (all 6 adapters).
28. **state package** — persistence re-hydrates every render (clobbers live state); optimistic ignores later `serverState`; derived memo defeated; url-state/cross-tab run side effects inside the reducer + seed from browser storage (SSR mismatch); store notifies on identical values.
29. **Misc** — i18n redirect drops query string (`handler.ts:414`); middleware rewrite doesn't refresh `pledgeReq.url/query`; ETag only on the non-streaming path; 405 `Allow` lists non-HTTP exports; a11y audit is O(n²) + SVG-unsafe; overlay `devtools.ts` still truthy-checks `renderTime`/`loadTime` (0ms → `-`) and injects a `/__pledge/devtools` script nothing serves; rss `item.custom` keys unescaped; encryption never returns its random salt (unrecoverable after restart).

## ⚪ Stubs — partially hardened (2026-08-25)

- ✅ **PSX unguarded native calls** — `SqlxPool.transaction`, `SqlxTransaction.query`, Redis `subscribe`/`publish`, and `PdfGenerator.fromTemplate` now throw a clear, actionable error via `loadNativeAddon()` instead of a cryptic `MODULE_NOT_FOUND` crash ([integrations.ts](packages/core/src/psx/integrations.ts)).
- ✅ **Optional deps** — documented in core's package.json as intentionally-undeclared optional runtime packages (declaring them as peers made pnpm auto-install heavy native modules); each is dynamically imported with a clear error when missing.
- ⚠️ **Still stubs** (advertised, no backing implementation — would need real work): the 15 integrations have no Rust crates; `pledge playground` simulates Rust→WASM; `pledge bench --psx` targets a nonexistent addon. These are honestly labeled in their output/docs.

## ⚪ Stubs & unwired (original list, for reference)

30. **The 15 "PSX Integrations" have zero backing Rust crates** — `native/Cargo.toml` lists 16 members, none of which are sqlx/redis/auth/image/pdf/jobs/cron/email/etc. Every `require('../../native/X.node')` is unreachable; several call it **unguarded** (PdfGenerator.fromTemplate/invoice, SqlxPool.transaction, MlModel.infer, Redis pub/sub) → hard throw instead of JS fallback. Fallbacks need `pg`/`sharp`/`argon2`/`puppeteer`/`nodemailer`/`xlsx`, still undeclared in `core/package.json`. JobQueue.start drains once; parseCronToInterval silently defaults unparsed expressions to every-60s.
31. **`pledge playground`** — Rust→WASM compile/execute/save are all simulated (fabricated results).
32. **`pledge bench --psx`** — targets a nonexistent `rust-bench.node` with a wrong `@pledgestack/core` specifier; always "No addon found"; NAPI overhead is a fabricated 10%-of-TS number.
33. **Orphaned PSX modules** — multi-region, monitoring-dashboard, lambda-psx, serverless-cold-start, edge-durable-objects, worker-pool, rollback, canary, dead-code, cross-compile, sccache, jit-templates: exported, never wired to any command/request path.
34. **Native jit-templates hash logic wrong** — `native/rust-jit-templates/src/lib.rs:64` compares only the last hash, initializes to 0 (false positive), and f64→u64 casts collide above 2^53.
35. **`pledge upgrade`** — codemod path is dead (`minVersion > from` never true for shipped versions); only bumps `pledgestack`, not core/renderers; swallows codemod errors.
36. **`pledge init --skip-install`** — no-op (init never installs); `pledge create` has 3 templates vs the documented 7 (`-t dashboard` silently yields default); vscode-psx debug adapter fakes stepping; `env-check.ts` exported but unreachable.

## 📄 Doc drift still present

37. **`REMAINING-ISSUES.md:56` still says "13 wrappers"** while README says 15.
38. **`NEXT-50-GOALS.md`** describes the doc defects (810 tests, CI cross-compile, dead link, version drift) in present tense as open, though they're fixed — the file is stale relative to the fix commit.
39. Workspace versions remain unsynced across packages (0.0.1 … 0.2.8); no stated versioning policy.

---

## Bottom line

The three tiers did exactly what they targeted — every one of those ~90 fixes is verified correct, and the security primitives (auth crypto, CSRF, edge hardening) are genuinely fixed. But this re-audit reached deeper into paths the tiers didn't touch and found the framework **still can't serve a working app end-to-end**: server actions 404, the Node server drops binary bodies, the React client hydrates an empty tree, and multiple cookies collapse. Below that sit a large security backlog (PKCE/SAML/edge-JWT), broken core features (image, OG, ISR, PPR, client router, state), and a wide stub layer (15 Rust integrations with no crates, playground/bench simulations). The green test suite (896) covers unit behavior of the fixed pieces, not these end-to-end paths.
