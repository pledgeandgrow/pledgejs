# pledgestack-bundler-rsbuild

Rsbuild bundler adapter for PledgeStack. It implements the `BundlerAdapter` interface from `pledgestack-shared` (production build, dev server, single-file transform, production path resolution) so `pledge build` / `pledge dev` can run on Rsbuild instead of the default PledgePack.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-bundler-rsbuild @rsbuild/core
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// pledge.config.ts
import { defineConfig } from 'pledgestack';

export default defineConfig({
  bundler: 'rsbuild',
});
```

The CLI resolves the adapter by name; you can also use it directly:

```ts
import { rsbuildAdapter } from 'pledgestack-bundler-rsbuild';

const result = await rsbuildAdapter.build(config);
if (!result.success) console.error(result.error);
```

## API

- `rsbuildAdapter` (also the default export): `{ name, build(config), startDevServer(config, options), transformFile(path, options), resolveProductionPath(path, config) }`

## Notes

When `@rsbuild/core` is not installed the adapter falls back to an esbuild-based build and dev server (no HMR).

## License

MIT
