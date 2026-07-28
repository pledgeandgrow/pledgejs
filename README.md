# PledgeStack

[![npm version](https://img.shields.io/npm/v/pledgestack.svg)](https://www.npmjs.com/package/pledgestack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A full-stack React framework with file-based routing, SSR/SSG/ISR, React Server Components, API routes, middleware, edge runtime support, and Rust native addons for rendering, compression, search, rate limiting, and more. Uses PledgePack (Rust+Zig bundler) to build user apps.

## Requirements

- **Node.js** >= 20.0.0
- **pnpm** >= 11.x (monorepo workspace)
- **Rust toolchain** (optional — for PSX native addons; JS fallbacks exist)

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
| `pledge docker` | Generate Dockerfile |
| `pledge storybook` | Set up Storybook |
| `pledge codemod` | Run codemods |
| `pledge sync-aliases` | Sync tsconfig path aliases |
| `pledge generate-route-types` | Generate typed route declarations |
| `pledge check-routes` | Detect route conflicts |
| `pledge search [query]` | Index pages and search content (embedded full-text search) |

## What's Actually Implemented

### Core Runtime

- **File-based routing** — `page.tsx`, `layout.tsx`, `route.ts`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, `head.tsx`, `opengraph-image.tsx`, `twitter-image.tsx`
- **Route patterns** — Dynamic segments `[param]`, catch-all `[...param]`, optional catch-all `[[...param]]`, route groups `(group)`, parallel routes `@slot`, intercepting routes `(..)folder`
- **Server-Side Rendering** — `renderSSR()` with layout chains, error boundaries, Suspense loading states, streaming SSR
- **Static Site Generation** — `generateStaticParams` pre-rendering, `static-export` mode
- **React Server Components** — `react-server-dom-webpack` integration, flight payload generation, RSC streaming, client manifests
- **Partial Prerendering (PPR)** — Rust-based PPR via `rust-ppr.ts` with JS fallback
- **API Routes** — `route.ts` with `GET`, `POST`, `PUT`, `DELETE`, `PATCH` handlers
- **Middleware** — `middleware.ts` with redirect, rewrite, headers, short-circuit, matcher config
- **Server Actions** — `getServerAction()`, `useActionState` hook
- **Server Utilities** — `cookies()`, `headers()`, `searchParams()`, `params()`, `redirect()`, `notFound()`, `after()`, `connection()`, `draftMode()`

### Data & Caching

- **Fetch Cache** — `cachedFetch()` with `force-cache`, `no-store`, `isr` modes, tag-based revalidation
- **Cache Invalidation** — `revalidateTag()`, `revalidatePath()`, persistent cache, remote cache, cache-invalidation worker
- **Query Memoization** — Deduplication of identical data fetches per request
- **Edge Cache** — Multi-region edge caching with invalidation

### SEO & Metadata

- **Metadata API** — `export const metadata` and `export function generateMetadata()` on pages and layouts
- **Metadata Merging** — Layout-to-page inheritance: page wins on scalar conflicts, arrays concatenated, objects merged
- **Viewport API** — `export const viewport` and `export function generateViewport()` with layout inheritance
- **Head Tags** — Shared `renderHeadTags()` module: title, description, keywords, robots, theme-color, OpenGraph (title/description/images/url/type/siteName), Twitter cards (card/title/description/images/site/creator), canonical, icons, JSON-LD structured data
- **robots.txt** — Automatic serving from `public/robots.txt` or dynamic generation via `pledgestack-sitemap`
- **sitemap.xml** — Automatic serving from `public/sitemap.xml` or dynamic generation from route tree
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
- **Error Overlay** — Dev error overlay with telemetry
- **Dev Toolbar** — In-browser dev toolbar

### Security & Privacy

- **Security Headers** — CSP, CORS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Trusted Types, COOP/COEP/CORP
- **Auth Package** — OAuth 2.1, JWT, TOTP/2FA, WebAuthn, RBAC, ABAC, API keys, SAML SSO, session management, audit log
- **Vulnerability Protection** — XSS, CSRF, path traversal, SSRF, ReDoS, open redirect, prototype pollution, clickjacking, DNS rebinding
- **Privacy Package** — GDPR, CCPA, PII redaction, encryption, consent management, data retention, compliance docs
- **Safety Net** — Input validation, output serialization, rate limiting, bot detection, brute force protection, body limits

### Edge & Adapters

- **Edge Runtime** — Edge handler for Cloudflare Workers, Vercel Edge, Deno Deploy
- **Adapters** — `pledgestack-adapters` with Cloudflare, Vercel, Deno, AWS Lambda, Netlify, edge-security
- **Standalone Output** — Docker-ready standalone build, health checks, graceful shutdown

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
- **rust-static-server** — Zero-copy static file serving via memory-mapped I/O (mmap)
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

- **Plugin System** — `PledgePlugin` with `configResolved`, `buildStart`, `buildEnd`, `configureServer`, `renderStart`, `renderEnd`, `routeMatch`, `fetchIntercept`, `transformHtml`, `transformClientBundle` hooks
- **ESLint Plugin** — `eslint-plugin-pledge` with PledgeStack-specific lint rules
- **VS Code Extension** — Syntax highlighting, IntelliSense, snippets, file icon theme
- **VS Code PSX Extension** — PSX language support, syntaxes, language configuration
- **Type-Safe Routes** — `pledge generate-route-types` auto-generates typed route declarations
- **Route Conflict Detection** — `pledge check-routes`
- **Path Aliases** — `@/app/*`, `@/lib/*`, `@/components/*`, `@/styles/*`, `@/utils/*` (configurable)
- **Tailwind CSS** — Built-in Tailwind v4 + PostCSS pipeline
- **MDX Support** — `pledgestack-mdx`
- **Image Optimization** — `pledgestack-image`
- **Font Optimization** — `pledgestack-font`
- **RSS Feed** — `pledgestack-rss`
- **WebSocket** — `pledgestack-ws`
- **A11y Audit** — `pledgestack-a11y`
- **Storybook** — `pledge storybook` setup
- **Observability** — Structured JSON logging, OpenTelemetry tracing, metrics export, Sentry/Bugsnag error tracking, request ID, slow request detection, monitoring dashboard
- **Supply Chain** — Dependency audit CI, SBOM, license compliance, pinned deps, provenance attestation, Sigstore signing, secret scanning

### Testing

45 test files across the monorepo using Vitest:

- **PSX Integration tests** — Fallback behavior for all 15 Rust wrappers
- **Render tests** — `rust-html`, `rust-ssr`, `rust-rsc`, `rust-dom-renderer`, `rust-html-transformer`, `rust-hydration`, `rust-ssr-profiler`
- **Security tests** — Path traversal, security headers validation, security headers
- **Server tests** — Instrumentation
- **API tests** — Sanitize (prototype pollution)
- **Core tests** — Fetch cache, PSX audit, bench, bundle analysis, callback optimization, canary, debug session, docker, edge cache invalidation, edge durable objects, edge geo, edge KV, edge middleware, edge PSX, edge streaming SSR, lambda PSX, lazy compile, memory profile, monitoring dashboard, multi-region, NAPI bench, pool, prod profile, rollback, sccache, security, serverless cold start, streaming, syn parser, tree shake, version compat, worker pool

### Templates (7)

`pledge create <name> --template <name>`

| Template | Description |
|---|---|
| `default` | Starter app with hero, nav, features |
| `blog` | Blog with SSG, dynamic routes, metadata API |
| `api` | REST API server with CRUD routes |
| `dashboard` | Admin dashboard with sidebar, stats, charts |
| `ecommerce` | E-commerce store with product grid, cart |
| `portfolio` | Personal portfolio with projects, about, contact |
| `saas` | SaaS landing page with pricing, features, testimonials |

All templates use the metadata export API (`export const metadata`, `export const viewport`) with OpenGraph, themeColor, and description fields.

## Monorepo Structure

```
pledgestack/
├── packages/
│   ├── shared/              # Shared types, config, constants (private)
│   ├── core/                # Framework core — routing, rendering, FS scanner, PSX (private)
│   ├── server/              # Node.js + Edge server runtime (private)
│   ├── client/              # Client hydration, routing, hooks, state (private)
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
│   └── create-pledge-app/   # Scaffolding CLI with 7 templates
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
  rsc: true,
  tailwind: true,
  output: 'standalone',        // 'standalone' | 'export'
  bundler: 'pledgepack',       // 'pledgepack' | 'vite' | 'rollup' | 'turbopack' | 'rsbuild' | 'webpack'
  siteUrl: 'https://example.com',  // for sitemap, robots.txt, canonical URLs
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
