# Remaining Issues — August 2026

Follow-up to [AUDIT-AND-FIXES.md](./AUDIT-AND-FIXES.md). That document covers what was
already found and fixed (RSC streaming, Cloudflare/Lambda adapters, CSRF default, the
broken workspace typecheck, etc.), committed in `fix: RSC streaming, Rust addon
resolution, Cloudflare/Lambda adapters, CSRF default, real workspace typecheck` and
`chore: bump dev-dependency overrides for 3 newly-disclosed high-severity advisories`.

This document lists what a follow-up audit pass found in packages that first pass
did **not** touch (state, seo, a11y, sitemap, api, font, the create-pledge-app
templates, vscode-psx) — i.e. what's genuinely still left to do. Nothing here has
been fixed yet.

## Priority: High

| Bug | File | Impact |
|---|---|---|
| `setValue` corrupts state | `packages/state/src/store.ts:46-58` | With a non-identity selector (e.g. `s => s.user`), the setter does `{ ...prev, ...next }`, merging the *selected* value directly onto the *whole* state instead of writing back through the selector path. Only works by accident when the selector is the default identity. No test exercises a non-identity selector, so this ships broken. |
| JSON-LD XSS | `packages/seo/src/jsonld.ts:55-58` | `JSON.stringify(data)` is interpolated directly into a `<script type="application/ld+json">` block with no escaping of `</script>`. Any user-controlled string field (article title, product name, etc.) containing `</script><script>...` breaks out of the JSON-LD block and injects executable script. |
| `api` template is non-functional | `packages/create-pledge-app/templates/api/app/api/items/route.ts` and `.../items/[id]/route.ts` | Each route file declares its own module-scoped `const items = new Map()`. POSTing an item via `/api/items` and then GET/PATCH/DELETE via `/api/items/[id]` always 404s — the two routes never share state. The scaffolded demo is broken out of the box. |

## Priority: Medium

- **`pledgestack-sitemap`'s plugin doesn't actually generate `sitemap.xml`.** Its
  `buildEnd()` hook is just a comment claiming generation happens elsewhere;
  `generateSitemapXML`/`routesToSitemapEntries` (lines 71-132) are only ever called
  from the package's own tests, never from the plugin. Contradicts the README's claim
  that sitemap.xml is auto-generated at build time.
- **`heading-order` a11y rule never fires.** `packages/a11y/src/audit.ts:55-68` —
  the check unconditionally `return false`s; this accessibility rule can never report
  a violation. Dead code masquerading as a working check.
- **VS Code PSX debug adapter is a non-functional stub.**
  `packages/vscode-psx/src/debug-adapter.ts:130-148` — "Continue" emits a
  `terminated` event (kills the session) instead of resuming execution; `next`/
  `stepIn`/`stepOut` fake a `stopped` event without actually stepping. Not wired to
  a real lldb/gdb session despite the doc comment implying it delegates to one.

## Priority: Low / cosmetic

- `packages/api/src/nosql-injection.ts:92-97` — the "sensitive operators"
  (`$ne`, `$gt`, etc.) branch does exactly the same thing as the default branch
  below it; the special-casing is inert.
- `packages/font/src/index.ts:225` — `config.fallbackMetrics ?? webFontMetrics`
  fallback is unreachable dead code; the guard above already guarantees
  `config.fallbackMetrics` is set whenever this line runs.
- `packages/core/src/psx/multi-region.ts:276` (`routeByLatency`) — the fallback
  lookup `region.latency?.[region.id]` is wrong (`region.latency` is keyed by
  market/client-region name, not the region's own id), so it never resolves and
  always falls through to `Infinity`. No practical impact today since this module
  is not consumed anywhere (see below).

## Already known, deliberately not addressed

Carried over from `AUDIT-AND-FIXES.md` §6 — still true, still out of scope:

- **PSX Integrations** (SQLx, Redis, Argon2, image/PDF processing, etc. — 13
  wrappers in `packages/core/src/psx/integrations.ts`) have no corresponding Rust
  crate source anywhere in this repo, so they always run their JS fallback
  regardless of whether the 16 real `rust-*` native addons are compiled.
- **macOS/Linux PledgePack binaries** aren't bundled in this repo (only Windows x64
  is); those platforms rely on a postinstall download from a GitHub release.
- Several `packages/core/src/psx/*` modules (`multi-region.ts`,
  `monitoring-dashboard.ts`, `lambda-psx.ts`, `serverless-cold-start.ts`,
  `edge-durable-objects.ts`) are exported publicly but not consumed anywhere in the
  request path — breadth without integration.
- **2 `js-yaml` high-severity audit findings** (via `@changesets/cli`'s
  `read-yaml-file` dependency) left unpatched — forcing js-yaml to a patched 4.x
  would drop the 3.x `safeLoad` API `read-yaml-file` calls, risking a runtime break
  in `pledge changeset`/`version-packages` for a dev-only tool. Needs verifying
  `read-yaml-file` (or an upstream fix) before bumping.

## Verification status as of this pass

- `pnpm typecheck`: 0 errors (workspace-wide, via `scripts/typecheck-workspace.mjs`)
- `pnpm test`: 810/810 passing
- `pnpm audit --audit-level=high`: 3 findings (all `js-yaml`, see above)

None of the items in this document were exercised by that verification — they were
found by manual/agent code review, not by a failing test or type error, which is
exactly why they'd been missed until now.
