# pledgestack-renderer-react

React renderer adapter for PledgeStack: SSR (`renderToString`), streaming (`renderToPipeableStream`), React Server Components, PPR, error boundaries, layout/template/loading chains and the client hydration script.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-renderer-react react react-dom
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { ReactRendererAdapter } from 'pledgestack-renderer-react';
import { getRendererRegistry } from 'pledgestack-shared';

// Importing the package registers a ReactRendererAdapter automatically;
// the registry can be queried by framework name:
const adapter = getRendererRegistry().get('react') ?? new ReactRendererAdapter();
const html = await adapter.renderToString(ctx);
```

## API

- `ReactRendererAdapter` implements `RendererAdapter`: `renderToString`, `renderToStream`, `renderToReadableStream`, `renderNotFound`, `renderRSC`, `renderRSCStream`, `prerenderStaticShell`, `renderDynamicHoles`, `generateClientScript`.
- `Link` — re-export of the client-side link component.

## Notes

Optional: `react-server-dom-webpack` for RSC. The `pledgestack` CLI already bundles this adapter.

## License

MIT
