---
"pledgestack": patch
"create-pledge-app": patch
---

Fix a batch of real bugs found by actually running the workspace's own typecheck across every package (previously the root `tsc --noEmit` and CI's "Typecheck" job only checked two small ambient `.d.ts` files, not the ~500 real source files under `packages/*/src` — `pnpm typecheck` now runs `tsc -b`/`tsc --noEmit` against every package via `scripts/typecheck-workspace.mjs`):

- RSC streaming (`renderRSCStream`) now actually delivers the flight payload progressively instead of generating it and discarding it in favor of plain SSR HTML.
- The Rust SSR acceleration path in `pledgestack-renderer-react` now resolves `pledgestack-core`'s compiled `.node` addon via real module resolution instead of a relative path that pointed at a nonexistent location — it will actually engage once `packages/core/native/build.sh` is run.
- `pledgestack-adapters`'s Cloudflare Workers adapter now calls `edge-security.ts`'s rate-limit/bot-detection/geo-restriction/CSP functions with their real signatures (it previously didn't even compile against them).
- `pledgestack-adapters`'s Lambda adapter now handles both API Gateway payload format 2.0 (what the generated SAM template's `HttpApi` actually sends) and format 1.0, instead of only reading v1 fields from a v2 payload.
- `create-pledge-app` no longer copies React-only content templates (blog/api/saas/portfolio/dashboard/ecommerce) into non-React scaffolds — it falls back to the framework's `default` template with a clear message.
- CSRF protection (`pledgestack-auth`) no longer treats a request that omits `Sec-Fetch-Site` as same-site by default, which previously let a forged cross-origin request skip Origin validation just by not sending that header.
- `PledgeConfig` gained real, typed `cdn`, `geoRestriction`, `cors`, and `csp` fields — these were previously read via unsafe `as unknown as Record<string, unknown>` casts (and, for `cdn`, called with the wrong argument count entirely).
- `pledge docker --optimized` now generates the Rust-addon-aware multi-stage Dockerfile that already existed in `pledgestack-core` but was never wired into the CLI.
- Consolidated four copies of the same HTML/XML-escaping helper (og, seo, sitemap, rss, and all four renderer adapters) into one implementation in `pledgestack-shared`.
