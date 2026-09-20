# pledgestack-bundler-vite

Vite bundler adapter for PledgeStack. It implements the `BundlerAdapter` interface from `pledgestack-shared` (production build, dev server, single-file transform, production path resolution) so `pledge build` / `pledge dev` can run on Vite instead of the default PledgePack.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-bundler-vite vite
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// pledge.config.ts
import { defineConfig } from 'pledgestack';

export default defineConfig({
  bundler: 'vite',
});
```

The CLI resolves the adapter by name; you can also use it directly:

```ts
import { viteAdapter } from 'pledgestack-bundler-vite';

const result = await viteAdapter.build(config);
if (!result.success) console.error(result.error);
```

## API

- `viteAdapter` (also the default export): `{ name, build(config), startDevServer(config, options), transformFile(path, options), resolveProductionPath(path, config) }`

## Notes

The dev server is Vite's own (HMR enabled). `handle.reload(id)` invalidates a module and asks the browser to reload; `.psx`/`.ps` changes trigger a full reload.

## License

MIT
