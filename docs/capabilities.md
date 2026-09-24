# Capabilities — What's Working

All features below are implemented, tested, and verified working as of
2026-09-21. Tests: 1692 passing, 0 failing, 6 skipped (real-CLI deploy
tests gated on external tokens) across 206 files. Typecheck: 0 errors.
Where a capability depends on optional pieces (native addons, `sharp`, a
bundler's own dev server) it is qualified below and in [limitations.md](./limitations.md).

## Authentication & Security

### Session Management
- Stateless HMAC-signed cookie sessions
- Session regeneration (anti-fixation)
- Configurable cookie options (httpOnly, secure, sameSite, maxAge)

### Password Authentication
- scrypt hashing (memory-hard, self-describing format)
- Password strength validation (length, character classes)
- Account lockout with exponential backoff
- Failed-attempt tracking per identifier

### OAuth / OIDC
- Authorization Code + PKCE flow
- State generation and verification with expiry
- Redirect URL allowlist validation
- `email_verified` claim extraction
- Token exchange and refresh

### JWT
- RS256/ES256/HS256 signing and verification
- JWKS endpoint support
- `typ` claim enforcement (refresh ≠ access)
- Configurable audience, issuer, expiry

### Multi-Factor Authentication
- TOTP (RFC 6238) with replay protection
- Backup codes (constant-time comparison)
- WebAuthn / Passkeys (registration + authentication)

### Enterprise SSO
- SAML 2.0 (IdP-initiated + SP-initiated)
- XML injection prevention

### Authorization
- RBAC (role-based access control)
- ABAC (attribute-based access control)
- `requireAuth` / `requireRole` middleware

### Security Headers & Protections
- CSP with nonce support
- CSRF protection (decoupled from security headers)
- XSS sanitization
- SSRF protection (DNS rebinding prevention)
- Path traversal prevention
- Open-redirect validation
- Prototype pollution defense
- ReDoS detection
- Trusted Types CSP
- Cross-origin headers (CORP, COEP)
- Referrer-Policy
- Permissions-Policy
- API key rotation
- Audit logging

## Server Runtime

### Node.js Server
- HTTP/1.1 server with streaming
- Request body size limits
- Request timeout with AbortController
- Graceful shutdown (SIGTERM/SIGINT) with handler dedup
- Health checks (tri-state: healthy/degraded/unhealthy)
- Prometheus-format metrics
- ETag generation
- Request ID sanitization
- Security headers auto-application
- CORS middleware
- Rate limiting (token bucket)
- Middleware matching (configurable matcher)
- Server actions (stable FNV-1a IDs)
- Server functions (TanStack Start-style with middleware chains)
- Server function input/output validators (`.inputValidator()`, `.outputValidator()`)
- Server functions with validators

### Edge Handler
- Request → Response handler (Cloudflare Workers / Vercel Edge compatible)
- Body size limits
- Base64 binary decoding
- Security headers
- Error handling

### WebSocket Support
- `defineWebSocketRoute` for app-directory WS routes
- Room management with topic-based pub/sub
- Client/topic caps (bounded memory)
- Per-send error isolation
- Native permessage-deflate compression (Rust or zlib fallback)
- Authenticated WS routes with rate limiting

## Rendering

### Server-Side Rendering (SSR)
- React 19 streaming SSR via `renderToPipeableStream`
- Shell-ready + on-all-ready callbacks
- 5s fallback to `renderToString`
- Layout chain composition (nested layouts)
- Error boundaries (per-route + per-layout)
- Suspense boundaries (loading.tsx)
- Template wrappers
- Head metadata resolution (layout → page inheritance)
- Viewport generation
- OG/Twitter image auto-injection

### React Server Components (RSC)
- Flight protocol encoding/decoding
- Module map emission
- Streaming RSC
- SSR fallback when RSC unavailable
- Rust-accelerated flight encoding (optional)

### Static Generation (SSG)
- `generateStaticPages` for static routes
- `generateStaticParams` for dynamic routes (with failure surfacing)
- `output: 'export'` mode

### Partial Prerendering (PPR)
- Static shell prerendering at build time
- Dynamic hole streaming at request time
- PPR timeout/error handling

### Incremental Static Regeneration (ISR)
- Stale-while-revalidate serving
- LRU eviction (cap: 5000 entries)
- TTL sweep of expired entries
- Thundering-herd protection (`tryStartRevalidation`)
- `revalidatePath` invalidation

### Hybrid SSR
- Static/dynamic component classification
- Rust static-subtree rendering (optional)
- Hard timeout (10s) to prevent hangs

### Rust Acceleration (Optional)
- 17 native NAPI addons for rendering, caching, compression
- Automatic JS fallback when not compiled
- Incremental compilation with sccache support

## Routing

### File-Based Routing
- Static routes (`/about`)
- Dynamic segments (`/blog/:slug`)
- Catch-all routes (`/docs/*slug`)
- Optional catch-all (`/shop/*slug`)
- Route groups (`(group)`)
- Parallel routes (`@slot`)
- Intercepting routes (`(..)folder`)

### Route Matching
- Specificity-scored matching (static > dynamic > catch-all)
- Compiled pattern memoization (cap: 2000)
- Safe URI decoding (no throw on malformed input)

### Internationalization (i18n)
- Locale-prefixed routing
- `generateStaticParams` for locale variants
- hreflang alternates in sitemap

### Special Files
- `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`
- `not-found.tsx`, `head.tsx`, `template.tsx`
- `route.ts` (API + WebSocket)
- `middleware.ts`

## Client-Side

### Hydration
- `hydrateRoot` with SSR content
- Pledge islands architecture (`pledge()` HOC)
- Selective hydration (viewport-aware priority)
- Media-query-based hydration
- Interaction-based hydration
- Instance-scoped hydration IDs (import-order counters — see
  `docs/limitations.md`; stable-across-builds IDs are not yet implemented)

### Routing
- `RouterProvider` with `useRouter()` hook
- `Link` component (prefetch: intent/visible/render/none)
- `usePathname()`, `useSearchParams()`
- Bounded prefetch cache (cap: 100, LRU)
- Navigation race protection (sequence counter)
- Scroll position restoration
- Popstate handling

### Hooks
- `useActionState` (server actions)
- `useFormStatus`
- `useOptimistic`
- Web vitals reporting
- Offline state hooks
- Rust-accelerated client hooks (optional)

### Fast Refresh / HMR
- Hot module replacement is provided by the bundler's own dev server (Vite, webpack-dev-server, Rsbuild, the PledgePack binary); the esbuild fallback servers do not live-reload — see [limitations.md](./limitations.md#bundler-hmr-hot-module-replacement)
- Error overlay
- Dev toolbar (`DevTools`; the middleware only injects a script when given a `scriptUrl`)

## State Management

### Store
- `createStore` with `useStore` hook
- Selector-based updates (identity + property accessor)
- Immutable updates with `Object.is` equality check
- Listener error isolation

### URL State
- `useUrlState` with URL search param sync
- Redundant update prevention
- History API integration (push/replace)

### Cross-Tab Sync
- `useCrossTabState` via BroadcastChannel

### Persistence
- `usePersistentState` (localStorage/sessionStorage)
- Quota error surfacing (`onPersistError`)
- Atomic file writes (temp + rename)

### DevTools
- `StateDevtools` with history (time travel)
- `useDevtools` hook
- `GlobalErrorBoundary`

## API Routes

### Route Definition
- `defineApiRoute` with method handlers
- API versioning (`apiVersion`)
- Request validation
- Typed responses (JSON, HTML, text, CSV, XML, binary, redirect)

### Security
- SQL injection detection + parameterized query builder
- NoSQL (MongoDB) injection sanitization
- GraphQL security (query analysis, introspection detection, persisted queries)
- File upload handling with magic byte verification

### Utilities
- OpenAPI spec generation
- Middleware composition
- Cron scheduler
- Job queue
- Database connection pooling

## Privacy & Compliance

### GDPR
- Right to be forgotten
- Data export (JSON/CSV with formula injection defense)
- Data collector registry
- Owner verification

### CCPA
- "Do Not Sell My Personal Information" endpoint
- HMAC-signed opt-out cookies
- Privacy policy generator
- Data category labeling

### Consent Management
- Versioned consent policies
- Granular categories (necessary/analytics/marketing/functional)
- HMAC-signed consent cookies

### PII Redaction
- Automatic redaction of SSN, email, phone, credit card, IP, API keys, JWTs
- Logger wrapping for safe logging
- Pattern-based detection

### Data Retention
- Configurable TTL per data source
- Automatic purge
- Default policies (sessions, audit log, cache)

### Encryption
- Salt persistence in encrypted payloads
- Passphrase-based key derivation
- Transport security (TLS minimum enforcement, `trustProxy` default deny)

## SEO & Content

### Structured Data
- JSON-LD schemas (Organization, BreadcrumbList, Article, Product, FAQPage, WebSite, Person)
- Meta tag generation
- Social cards (OpenGraph + Twitter)

### Sitemap
- Build-time `sitemap.xml` generation
- `robots.txt` with allow/disallow/crawl-delay
- hreflang alternates
- Head injection

### RSS/Atom/JSON Feed
- RSS 2.0, Atom 1.0, JSON Feed 1.1
- XML escaping
- Custom element validation

### OG Image Generation
- `ImageResponse` serializes a JSX tree (function components and fragments are expanded); the server lays it out with a flexbox subset, converts it to SVG and rasterizes it to a real PNG via the native addon or the optional `sharp` package (otherwise a clear `501`)
- Depth- and node-capped serialization and layout; only inline `data:` images are drawn
- `nosniff` header
- OG/Twitter meta tag helpers

### Content Collections
- Schema validation (lightweight Zod-like)
- Type inference from schema
- Frontmatter parsing
- Query builder (filter/sort/limit/skip)
- Mtime-based cache staleness
- Collection cache (`getCollectionCached`, `isCacheStale`)
- Pluggable body renderer (`setBodyRenderer`, `renderBody`)
- Built-in markdown-to-HTML renderer (`renderMarkdown`)
  - Headings, bold, italic, code blocks, inline code, links, images
  - Lists (ordered/unordered), blockquotes, horizontal rules
  - HTML escaping in code blocks
- **MDX compiler** (`compileMdx`) — first-party, zero-dependency
  - Strips import/export statements
  - Extracts JSX elements (self-closing and with children)
  - Renders markdown segments with `renderMarkdown`
  - Renders JSX via registered components or fallback placeholders
  - Component registry (`registerMdxComponents`)
  - Props parsing (string, expression, boolean)
  - Markdown-inside-JSX-children rendering
  - `renderBody` auto-selects `compileMdx` for `.mdx` files
- `getAllCollectionNames()` for registry inspection
- CLI: `pledge content list|validate|stats|index`

## Optimization

### Image
- Responsive srcSet generation
- Source elements with format fallbacks
- Blur placeholder generation
- Aspect-ratio padding
- URL optimization

### Font
- Google Fonts URL building (CSS2 axis-tuple syntax)
- Local font @font-face generation
- Preload links
- Font-display strategies
- CLS-reducing size-adjust with fallback metrics

## Accessibility
- Focus management (`useFocusManagement`, `FocusManager`)
- Keyboard navigation (`useKeyboardNavigation`)
- RTL/direction support (`useRtl`, `RtlProvider`, `useDirection`)
- Accessibility auditing (`auditAccessibility`)
- i18n translation extraction (`extractTranslations`)

## Development Tools

### Dev Overlay
- Error overlay
- DevTools (route info, cache entries)
- Cache inspector
- Component inspector with element picker

### CLI Commands
- `pledge dev` — start dev server
- `pledge build` — production build
- `pledge start` — start production server
- `pledge test` — run tests
- `pledge typecheck` — typecheck workspace
- `pledge lint` — lint
- `pledge clean` — clean build artifacts
- `pledge create` — scaffold new project
- `pledge docker` — generate Dockerfile
- `pledge deploy` — deploy to Cloudflare/Vercel/Netlify
- `pledge deploy --project <name>` — specify project/site name
- `pledge content` — index, list, validate, and show stats for content collections

### VS Code Extensions
- `vscode-extension` — general PledgeJS extension
- `vscode-psx` — PSX language server

### ESLint Plugin
- Custom ESLint rules for PledgeJS patterns

## Deployment

### Platforms
- Cloudflare Pages (`wrangler pages deploy`)
- Vercel (`vercel --prod --name=<project>`)
- Netlify (`netlify deploy --prod --site=<project>`)

### Auto-Detection
- `wrangler.toml` → Cloudflare
- `vercel.json` → Vercel
- `netlify.toml` → Netlify
- `config.pledgepack.edge.target` → specified platform

### Project Names
- `--project <name>` flag on `pledge deploy`
- Defaults to the root directory name
- Passed to platform CLI (`--name` for Vercel, `--site` for Netlify)

### Docker
- Multi-stage Dockerfile generation
- Non-root user
- Health check
- `pledge start` entrypoint (not hardcoded path)
- `.dockerignore` generation
- `docker-compose.yml` generation
- Optimized Dockerfile (Rust addon compilation stage)

## Build & CI

### Bundlers
- PledgePack (default, Rust binary)
- Vite (source maps, content hashes)
- Webpack (minification, split chunks, content hashes, source maps)
- Rollup, Rsbuild, Turbopack

### CI Workflows
- Lint + typecheck + build verification
- Tests (Ubuntu, Windows, macOS matrix)
- Rust checks (fmt, clippy, build)
- Release (typecheck → lint → test → build → publish)

### Typecheck
- `tsc --noEmit -p` per leaf project
- Root `tsconfig.json` path aliases resolve workspace imports to source
- No project references needed (avoids `tsc -b` emit problem)
