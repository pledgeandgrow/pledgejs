# SEO + GEO Roadmap — 50 Goals

Scope: make PledgeStack match Next.js's SEO ergonomics and then exceed it with
first-class **GEO** (Generative Engine Optimization — being cited by AI answer
engines: ChatGPT, Perplexity, Google AI Overviews, Claude). Written 2026-09-23
against the `0.2.0` tree.

Legend: 🔴 blocks correct indexing · 🟠 ranking/visibility-affecting · 🟡 differentiation/polish · ⚊ tooling/ops

## What already exists (do not re-implement)

- `metadata` / `generateMetadata(params)` exports on `page.tsx` and
  `layout.tsx`, merged layout→page via `mergeMetadata`
  (`packages/core/src/render/server.ts`, `router/types.ts` `HeadMetadata`)
- `head.tsx` convention; `opengraph-image.tsx` / `twitter-image.tsx`
  conventions auto-inject `og:image`/`twitter:image` URLs from the real
  request pathname (`packages/core/src/fs/resolver.ts`,
  `FILE_CONVENTIONS` in `packages/shared/src/constants.ts`)
- `/robots.txt` + `/sitemap.xml` served automatically at request time
  (`packages/server/src/seo-routes.ts`) and written at `buildEnd` for static
  export (`packages/sitemap`)
- `generateMetaTags`, `generateSocialCards`, `generateJsonLd` (typed
  Organization/Article/Product/FAQ/WebSite/Breadcrumb) in `pledgestack-seo`
- `ImageResponse` — JSX → flexbox-subset → SVG → PNG OG images
  (`pledgestack-og` + `maybeRenderOgResponse` in `pledgestack-server`)
- `generateViewport` / `viewport` exports (`GenericPageModule`)
- Full SSR/SSG/ISR — crawlers get complete HTML without JS execution

The gap vs Next.js is therefore *coverage and conventions*, not architecture:
missing metadata fields, missing special-file conventions, no `metadataBase`,
no title templates, no GEO surface at all.

---

## Tier 1 — Metadata API parity (🔴 blocks correct indexing)

**1. 🔴 `metadataBase` support.** `HeadMetadata` has no `metadataBase`;
relative `openGraph.images`/`alternates.canonical` emit relative URLs, which
crawlers reject. Add `metadataBase?: string | URL` (config `seo.siteUrl` as
the default), resolve all relative metadata URLs against it at merge time in
`mergeMetadata`, and warn in dev when it's unset and relative URLs are used.
Files: `router/types.ts`, `render/server.ts`, `shared/src/types.ts`.

**2. 🔴 Title templates.** `title` is a plain string; there's no
`{ default, template: '%s | Site', absolute }` object form, so every page
hand-concatenates the site name (the #1 cause of inconsistent titles).
Extend `HeadMetadata.title`, apply templates during the layout→page merge.

**3. 🔴 `alternates.languages` (hreflang).** `alternates` only has
`canonical`. Add `languages?: Record<string, string>` rendering
`<link rel="alternate" hreflang>` tags — required for any multi-locale site
(the `i18n` router module exists; wire it).

**4. 🔴 `alternates.types` (feed links).** Render
`<link rel="alternate" type="application/rss+xml">` (and Atom/JSON) so
`pledgestack-rss` feeds are discoverable. Currently feeds exist but nothing
links them in `<head>`.

**5. 🟠 `robots` as an object.** Today `robots?: string` only. Accept
`{ index, follow, nocache, noarchive, nosnippet, maxSnippet, maxImagePreview,
maxVideoPreview, googleBot }` and serialize — Next.js parity, and needed for
the AI-crawler controls in Tier 4.

**6. 🟠 `verification` metadata.** `google`, `bing`, `yandex`, `pinterest`,
`other` site-verification meta tags — every real site needs these and
currently must hand-write them in `head.tsx`.

**7. 🟠 `authors` / `creator` / `publisher` / `generator` fields.**
Standard `meta name="author"`/`generator` tags; `generator` defaults to
`PledgeStack <PLEDGE_VERSION>` (free distribution signal).

**8. 🟠 `appLinks` metadata.** iOS/Android universal-link meta
(`al:ios:url`, `al:android:package`, …) — Next.js supports it; apps with
mobile companions need it.

**9. 🟠 `formatDetection` metadata.** `telephone`/`email`/`address`/`date`
`no` flags — prevents mobile browsers mangling content.

**10. 🟠 `openGraph` completeness.** Add `locale`, `audio`, `videos`,
`determiner`, `countryName`, `ttl`, `section`, `tags`, `publishedTime`,
`modifiedTime` (article-type fields matter for news/AI extraction).
Currently only title/description/images/url/type/siteName.

**11. 🟠 `icons` completeness.** `icons` currently only
`{icon, apple, favicon}`. Support arrays with `sizes`/`type`/`media`
(`(prefers-color-scheme: dark)` icons) and `shortcut`/`mask-icon`.

**12. 🟠 `manifest` + `category` + `referrer` + `archives`/`assets`/
`bookmarks`/`classification`.** Remaining Next.js `Metadata` fields — small,
mechanical additions that close the parity checklist.

## Tier 2 — File conventions (🟠)

**13. 🟠 `app/sitemap.ts` → `/sitemap.xml`.** Data-driven sitemap file
convention: default-export a function returning `SitemapEntry[]`; the scanner
already picks up conventions — add `FILE_CONVENTIONS.sitemap`, serve via
`seo-routes.ts` (file convention wins over auto-generation).

**14. 🟠 `app/robots.ts` → `/robots.txt`.** Same pattern: export a function
returning `{ rules, sitemap, host }`; supersedes both `public/robots.txt`
and auto-generation.

**15. 🟠 `app/icon.(svg|png|ico)` and `app/apple-icon.(png|tsx)`.** File
conventions that serve the asset *and* inject the matching `<link rel>` —
today `metadata.icons` requires a manual `public/` file + URL.

**16. 🟠 `app/manifest.ts` → `/manifest.webmanifest`.** Returns a
`WebManifest` object; auto-linked via `manifest` metadata.

**17. 🟠 Per-group sitemaps + sitemap index.** `sitemap.ts` inside a route
group emits `/<group>/sitemap.xml` and the root emits a `<sitemapindex>` —
required at scale (50k URL limit) and per-section freshness.

**18. 🟠 OG-image route metadata.** `opengraph-image.tsx` sibling exports
`alt`, `size` → `og:image:width/height/alt` tags (accessibility + AI
extraction both read `og:image:alt`).

**19. 🟠 Route-level sitemap hints.** `export const sitemap = {
changeFrequency, priority, lastModified }` on a page flows into generated
sitemap entries — currently `routes` config is the only way.

**20. 🟠 `default.tsx` for parallel routes.** Slots (`@slot`) resolve but
there's no `default.tsx` fallback convention — unmatched slots render
nothing instead of a fallback.

**21. 🟡 `forbidden.tsx` / `unauthorized.tsx` conventions.** 403/401 error
boundaries mirroring `not-found` — Next.js 15 added them; also lets
`forbidden()`/`unauthorized()` helpers set correct status codes (SEO cares:
401/403 must not render 200 pages).

**22. 🟡 `rss.ts` / `feed.ts` convention.** A route file convention wired to
`pledgestack-rss` so `app/blog/feed.ts` just works — today the RSS package
is imperative-only.

## Tier 3 — Crawlability & indexing (🟠)

**23. 🔴 Canonical URL auto-generation.** `config.seo.siteUrl` + pathname →
`rel=canonical` on every page by default (opt-out via `alternates.canonical:
null`). Missing canonicals on a framework that *knows* the route tree is an
own-goal.

**24. 🔴 Trailing-slash & case canonicalization.** Redirect
`/About/` → `/about` (308, preserving query) per config — duplicate-content
protection; currently both variants serve 200.

**25. 🟠 Correct status codes for error surfaces.** Verify `not-found`
renders with real 404 status (not 200), `error.tsx` surfaces don't mask
500s, and `noindex` is emitted on error/not-found responses.

**26. 🟠 `redirects`/`rewrites`/`headers` config.** Next.js-style
`pledge.config.ts` arrays for 301/308 redirects, rewrites, and custom
headers — migrations and SEO consolidation need them; today they require
middleware code.

**27. 🟠 Cache header correctness for SEO.** Ensure SSR/ISR responses emit
sane `Cache-Control`/`ETag`/`Last-Modified` (and honor `If-Modified-Since`)
— crawl budget depends on it; ISR keys are pathname-only today.

**28. 🟠 `html lang` from i18n config.** `wrapHtml` hardcodes
`<html lang="en">` (`render/server.ts`) — drive it from locale/i18n routing.

**29. 🟠 Breadcrumb JSON-LD auto-generation.** The route tree knows the
hierarchy — auto-emit `BreadcrumbList` schema from route segments (opt-out
via metadata). Free rich result for every nested page.

**30. 🟠 `structuredData` merge + escaping audit.** `structuredData` exists
in `HeadMetadata`; verify arrays merge across layout/page, JSON-LD is
`escapeJsonForScript`-escaped, and a `head.tsx` can't bypass escaping.

**31. 🟡 OG/Twitter URL absolutization.** Auto-injected
`opengraph-image` URLs are pathname-relative; make them absolute via
`metadataBase` (crawlers drop relative og:image).

**32. 🟡 `<link rel="prev/next">` + pagination helper.** Google ignores it
now, but Bing and AI crawlers still consume it; small helper
`pagination()` generating the links + `canonical` on page 1.

**33. 🟡 `X-Robots-Tag` header support.** `robots` metadata should also emit
the HTTP header (it applies to non-HTML responses too — PDFs, images).

**34. 🟡 Image SEO defaults.** `pledgestack-image` emits `srcset`/`sizes`;
add auto `alt`-presence warnings (eslint-plugin rule + dev overlay), `lazy`
by default, explicit `width`/`height` (CLS — a ranking signal).

## Tier 4 — GEO: Generative Engine Optimization (🟡 differentiation)

*Nothing in Next.js covers this natively. This is where PledgeStack leads.*

**35. 🟡 `llms.txt` convention.** `app/llms.txt.ts` or `config.geo.llmsTxt`
auto-generates a markdown index of the site (routes + titles + summaries)
served at `/llms.txt` — the emerging standard for LLM crawler guidance.

**36. 🟡 `llms-full.txt`.** Full-content markdown dump (from `content`/MDX
sources when present) at `/llms-full.txt` for deep indexing.

**37. 🟡 AI-crawler robots controls.** Typed `aiBots` field in `robots.ts`
output and `config.geo`: allow/deny lists for `GPTBot`, `OAI-SearchBot`,
`ClaudeBot`, `PerplexityBot`, `Google-Extended`, `CCBot`, `Bytespider`,
`meta-externalagent`. Default: allow search agents, document the choice.
`config.geo.aiBots: 'allow' | 'block-training' | 'block-all'`.

**38. 🟡 Markdown mirrors.** Content negotiation (`Accept: text/markdown`)
or `?format=md` / `.md` suffix serves a markdown rendering of any page —
AI crawlers extract markdown far more reliably than HTML. `mdx`/`content`
packages provide the source.

**39. 🟡 Entity graph by default.** `config.seo.organization`/`person` →
`Organization`/`WebSite` JSON-LD with `sameAs` auto-emitted site-wide.
Entity resolution is *the* GEO primitive; currently manual.

**40. 🟡 `FAQPage` auto-extraction.** From MDX content with `## Q:`-style
headings, emit `FAQPage` JSON-LD — AI answer engines heavily weight FAQ
schema. Opt-in per route.

**41. 🟡 `speakable` + `datePublished`/`dateModified`/`author` defaults.**
Freshness + attribution signals AI engines use for citation; auto-fill from
git/file mtime and `config.seo.author`.

**42. 🟡 Semantic-HTML guardrails.** Extend `pledgestack-a11y` checks into
GEO terms: single `<h1>`, heading hierarchy, `<main>`/`<article>` landmarks,
`<time datetime>` — what screen readers need is what extractors need. Run
as dev-overlay warnings + `pledge lint` rules.

**43. 🟡 `pledge geo check` CLI.** Reports: llms.txt presence, AI-bot rules,
JSON-LD validity (parse + schema.org type check), markdown-mirror coverage,
entity graph completeness. The "is my site AI-ready" command nobody else
has.

**44. 🟡 AI-answer tracking hooks.** `X-AI-Bot` detection middleware
(optional): log/metric when GPTBot/PerplexityBot/etc. fetch a page, per
route — GEO analytics in `pledgestack`'s existing metrics surface.

## Tier 5 — Performance & verification (⚊)

**45. 🔴 Finish asset fingerprinting.** `__pledge__/client.js`/`client.css`
URLs must become content-hashed (`render/server.ts` + all bundler adapters)
so `Cache-Control: immutable` applies — LCP/crawl-budget impact, and it's
already goal #46-partial on the main roadmap.

**46. 🟠 Critical CSS + font preload defaults.** Inline critical CSS or at
minimum `<link rel="preload">` for the route's CSS + `pledgestack-font`
preloads — LCP is a direct ranking signal.

**47. 🟠 Per-route bundle budgets in `pledge build`.** Warn when a route's
client JS exceeds a configurable budget (default ~170KB gzip); JS weight is
the dominant CWV risk in SSR frameworks.

**48. 🟠 `pledge seo audit` CLI.** Crawl the built/standalone output (we own
the server — just request every route), report missing/duplicate titles,
descriptions, canonicals, broken og:image URLs, missing alt text, mixed
content. The check:release equivalent for SEO.

**49. 🟡 Sitemap `lastmod` from git mtime.** `git log -1 --format=%cI` per
route file → accurate `lastmod` (better crawl scheduling than build time).

**50. 🟡 SEO/GEO fixture suite.** E2E fixtures asserting rendered `<head>`
output, sitemap.xml/robots.txt/llms.txt bytes, JSON-LD validity, canonical
redirects — executed against real responses, same philosophy as the
pledgepack executed-output e2e suite. No SEO claim ships without it.

---

## Sequencing

- **Do first (parity):** 1–5, 13–16, 23–24, 31, 45 — these close the
  "why does my site not index like a Next.js site" gap.
- **Differentiation:** 35–44 (GEO tier) — cheap to implement (route scanner
  + MDX + JSON-LD all exist) and genuinely novel.
- **Verification last-but-mandatory:** 48 + 50 give every other goal its
  regression net.
