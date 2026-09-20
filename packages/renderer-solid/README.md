# pledgestack-renderer-solid

Solid renderer adapter for PledgeStack: server rendering through `solid-js/web` (`renderToStringAsync`), layout composition and a `hydrate` client script that reuses the server route params.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-renderer-solid solid-js
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { SolidRendererAdapter } from 'pledgestack-renderer-solid';

const adapter = new SolidRendererAdapter();
const html = await adapter.renderToString(ctx);
```

## API

- `SolidRendererAdapter` (`framework: 'solid'`, `.tsx` pages compiled with the Solid JSX transform): `renderToString`, `renderToStream`, `renderToReadableStream`, `renderNotFound`, `prerenderStaticShell`, `generateClientScript`.

## Notes

RSC is React-only and not implemented. The `pledgestack` CLI already bundles this adapter.

## License

MIT
