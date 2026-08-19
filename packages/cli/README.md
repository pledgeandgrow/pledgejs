# pledgestack

[![npm version](https://img.shields.io/npm/v/pledgestack.svg)](https://www.npmjs.com/package/pledgestack)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A full-stack **multi-framework** web framework with file-based routing, SSR/SSG/ISR, React Server Components, API routes, middleware, edge runtime support, and Rust native addons for rendering, compression, search, rate limiting, and more. Supports **React, Vue, Solid, and Svelte** via pluggable renderer adapters.

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

## Quick Start

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

## CLI Commands

| Command | Description |
|---------|-------------|
| `pledge dev` | Start dev server with HMR, DevTools overlay, error overlay |
| `pledge build` | Build for production (PledgePack bundler, plugin hooks, SBOM generation, CDN purge) |
| `pledge start` | Start production server (health checks, metrics, graceful shutdown) |
| `pledge create [name]` | Scaffold a new project (7 templates + 3 framework starters) |
| `pledge init` | Initialize PledgeStack in existing project |
| `pledge info` | Show environment info |
| `pledge doctor` | Diagnose common issues (Rust toolchain, Cargo, env, production readiness) |
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
| `pledge docker [--optimized]` | Generate Dockerfile, .dockerignore, docker-compose.yml. `--optimized` produces a Rust-addon-aware multi-stage build instead of the plain single-stage default. |
| `pledge storybook` | Set up Storybook |
| `pledge codemod` | Run code transformations (next-to-pledge, next-image, next-router, etc.) |
| `pledge sync-aliases` | Sync tsconfig path aliases |
| `pledge generate-route-types` | Generate typed route declarations |
| `pledge check-routes` | Detect route conflicts |
| `pledge search [query]` | Index pages and search content (embedded full-text search) |

## Configuration

Create a `pledge.config.ts` in your project root:

```typescript
import { defineConfig } from 'pledgestack';

export default defineConfig({
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  defaultRuntime: 'node',
  framework: 'react',          // 'react' | 'vue' | 'solid' | 'svelte'
  rsc: true,                   // React Server Components (React only)
  ppr: false,                  // Partial Prerendering
  tailwind: true,
  output: 'standalone',        // 'standalone' | 'export'
  bundler: 'pledgepack',       // 'pledgepack' | 'vite' | 'rollup' | 'turbopack' | 'rsbuild' | 'webpack'
  securityHeaders: true,       // Auto-apply security headers + CSP
  siteUrl: 'https://example.com',
  // CSP directives (optional — defaults to restrictive policy)
  csp: {
    'default-src': "'self'",
    'script-src': "'self' 'unsafe-inline'",
  },
  // CORS for API routes (optional)
  cors: {
    origin: ['https://example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  // i18n (optional)
  i18n: {
    locales: ['en', 'fr', 'es'],
    defaultLocale: 'en',
    localePrefix: 'always',    // 'always' | 'as-needed'
  },
  // Request timeout in ms (optional, default: 30000)
  requestTimeout: 30000,
  alias: {
    '@/app/*': 'app/*',
    '@/lib/*': 'lib/*',
    '@/components/*': 'components/*',
  },
  plugins: [
    // PledgePlugin hooks: configResolved, buildStart, buildEnd,
    // configureServer, renderStart, renderEnd, routeMatch,
    // fetchIntercept, transformHtml, transformClientBundle
  ],
});
```

Config is validated at load time — invalid values produce clear error messages before the server starts.

## App Directory Structure

```
app/
├── layout.tsx              # Root layout (wraps all pages)
├── page.tsx                # Home page (/)
├── head.tsx                # Custom head tags
├── loading.tsx             # Loading UI (Suspense fallback)
├── error.tsx               # Error boundary (per-segment)
├── not-found.tsx           # 404 page
├── middleware.ts           # Middleware (redirect, rewrite, headers)
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
└── [slug]/
    └── page.tsx            # Dynamic route
```

## Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `/health` | Health check (healthy/degraded/unhealthy, HTTP 200/503) |
| `/metrics` | Prometheus-format metrics (counters, timings, histograms) |
| `/robots.txt` | robots.txt (from `public/` or auto-generated) |
| `/sitemap.xml` | sitemap.xml (from `public/` or auto-generated from routes) |
| `/rss.xml` | RSS 2.0 feed (from `public/` or `app/feed.ts`) |
| `/atom.xml` | Atom 1.0 feed |
| `/feed.json` | JSON Feed 1.1 |
| `/__pledge__/client.js` | Hydration client script |
| `/__pledge__/client.css` | Client CSS |
| `/__pledge__/font/:family` | Optimized font CSS |
| `/__pledge__/image/:path` | Image optimization endpoint |

## License

MIT © 2025 PledgeStack Contributors
