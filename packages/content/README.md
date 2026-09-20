# pledgestack-content

Typed content collections for PledgeStack: load Markdown/MDX files from a directory, validate their frontmatter against a small schema, and query them at build or render time.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-content
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// pledge.config.ts
import { defineConfig } from 'pledgestack';
import { contentPlugin } from 'pledgestack-content';

export default defineConfig({
  plugins: [
    contentPlugin({
      collections: {
        posts: { directory: 'content/posts', schema: { title: 'string', date: 'date', draft: 'boolean?' } },
      },
    }),
  ],
});

// app/blog/page.tsx
import { getCollection, query } from 'pledgestack-content';
const recent = query(getCollection('posts')).sort((a, b) => String(b.data.date).localeCompare(String(a.data.date))).limit(10).toArray();
```

## API

- `contentPlugin({ collections })` — loads collections during `buildStart`.
- `loadCollection`, `getCollection`, `getEntry`, `getAllCollectionNames`, `query(entries)` (chainable `filter` / `sort` / `skip` / `limit` / `toArray`).
- `parseFrontmatter`, `validateEntry`, `renderMarkdown`, `compileMdx`, `registerMdxComponents`, `setBodyRenderer` (swap in a full MDX/Markdown compiler).

## Notes

The built-in Markdown/MDX renderer is a lightweight first-party compiler; use `setBodyRenderer` to plug in remark/MDX for full syntax coverage.

## License

MIT
