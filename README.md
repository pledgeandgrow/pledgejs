# PledgeStack

[![npm version](https://img.shields.io/npm/v/pledgestack.svg)](https://www.npmjs.com/package/pledgestack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A full-stack **multi-framework** web framework with file-based routing, SSR/SSG/ISR, React Server Components, API routes, middleware, edge runtime support, and Rust native addons for rendering, compression, search, rate limiting, and more. Supports **React, Vue, Solid, and Svelte** via pluggable renderer adapters. Uses PledgePack (Rust+Zig bundler) to build user apps.

> **90 test files · 805 tests · 39 packages** — all passing.

## Requirements

- **Node.js** >= 20.0.0
- **pnpm** >= 11.x (monorepo workspace)
- **Rust toolchain** (optional — for PSX native addons; JS fallbacks exist)

## Framework Support

PledgeStack is framework-agnostic. The core runtime (routing, SSR, API routes, middleware, caching) works with any UI framework via renderer adapters:

| Framework | Package | RSC | SSR | Streaming | PPR | Status |
|---|---|---|---|---|---|---|
| **React** | `pledgestack-renderer-react` | ✅ | ✅ | ✅ | ✅ | Full support |
| **Vue** | `pledgestack-renderer-vue` | ❌ | ✅ | ⚠️ | ✅ | SSR + hydration |
| **Solid** | `pledgestack-renderer-solid` | ❌ | ✅ | ⚠️ | ✅ | SSR + hydration |
| **Svelte** | `pledgestack-renderer-svelte` | ❌ | ✅ | ⚠️ | ✅ | SSR + hydration |

**RSC (React Server Components)** is React-only. Other frameworks use standard SSR with hydration.

**Streaming** for Vue/Solid/Svelte uses async SSR (no Suspense-style progressive streaming). React uses `renderToPipeableStream` with Suspense boundaries for true progressive streaming.

## Install

```bash
npm install pledgestack
# or
pnpm add pledgestack
```

The CLI command is `pledge` (not `pledgestack`). After installing:

```bash
npx pledge dev      # Start dev server
npx pledge build    # Build for production
npx pledge start    # Start production server
```

## CLI Commands

| Command | Description |
|---|---|
| `pledge dev` | Start dev server with HMR |
| `pledge build` | Build for production (PledgePack bundler) |
| `pledge start` | Start production server |
| `pledge create <name>` | Scaffold a new project from template |
| `pledge init` | Initialize PledgeStack in existing project |
| `pledge info` | Show project diagnostics |
| `pledge doctor` | Health checks (Rust toolchain, Cargo, env, production readiness) |
| `pledge lint` | Run ESLint with PledgeStack rules |
| `pledge typecheck` | TypeScript type checking |
| `pledge test` | Run Vitest + Rust test runner |
| `pledge clean` | Remove build artifacts and caches |
| `pledge add <crate>` | Add a Rust crate (PSX integration) |
| `pledge remove <crate>` | Remove a Rust crate |
| `pledge list` | List installed Rust crates |
| `pledge update <crate>` | Update a Rust crate |
| `pledge analyze` | Bundle analysis — per-module `.node` size breakdown |
| `pledge bench` | Benchmark Rust addons vs JS fallbacks |
| `pledge fmt` | Format Rust code (cargo fmt) |
| `pledge docs` | Generate API reference (TypeDoc) |
| `pledge upgrade` | Upgrade PledgeStack with codemods |
| `pledge why <module>` | Trace why a module is in the bundle |
| `pledge docker` | Generate Dockerfile, .dockerignore, docker-compose.yml |
| `pledge storybook` | Set up Storybook |
| `pledge codemod` | Run code transformations (list available codemods with no args) |
| `pledge sync-aliases` | Sync tsconfig path aliases |
| `pledge generate-route-types` | Generate typed route declarations |
| `pledge check-routes` | Detect route conflicts |
| `pledge search [query]` | Index pages and search content (embedded full-text search) |

## What's Actually Implemented

### Core Runtime

- **Multi-Framework** — Pluggable renderer adapter system supports React, Vue, Solid, and Svelte. Set `framework` in `pledge.config.ts` and install the corresponding `pledgestack-renderer-*` package. The core routing, caching, and middleware are framework-agnostic.
- **Config Validation** — `pledge.config.ts` is validated at load time. Invalid values (unknown runtime, invalid output mode, invalid bundler, etc.) produce clear error messages before the server starts.
- **File-based routing** — `page.tsx`/`page.vue`/`page.svelte`, `layout.*`, `route.ts`, `loading.*`, `error.*`, `not-found.*`, `template.*`, `head.*`, `opengraph-image.*`, `twitter-image.*`
- **Route patterns** — Dynamic segments `[param]`, catch-all `[...param]`, optional catch-all `[[...param]]`, route groups `(group)`, parallel routes `@slot`, intercepting routes `(..)folder`
- **Server-Side Rendering** — `renderSSR()` with layout chains, error boundaries, Suspense loading states (React), streaming SSR. Each renderer adapter implements its own SSR via the framework's native APIs.
- **Static Site Generation** — `generateStaticParams` pre-rendering, `static-export` mode
- **React Server Components** — `react-server-dom-webpack` integration, flight payload generation, RSC streaming, client manifests (React only)
- **Partial Prerendering (PPR)** — Static shell prerendered at build time, dynamic holes streamed at request time. Rust-based PPR via `rust-ppr.ts` with JS fallback. Set `ppr: true` in config.
- **API Routes** — `route.ts` with `GET`, `POST`, `PUT`, `DELETE`, `PATCH` handlers. CORS middleware and XSS sanitization auto-applied.
- **Middleware** — `middleware.ts` with redirect (open-redirect validated), rewrite, headers, short-circuit, matcher config (glob patterns, param patterns, regex)
- **Server Actions** — `serverAction()`, `getServerAction()`, `useActionState` hook (React only). CSRF token validation on POST/PUT/DELETE/PATCH (excluding server actions).
- **Server Utilities** — `cookies()`, `headers()`, `searchParams()`, `params()`, `redirect()`, `notFound()`, `after()`, `connection()`, `draftMode()`
- **Security Headers** — Auto-applied `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, HSTS (HTTPS), Content-Security-Policy (with custom directive support). Set `securityHeaders: true` (default) in config.
- **JIT Templates** — Hot route template compiler profiles SSR renders and compiles frequently-rendered routes to native functions that bypass React reconciliation. Uses `rust-jit-templates` NAPI addon with JS fallback.
- **Error Rendering** — 500-level errors render a proper HTML error page (via `renderErrorPage`) instead of plain text. Error boundary fallback for missing page modules.

### Data & Caching

- **Fetch Cache** — `cachedFetch()` with `force-cache`, `no-store`, `isr` modes, tag-based revalidation. LRU eviction when cache exceeds max entries (10,000 default). Periodic cleanup of expired entries.
- **Cache Invalidation** — `revalidateTag()`, `revalidatePath()`, persistent cache, remote cache, cache-invalidation worker
- **Query Memoization** — Deduplication of identical data fetches per request
- **Edge Cache** — Multi-region edge caching with invalidation
- **SSRF Protection** — Server-side fetch validates URLs against private/internal address ranges before fetching

### SEO & Metadata

- **Metadata API** — `export const metadata` and `export function generateMetadata()` on pages and layouts
- **Metadata Merging** — Layout-to-page inheritance: page wins on scalar conflicts, arrays concatenated, objects merged
- **Viewport API** — `export const viewport` and `export function generateViewport()` with layout inheritance
- **Head Tags** — Shared `renderHeadTags()` module: title, description, keywords, robots, theme-color, OpenGraph (title/description/images/url/type/siteName), Twitter cards (card/title/description/images/site/creator), canonical, icons, JSON-LD structured data
- **robots.txt** — Automatic serving from `public/robots.txt` or dynamic generation via `pledgestack-sitemap`
- **sitemap.xml** — Automatic serving from `public/sitemap.xml` or dynamic generation from route tree
- **RSS Feeds** — Automatic serving at `/rss.xml`, `/feed.xml`, `/atom.xml`, `/feed.json` from `public/` or dynamic generation from `app/feed.ts` via `pledgestack-rss`. Supports RSS 2.0, Atom 1.0, and JSON Feed 1.1 formats.
- **OG Image Generation** — `opengraph-image.tsx` and `twitter-image.tsx` file conventions; React component rendered to SVG then rasterized to **PNG** via native resvg addon (falls back to SVG); auto-injects `og:image` and `twitter:image` meta tags
- **JSON-LD** — `structuredData` field in `HeadMetadata` renders `<script type="application/ld+json">`
- **SEO Package** — `pledgestack-seo` with `jsonld.ts`, `meta-tags.ts`, `social-cards.ts`

### Client-Side

- **Client Router** — `useRouter()`, `Link` with hover prefetch, scroll restoration, `replace`/`scroll` options
- **Hydration** — `hydrate.ts`, selective hydration, island hydration, Rust hydration script generator
- **Fast Refresh** — HMR with React Fast Refresh integration
- **State Management** — `pledgestack-state` with store, derived, optimistic, persistence, cross-tab sync, URL state, form state, devtools
- **Data Hooks** — `useInfiniteQuery`, `usePaginatedQuery`, `useSubscription`, `useRustQuery`, offline-first data layer
- **Web Vitals** — Client-side CWV reporting
- **Error Overlay** — Dev error overlay with telemetry, auto-injected in dev mode
- **DevTools** — `pledgestack-overlay` with component inspector, element picker, cache inspector. Auto-injected via HTML transform in dev mode.
- **Dev Toolbar** — In-browser dev toolbar

### Security & Privacy

- **Security Headers** — CSP (with custom directives support), CORS (configurable origins/methods), X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, HSTS (HTTPS only). Auto-applied to all responses; user/middleware headers take precedence.
- **Auth Package** — OAuth 2.1, JWT, TOTP/2FA, WebAuthn, RBAC, ABAC, API keys, SAML SSO, session management, audit log
- **Vulnerability Protection** — XSS sanitization (API route responses), CSRF token validation (POST/PUT/DELETE/PATCH), path traversal prevention (static file serving), SSRF protection (server-side fetch), open redirect validation (middleware redirects), ReDoS, prototype pollution, clickjacking, DNS rebinding protection
- **Privacy Package** — GDPR, CCPA, PII redaction, encryption, consent management, data retention, compliance docs
- **Safety Net** — Input validation, output serialization, rate limiting (token bucket), bot detection with challenge response, brute force protection with periodic store cleanup, body limits

### Edge & Adapters

- **Edge Runtime** — Edge handler for Cloudflare Workers, Vercel Edge, Deno Deploy
- **Adapters** — `pledgestack-adapters` with Cloudflare, Vercel, Deno, AWS Lambda, Netlify, edge-security
- **Standalone Output** — Docker-ready standalone build
- **Health Checks** — `/health` endpoint with configurable checks (database, cache, etc.), returns healthy/degraded/unhealthy status with HTTP 200/503
- **Metrics** — `/metrics` endpoint with Prometheus-format export, request counters, response timings, histograms
- **Graceful Shutdown** — Tracks in-flight requests on SIGTERM/SIGINT, waits for completion before closing server, configurable timeout
- **DNS Rebinding Protection** — Validates Host header against allowlist, blocks unknown hosts
- **WebSocket Server** — `pledgestack-ws` with WebSocket route handling, pub/sub rooms, native permessage-deflate compression

### Rust Native Addons (PSX)

16 NAPI addon crates in `packages/core/native/` with automatic JS fallback when not compiled:

**Rendering:**
- **rust-html** — HTML string renderer with SIMD-accelerated escaping (SSE2 16-byte chunk scanning)
- **rust-ssr** — Server-side rendering
- **rust-rsc** — RSC payload generation
- **rust-html-transformer** — Streaming HTML transformer
- **rust-dom-renderer** — React DOM string renderer
- **rust-rsc-deserializer** — RSC client deserializer
- **rust-ssr-profiler** — SSR profiling with flamegraphs
- **rust-hydration** — Native hydration script generator

**Performance & Infrastructure:**
- **rust-og-renderer** — Native SVG-to-PNG rasterization via resvg + tiny-skia (produces real PNG OG images that all social platforms render)
- **rust-kv-store** — Embedded persistent key-value store for ISR/fetch cache (eliminates Redis dependency)
- **rust-rate-limiter** — Cross-worker rate limiting via shared-memory token bucket (works across Node.js worker threads)
- **rust-static-server** — Zero-copy static file serving via memory-mapped I/O (mmap). Static files include `Cache-Control` (immutable for hashed assets, `max-age` for others) and `ETag` headers. Path traversal protection rejects `..` and null bytes.
- **rust-compression** — Native gzip/deflate compression with SIMD-accelerated flate2 (response middleware)
- **rust-search** — Embedded full-text search engine with inverted index (no Elasticsearch needed; `pledge search` CLI)
- **rust-jit-templates** — JIT hot route template compiler — profiles SSR routes and compiles hot templates to native functions
- **rust-ws-compression** — Native WebSocket permessage-deflate compression with SIMD acceleration

### PSX Integrations (15 wrappers with JS fallback)

SQLx, Redis, Auth (Argon2/JWT), Image processing, PDF generation, Background jobs (apalis), Cron scheduler, Email (lettre), HTTP client (reqwest), WebSocket, File processing (Excel/CSV), Tracing/OpenTelemetry, Crypto (AES-GCM/SHA-256), ML inference (candle-core/ort)

### PSX Tooling

- **Audit Logging** — `PsxAuditLogger` with sanitized args, execution time, route tagging, file rotation, sample rate
- **Bundle Analysis** — `pledge analyze` with per-module `.node` size breakdown, crate alternatives, build-to-build tracking
- **CI/CD** — GitHub Actions: `cargo audit`, `cargo clippy`, `cargo fmt`, cross-compile for 6 targets, Vitest
- **Production Checklist** — `pledge doctor --production`
- **Cross-Compilation** — 6 targets (x86_64-linux-gnu, aarch64-linux-gnu, x86_64-darwin, aarch64-darwin, x86_64-windows-msvc, aarch64-windows-msvc)
- **sccache** — Cross-project compilation caching
- **Lazy Compilation** — Deferred Rust compilation
- **Dead Code Elimination** — Tree shaking for Rust crates
- **Version Compatibility** — Crate pinning and version compatibility checks
- **Syn Parser** — Rust syntax parser for PSX files
- **Debugger** — PSX debug session support

### Developer Experience

- **Plugin System** — `PledgePlugin` with `configResolved`, `buildStart`, `buildEnd`, `configureServer`, `renderStart`, `renderEnd`, `routeMatch`, `fetchIntercept`, `transformHtml`, `transformClientBundle` hooks. `PluginRunner` chains hooks in order; `buildStart`/`buildEnd` wired into `pledge build`.
- **ESLint Plugin** — `eslint-plugin-pledge` with PledgeStack-specific lint rules
- **VS Code Extension** — Syntax highlighting, IntelliSense, snippets, file icon theme
- **VS Code PSX Extension** — PSX language support, syntaxes, language configuration
- **Type-Safe Routes** — `pledge generate-route-types` auto-generates typed route declarations
- **Route Conflict Detection** — `pledge check-routes`
- **Path Aliases** — `@/app/*`, `@/lib/*`, `@/components/*`, `@/styles/*`, `@/utils/*` (configurable)
- **Tailwind CSS** — Built-in Tailwind v4 + PostCSS pipeline
- **MDX Support** — `pledgestack-mdx` plugin; `.mdx` files compiled to JSX with frontmatter extraction, inline formatting, and embedded component support. Wired into module transform pipeline.
- **Image Optimization** — `pledgestack-image` component with responsive `srcset`, WebP/AVIF, blur placeholder, priority loading. Optimization endpoint at `/__pledge__/image/:path`.
- **Font Optimization** — `pledgestack-font` with Google Fonts integration, preload links, `@font-face` CSS generation, fallback stacks. Optimization endpoint at `/__pledge__/font/:family`.
- **RSS Feed** — `pledgestack-rss` with RSS 2.0, Atom 1.0, and JSON Feed 1.1 generation. Auto-served at `/rss.xml`, `/atom.xml`, `/feed.json`.
- **WebSocket** — `pledgestack-ws` with route handlers, pub/sub rooms, native compression. Upgrade handler wired into Node server.
- **A11y Audit** — `pledgestack-a11y`
- **Storybook** — `pledge storybook` setup
- **DevTools Overlay** — `pledgestack-overlay` with error overlay, component inspector, cache inspector. Auto-injected in dev mode via HTML transform.
- **Observability** — Structured JSON logging, OpenTelemetry tracing (span per request with HTTP method/url attributes), metrics export (Prometheus format), Sentry/Bugsnag error tracking, request ID middleware, slow request detection, monitoring dashboard
- **Supply Chain** — SBOM generation (CycloneDX/SPDX) wired into `pledge build`, dependency audit CI, license compliance, pinned deps, provenance attestation, Sigstore signing, secret scanning
- **CDN Purge** — Post-build CDN cache purge hook wired into `pledge build` (triggered when `cdn` config is set)
- **i18n** — Locale extraction from pathnames, `as-needed`/`always` prefix strategies, Accept-Language detection, `createTranslator` with interpolation. Wired into handler request pipeline and render context.
- **CORS** — Configurable CORS middleware for API routes with preflight handling
- **ETag** — Automatic ETag generation for SSR responses with `If-None-Match` → 304 Not Modified support
- **Request Timeout** — Configurable request timeout returning 504 Gateway Timeout
- **HTML Error Pages** — Proper HTML error page rendering for 500-level errors instead of plain text

### Testing

90 test files across the monorepo using Vitest (805 tests, all passing):

- **PSX Integration tests** — Fallback behavior for all 15 Rust wrappers
- **Render tests** — `rust-html`, `rust-ssr`, `rust-rsc`, `rust-dom-renderer`, `rust-html-transformer`, `rust-hydration`, `rust-ssr-profiler`, PPR, JIT templates
- **Security tests** — CSRF, JWT, open redirect, XSS, path traversal, SSRF, security headers (with CSP), DNS rebinding, bot detection, rate limiter
- **Server tests** — Health checks, metrics, ETag, compression, graceful shutdown, brute force store cleanup, middleware matcher, server actions, supply chain/SBOM
- **API tests** — Sanitize (prototype pollution), CORS
- **Core tests** — Fetch cache (LRU eviction), i18n locale extraction, route matching (catch-all, dynamic, API, groups), plugin runner hooks, fetch cache eviction
- **CLI tests** — Dockerfile generation, codemod transforms (next-to-pledge, next-image, next-router, metadata API)
- **Package tests** — RSS feed generation, font optimization, MDX plugin, sitemap, image

### Templates (7 + 3 framework-specific)

`pledge create <name> --template <name> --framework <react|vue|solid|svelte>`

| Template | Description |
|---|---|
| `default` | Starter app with hero, nav, features |
| `blog` | Blog with SSG, dynamic routes, metadata API |
| `api` | REST API server with CRUD routes |
| `dashboard` | Admin dashboard with sidebar, stats, charts |
| `ecommerce` | E-commerce store with product grid, cart |
| `portfolio` | Personal portfolio with projects, about, contact |
| `saas` | SaaS landing page with pricing, features, testimonials |
| `vue` | Vue 3 starter (auto-selected when `--framework vue`) |
| `solid` | Solid.js starter (auto-selected when `--framework solid`) |
| `svelte` | Svelte 5 starter (auto-selected when `--framework svelte`) |

All templates use the metadata export API (`export const metadata`, `export const viewport`) with OpenGraph, themeColor, and description fields.

## Known Limitations

- **RSC is React-only** — React Server Components require `react-server-dom-webpack`. Vue, Solid, and Svelte use standard SSR with hydration. There are no plans to implement RSC for non-React frameworks.
- **Streaming for non-React frameworks** — Vue, Solid, and Svelte use async SSR (buffered). True progressive streaming with Suspense-style partial hydration is React-only.
- **No built-in client-side data fetching hooks** — PledgeStack doesn't provide `useSWR`/`useQuery` equivalents. Use your framework's native data fetching or install a library.
- **No Storybook integration** — The `pledge storybook` command is a stub. Storybook setup is manual.
- **No streaming metadata** — `generateMetadata()` is awaited before rendering. Metadata isn't streamed with the response.
- **Generated route types** — `pledge generate-route-types` generates typed route declarations from the file-based router. Route params are typed as `Record<string, string>` by default; generated types provide per-route param types.
- **Rust addons are optional** — All 16 NAPI addons have JS fallbacks. Production performance is better with native addons compiled, but the framework works without them.
- **PledgePack binary** — Prebuilt binaries are available for macOS (x64/arm64), Linux (x64/arm64), and Windows (x64). Other platforms require building from source (`cargo build --release`).
- **MDX compiler is lightweight** — The built-in MDX-to-JSX compiler handles common markdown syntax (headings, lists, bold, italic, code blocks, links) and embedded JSX. For full MDX spec compliance (remark/rehype plugins), use the `pledgestack-mdx` plugin with a custom renderer.
- **Image optimization endpoint** — The `/__pledge__/image/:path` endpoint currently serves original images with correct content-type and caching headers. Full resize/format conversion requires the `sharp` native module (planned).

## Monorepo Structure

```
pledgestack/
├── packages/
│   ├── shared/              # Shared types, config, constants, renderer interface (private)
│   ├── core/                # Framework core — routing, rendering, FS scanner, PSX (private)
│   ├── server/              # Node.js + Edge server runtime (private)
│   ├── client/              # Client hydration, routing, hooks, state (private)
│   ├── renderer-react/      # React renderer adapter — SSR, RSC, streaming (private)
│   ├── renderer-vue/        # Vue 3 renderer adapter — SSR, hydration (private)
│   ├── renderer-solid/      # Solid.js renderer adapter — SSR, hydration (private)
│   ├── renderer-svelte/     # Svelte 5 renderer adapter — SSR, hydration (private)
│   ├── auth/                # Authentication & security (private)
│   ├── state/               # State management (private)
│   ├── api/                 # API route utilities (private)
│   ├── a11y/                # Accessibility audit tools (private)
│   ├── overlay/             # Error overlay & DevTools (private)
│   ├── seo/                 # SEO & structured data (private)
│   ├── sitemap/             # Sitemap & robots.txt generation (private)
│   ├── image/               # Image optimization (private)
│   ├── font/                # Font optimization (private)
│   ├── mdx/                 # MDX support (private)
│   ├── og/                  # OpenGraph image generation (private)
│   ├── rss/                 # RSS feed generation (private)
│   ├── ws/                  # WebSocket support (private)
│   ├── adapters/            # Cloudflare, Vercel, Deno, AWS, Netlify adapters (private)
│   ├── privacy/             # GDPR/CCPA compliance, PII, encryption, consent (private)
│   ├── eslint-plugin-pledge/ # ESLint rules (private)
│   ├── vscode-extension/    # VS Code extension — highlighting, IntelliSense
│   ├── vscode-psx/          # VS Code extension — PSX language support
│   ├── bundler-pledgepack/  # PledgePack bundler adapter (private)
│   ├── bundler-vite/        # Vite bundler adapter (private)
│   ├── bundler-rollup/      # Rollup bundler adapter (private)
│   ├── bundler-turbopack/   # Turbopack bundler adapter (private)
│   ├── bundler-rsbuild/     # Rsbuild bundler adapter (private)
│   ├── bundler-webpack/     # Webpack bundler adapter (private)
│   ├── pledgepack/          # PledgePack npm package wrapper (Rust+Zig bundler)
│   ├── cli/                 # CLI tool — published as `pledgestack` on npm
│   └── create-pledge-app/   # Scaffolding CLI with 7 templates + 3 framework starters
├── pledge.config.ts         # Framework config (defineConfig from 'pledgestack')
├── vitest.config.ts         # Test configuration
├── tsconfig.json            # TypeScript project references
└── pnpm-workspace.yaml
```

> Only the `pledgestack` package (CLI) is published to npm. All sub-packages are bundled into it via esbuild and marked as private. PledgePack is installed from npm (`pledgepack@^0.2.8`) and used to build user apps — the framework itself uses esbuild.

## Getting Started

```bash
# Create a new project
npx pledge create my-app
cd my-app
npm install

# Start dev server
npx pledge dev

# Build for production
npx pledge build

# Start production server
npx pledge start
```

## App Directory Conventions

```
app/
├── layout.tsx              # Root layout (wraps all pages)
├── page.tsx                # Home page (/)
├── viewport.ts             # Viewport export (optional)
├── opengraph-image.tsx     # OG image for root route
├── twitter-image.tsx       # Twitter card image for root route
├── about/
│   └── page.tsx            # /about
├── blog/
│   ├── layout.tsx          # Blog section layout
│   ├── page.tsx            # /blog
│   └── [slug]/
│       ├── page.tsx        # /blog/:slug
│       └── opengraph-image.tsx  # OG image for blog posts
├── api/
│   └── hello/
│       └── route.ts        # API endpoint (/api/hello)
├── loading.tsx             # Loading UI (Suspense fallback)
├── error.tsx               # Error boundary (per-segment)
├── not-found.tsx           # 404 page
├── middleware.ts           # Middleware (redirect, rewrite, headers)
└── head.tsx                # Custom head tags
```

## Configuration

```typescript
// pledge.config.ts
import { defineConfig } from 'pledgestack';

export default defineConfig({
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  framework: 'react',          // 'react' | 'vue' | 'solid' | 'svelte' (default: 'react')
  rsc: true,                   // React Server Components (React only, ignored for other frameworks)
  ppr: false,                  // Partial Prerendering — static shell + streaming dynamic holes
  tailwind: true,
  output: 'standalone',        // 'standalone' | 'export'
  bundler: 'pledgepack',       // 'pledgepack' | 'vite' | 'rollup' | 'turbopack' | 'rsbuild' | 'webpack'
  securityHeaders: true,       // Auto-apply security headers (X-Content-Type-Options, X-Frame-Options, CSP, etc.)
  siteUrl: 'https://example.com',  // for sitemap, robots.txt, canonical URLs, RSS feeds
  // CSP directives (optional — defaults to restrictive policy)
  csp: {
    'default-src': "'self'",
    'script-src': "'self' 'unsafe-inline'",
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' data: https:",
  },
  // CORS for API routes (optional)
  cors: {
    origin: ['https://example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  // i18n configuration (optional)
  i18n: {
    locales: ['en', 'fr', 'es'],
    defaultLocale: 'en',
    localePrefix: 'always',    // 'always' | 'as-needed'
  },
  // CDN purge on post-build (optional)
  cdn: {
    provider: 'cloudflare',
    zoneId: process.env.CDN_ZONE_ID,
    apiToken: process.env.CDN_API_TOKEN,
  },
  // Request timeout in ms (optional, default: 30000)
  requestTimeout: 30000,
  alias: {
    '@/app/*': 'app/*',
    '@/lib/*': 'lib/*',
    '@/components/*': 'components/*',
  },
  cargo: {
    dev: { optLevel: 1, incremental: true },
    release: { optLevel: 3, lto: true, strip: true },
  },
  plugins: [
    // PledgePlugin hooks: configResolved, buildStart, buildEnd,
    // configureServer, renderStart, renderEnd, routeMatch,
    // fetchIntercept, transformHtml, transformClientBundle
  ],
});
```

## License

MIT © 2025 PledgeStack Contributors
