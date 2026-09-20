# pledgestack-renderer-vue

Vue 3 renderer adapter for PledgeStack: server rendering through `vue/server-renderer`, nested layouts, metadata, and a `createSSRApp` hydration script that mounts with the server route params.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-renderer-vue vue
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { VueRendererAdapter } from 'pledgestack-renderer-vue';

const adapter = new VueRendererAdapter();
const html = await adapter.renderToString(ctx);
```

## API

- `VueRendererAdapter` (`framework: 'vue'`, `.vue` pages): `renderToString`, `renderToStream`, `renderToReadableStream`, `renderNotFound`, `prerenderStaticShell`, `generateClientScript`.

## Notes

RSC is React-only and not implemented. The `pledgestack` CLI already bundles this adapter.

## License

MIT
