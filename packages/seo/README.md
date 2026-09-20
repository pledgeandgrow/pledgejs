# pledgestack-seo

SEO helpers that generate escaped HTML for meta tags, Open Graph / Twitter cards and JSON-LD structured data.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-seo
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { generateMetaTags, generateJsonLd } from 'pledgestack-seo';

const head = generateMetaTags({
  title: 'My page',
  description: 'What it is',
  canonical: 'https://example.com/page',
  ogImage: 'https://example.com/og.png',
});
```

## API

- `generateMetaTags(input)` — title, description, canonical, robots, Open Graph and Twitter tags (all values HTML-escaped).
- `generateSocialCards(input)` — social card tags.
- `generateJsonLd(schema)` — JSON-LD for Organization, BreadcrumbList, Article, Product, FAQPage, WebSite, Person (script-safe serialization).

## License

MIT
