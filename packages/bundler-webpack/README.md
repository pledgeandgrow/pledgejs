# pledgestack-bundler-webpack

Webpack bundler adapter for PledgeStack. It implements the `BundlerAdapter` interface from `pledgestack-shared` (production build, dev server, single-file transform, production path resolution) so `pledge build` / `pledge dev` can run on Webpack instead of the default PledgePack.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-bundler-webpack webpack webpack-dev-server
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// pledge.config.ts
import { defineConfig } from 'pledgestack';

export default defineConfig({
  bundler: 'webpack',
});
```

The CLI resolves the adapter by name; you can also use it directly:

```ts
import { webpackAdapter } from 'pledgestack-bundler-webpack';

const result = await webpackAdapter.build(config);
if (!result.success) console.error(result.error);
```

## API

- `webpackAdapter` (also the default export): `{ name, build(config), startDevServer(config, options), transformFile(path, options), resolveProductionPath(path, config) }`

## Notes

With `webpack-dev-server` installed the dev server has HMR (`hot: true`); otherwise an esbuild-based fallback server is used (no HMR).

## License

MIT
