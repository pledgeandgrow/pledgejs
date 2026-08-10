# pledgestack

## 0.1.12

### Patch Changes

- Wire all server modules into public API: CORS, virtual-modules, health, metrics, ETag, DNS rebinding, supply-chain checks, CDN purge, compression, middleware-matcher, SEO routes, OG image serving, observability, safety-net, request-id, instrumentation
- Fix `MiddlewareResult` duplicate export between `shared` and `renderer` (now defined only in `types.ts`)
- Fix `tsconfig.json` `ignoreDeprecations` value (`6.0` → `5.0` for TypeScript 5.9)
- Fix `rust-accel.ts` esbuild parse error (extract function type to type alias)
- Add missing dependencies: `pledgestack-auth` and `pledgestack-rss` to `pledgestack-server`, `pledgestack-core` to `pledgestack-adapters`
- Add missing vitest aliases for `pledgestack-ws`, `pledgestack-adapters`, renderer adapters, bundler adapters, and ESLint plugin
- Fix type errors in `handler.ts`: `safeRedirect` → `validateRedirect`, `isSameSiteRequest` signature, `validateOrigin` takes `string[]`, `req.ip` fallback, unused imports
- Fix `fetch-cache.ts` SSRF check: `isSafeUrl` is async and takes `string`, not `URL`
- Fix `virtual-modules.ts` font CSS generation to match `pledgestack-font` API
- Fix `node.ts` graceful shutdown type and use `isDev` for error detail in dev mode
- Fix `security-headers.ts` and `build.ts` `PledgeConfig` cast (`as unknown as Record`)
- Add 25 test files covering all wired features (805 total tests passing)
- Update documentation: main README, CLI README, auth README with full security suite reference

## 0.1.11

### Patch Changes

- Add 9 Rust-powered native addons: SVG-to-PNG OG images (resvg), SIMD HTML escaping, embedded KV store, cross-worker rate limiting, zero-copy static file serving (mmap), native compression, embedded full-text search, JIT hot route templates, and native WebSocket compression. All features include JS fallbacks.
