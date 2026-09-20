# pledgestack-renderer-svelte

Svelte 5 renderer adapter for PledgeStack: renders compiled server components (`render()` -> html/head/css), composes layouts and emits a `hydrate` client script.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-renderer-svelte svelte
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { SvelteRendererAdapter } from 'pledgestack-renderer-svelte';

const adapter = new SvelteRendererAdapter();
const html = await adapter.renderToString(ctx);
```

## API

- `SvelteRendererAdapter` (`framework: 'svelte'`, `.svelte` pages): `renderToString`, `renderToStream`, `renderToReadableStream`, `renderNotFound`, `prerenderStaticShell`, `generateClientScript`.

## Notes

RSC is React-only and not implemented. The `pledgestack` CLI already bundles this adapter.

## License

MIT
