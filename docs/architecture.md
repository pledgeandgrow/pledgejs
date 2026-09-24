# Architecture

## Monorepo Structure

PledgeJS is a pnpm workspace with 36 packages organized into functional layers:

```
pledgejs/
├── packages/
│   ├── shared/          # Types, config, constants (foundation)
│   ├── core/            # Router, rendering, FS, caching, PSX toolchain
│   ├── server/          # Node + edge HTTP server runtime
│   ├── client/          # Client-side hydration, routing, hooks
│   ├── auth/            # Authentication & security (30+ modules)
│   ├── state/           # State management (store, URL state, persistence)
│   ├── api/             # API routes, validation, OpenAPI, SQL/NoSQL security
│   ├── privacy/         # GDPR, CCPA, PII redaction, retention, encryption
│   ├── ws/              # WebSocket routes, rooms, compression
│   ├── seo/             # JSON-LD, meta tags, social cards
│   ├── og/              # OpenGraph image generation (JSX → PledgePack → PNG)
│   ├── rss/             # RSS 2.0, Atom 1.0, JSON Feed 1.1
│   ├── sitemap/         # Build-time sitemap.xml + robots.txt
│   ├── image/           # Responsive image optimization
│   ├── font/            # Font optimization (Google Fonts, size-adjust)
│   ├── mdx/             # MDX plugin (frontmatter, provider wrapper)
│   ├── a11y/            # Accessibility (focus, keyboard, RTL, audit)
│   ├── overlay/         # Dev overlay (error, devtools, inspectors)
│   ├── content/         # Content collections (schema validation, markdown)
│   ├── adapters/        # Edge bundle config (Cloudflare/Vercel/Deno/Lambda)
│   ├── deploy/          # One-command deploy (Cloudflare/Vercel/Netlify)
│   ├── cli/             # CLI entrypoint (dev, build, start, test, etc.)
│   ├── renderer-react/  # React 19 renderer (SSR/RSC/streaming/PPR)
│   ├── renderer-vue/    # Vue renderer adapter
│   ├── renderer-solid/  # Solid renderer adapter
│   ├── renderer-svelte/ # Svelte renderer adapter
│   ├── bundler-pledgepack/  # Default bundler (Rust binary)
│   ├── bundler-vite/        # Vite adapter
│   ├── bundler-rollup/      # Rollup adapter
│   ├── bundler-webpack/     # Webpack adapter
│   ├── bundler-rsbuild/     # Rsbuild adapter
│   ├── bundler-turbopack/   # Turbopack adapter
│   ├── create-pledge-app/   # Project scaffolding
│   ├── eslint-plugin-pledge/ # ESLint rules
│   ├── vscode-extension/    # VS Code extension
│   └── vscode-psx/          # PSX language server
├── docs/                # This documentation
├── scripts/             # Build/typecheck scripts
└── .github/workflows/   # CI, release, audit workflows
```

## Package Dependency Graph

```
                    shared (types, config)
                       ↑
              ┌────────┼────────┐
              ↓        ↓        ↓
            core    server    client
              ↑        ↑        ↑
    ┌─────────┼────┐   │   ┌────┘
    ↓    ↓    ↓    ↓   ↓   ↓
  auth  api  ws  state  renderer-react
  privacy  seo  og  rss  sitemap  image
  font  mdx  a11y  overlay  content
  adapters  deploy
              ↑
              ↓
            cli (bundles everything via esbuild)
```

The CLI package is the integration point — it bundles all packages via esbuild
into a single distributable `pledgestack` npm package. The root `tsconfig.json`
provides path aliases that resolve all `pledgestack-*` imports to source files
for typechecking, so project references aren't needed for `tsc --noEmit -p`.

## Rendering Pipeline

```
Request → handler.ts
           ↓
         matchRoute(pathname, routes)  → RouteMatch | null
           ↓
    ┌──────┴──────┐
    ↓              ↓
  API route     Page route
    ↓              ↓
  handler     renderer.renderToStream()
    ↓              ↓
  response    ┌──────┴──────┐
              ↓              ↓
         RSC mode      SSR mode
              ↓              ↓
        flight.ts     stream.ts / hybrid-ssr.ts
              ↓              ↓
        RSC payload    HTML stream
              ↓              ↓
              └──────┬───────┘
                     ↓
              wrapStreamHtml() → Response
```

### Rendering Modes

| Mode | Description | When |
|------|-------------|------|
| **SSR** | Server-side render to HTML via `renderToPipeableStream` | Default |
| **SSG** | Static generation at build time via `generateStaticPages` | `output: 'export'` |
| **RSC** | React Server Components via flight protocol | `rsc: true` (default) |
| **Streaming** | Progressive HTML streaming with Suspense boundaries | Always (SSR uses streaming) |
| **PPR** | Partial Prerendering — static shell + dynamic holes | `ppr: true` |
| **ISR** | Incremental Static Regeneration with stale-while-revalidate | Route-level `revalidate` |

### Rust Acceleration

17 native Rust crates provide optional acceleration. When compiled (via
`cargo build` in `packages/core/native/`), they're loaded as NAPI addons. When
not compiled, all paths fall back to JavaScript implementations:

| Crate | Purpose | JS Fallback |
|-------|---------|-------------|
| rust-html | HTML template engine | String concatenation |
| rust-ssr | Server-side rendering | React DOM server |
| rust-rsc | RSC flight encoding | react-server-dom-webpack |
| rust-html-transformer | HTML transformation | String manipulation |
| rust-dom-renderer | DOM rendering | React DOM |
| rust-rsc-deserializer | RSC flight decoding | JSON parsing |
| rust-ssr-profiler | SSR profiling | No-op |
| rust-hydration | Hydration optimization | React DOM client |
| rust-og-renderer | OG image rasterization | Deferred to PledgePack |
| rust-kv-store | Persistent KV storage | Map + JSON file |
| rust-rate-limiter | Rate limiting | In-memory token bucket |
| rust-static-server | Static file serving | Node fs |
| rust-compression | Response compression | Node zlib |
| rust-search | Full-text search | In-memory |
| rust-jit-templates | JIT template compilation | JS Map profiler |
| rust-ws-compression | WS permessage-deflate | Node zlib |
| rust-bench | NAPI benchmark harness (`pledge bench --psx`) | JS fallback benchmarks |

## Routing System

Routes are derived from the filesystem structure in `app/`:

```
app/
├── page.tsx              → /
├── about/page.tsx        → /about
├── blog/[slug]/page.tsx  → /blog/:slug
├── docs/[...slug]/page.tsx → /docs/*slug (catch-all)
├── shop/[[...slug]]/page.tsx → /shop/*slug (optional catch-all)
├── (group)/page.tsx      → / (route group, no URL impact)
├── dashboard/@analytics/  → /dashboard (parallel route slot)
├── api/users/route.ts    → API route (not a page)
└── ws/chat/route.ts       → WebSocket route
```

### Route Specificity

Routes are scored by segment type: static (3) > dynamic `:slug` (2) >
catch-all `*rest` (1). The highest-scoring match wins, so `/blog/:slug`
beats `/blog/*rest` deterministically.

### Special Files

| File | Purpose |
|------|---------|
| `page.tsx` | Page component |
| `layout.tsx` | Layout wrapper (nested) |
| `loading.tsx` | Suspense fallback |
| `error.tsx` | Error boundary |
| `not-found.tsx` | 404 component |
| `head.tsx` | Head metadata |
| `template.tsx` | Template wrapper (re-mounts on navigation) |
| `route.ts` | API or WebSocket route |
| `middleware.ts` | Request middleware |

## Server Functions

### Server Actions (legacy)
- `serverAction()` decorator for RPC-style server functions
- Stable FNV-1a action IDs (deterministic across restarts)
- Action registry with `getServerAction()` lookup
- Error masking in production (generic message to client)

### Server Functions (TanStack Start-style)
- `createServerFn()` builder with `.validator()` and `.handler()` chains
- End-to-end type safety (client gets fully-typed proxy)
- Runtime validation at the RPC boundary
- **Middleware support** — `.middleware()` chains run before the handler
  - Each middleware receives context + `next()` to proceed
  - Can short-circuit by returning a value without calling `next()`
  - Multiple `.middleware()` calls chain in order
- **Input/output validators** — `.inputValidator()` and `.outputValidator()`
  - `inputValidator()` runs before the handler, throws on invalid input
  - `outputValidator()` runs after the handler, throws on invalid output
  - Multiple validators chain in order
  - Work with or without a `.validator()` transform
- `dispatchServerFn()` for server-side dispatch with full context
- Handler dispatches server functions first, falls back to legacy server actions

## Build System

### CLI Distribution

The CLI is built with esbuild (`packages/cli/scripts/build.mjs`), which bundles
all workspace packages into a single distributable. Source maps are enabled
for production debugging. The build:

1. Runs `tsc --build` on all sub-packages (best-effort, for `.d.ts` files)
2. Bundles JS with esbuild (using source aliases for workspace resolution)
3. Generates type declarations via `tsc -p tsconfig.emit.json`

### Typecheck

`scripts/typecheck-workspace.mjs` runs `tsc --noEmit -p` against each leaf
project. The root `tsconfig.json` path aliases resolve workspace imports to
source files, so project references aren't needed. This avoids the `tsc -b`
emit problem (which overwrites esbuild-bundled dist with tsc's extensionless
ESM output that Node can't resolve).

### Bundler Adapters

6 bundler adapters provide pluggable build/dev-server backends:

| Bundler | Build | Dev Server | Notes |
|---------|-------|------------|-------|
| PledgePack | ✅ | ✅ | Default (Rust binary) |
| Vite | ✅ | ✅ | Source maps + content hashes |
| Webpack | ✅ | ✅ | Minification + split chunks + content hashes |
| Rollup | ✅ | ❌ | Production only |
| Rsbuild | ✅ | ✅ | Rspack-based |
| Turbopack | ✅ | ✅ | Turbopack-based |

## CI/CD

### Workflows

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Lint, typecheck, build verification, tests (3 OS matrix), Rust checks |
| `release.yml` | On push to `main`: typecheck → lint → build → test → `pnpm check:release` → Changesets action (Version Packages PR, or publish to npm) |
| `audit.yml` | Security audit |

### Release Flow

1. Contributors add a changeset (`pnpm changeset`) with each PR.
2. On push to `main` the release workflow runs the full gate, then the Changesets
   action opens/updates a "Version Packages" PR (`pnpm version-packages`).
3. Merging that PR publishes every public package (`pnpm release` = build all
   packages → `scripts/check-release.mjs --dist` → `changeset publish`).
4. 34 packages are public and share one version (Changesets `fixed` group);
   versions are `0.x.y`, published under the `latest` dist-tag. Library packages ship esbuild-bundled ESM
   (`scripts/bundle-package.mjs`) plus `tsc` declarations; the CLI bundles
   everything it needs so it works on its own. The VS Code extensions are private.

## Testing

- **Framework:** Vitest 4.1.11
- **Scope:** 206 test files, 1698 tests (1692 passing, 6 skipped, 0 failing as of 2026-09-21)
- **Environment:** Node; DOM/React tests (a11y, overlay) opt into jsdom with a `// @vitest-environment jsdom` docblock
- **Coverage:** v8 provider, includes all `packages/*/src/**/*.ts`; global thresholds are enforced in `vitest.config.ts`
- **Timeout:** 15s default (30s for sccache test on Windows)
