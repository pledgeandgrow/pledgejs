# pledgestack-bundler-rollup

Rollup bundler adapter for PledgeStack. It implements the `BundlerAdapter` interface from `pledgestack-shared` (production build, dev server, single-file transform, production path resolution) so `pledge build` / `pledge dev` can run on Rollup instead of the default PledgePack.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-bundler-rollup rollup
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// pledge.config.ts
import { defineConfig } from 'pledgestack';

export default defineConfig({
  bundler: 'rollup',
});
```

The CLI resolves the adapter by name; you can also use it directly:

```ts
import { rollupAdapter } from 'pledgestack-bundler-rollup';

const result = await rollupAdapter.build(config);
if (!result.success) console.error(result.error);
```

## API

- `rollupAdapter` (also the default export): `{ name, build(config), startDevServer(config, options), transformFile(path, options), resolveProductionPath(path, config) }`

## Notes

Rollup is used for production builds. The dev server is a lightweight esbuild transform-on-request server without live reload (see docs/limitations.md).

## License

MIT
