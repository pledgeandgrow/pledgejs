# pledgestack-bundler-pledgepack

PledgePack bundler adapter for PledgeStack — the default bundler. Wraps the native `pledgepack` binary for builds and the dev server, adds server-module bundling, and delegates single-file transforms (including `.psx`) to `pledgestack-server`.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-bundler-pledgepack pledgepack
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { pledgepackAdapter, resolveBinary } from 'pledgestack-bundler-pledgepack';

if (!resolveBinary()) throw new Error('pledgepack binary missing — run "pnpm rebuild pledgepack"');
const result = await pledgepackAdapter.build(config);
```

## API

- `pledgepackAdapter` (default export) — `build`, `startDevServer`, `transformFile`, `resolveProductionPath` (route manifest first, then path heuristics).
- `resolveBinary()`, `runPledgepack(args)` — locate and run the native binary.

## Notes

The native binary is downloaded by the `pledgepack` package postinstall; allow its build script in pnpm (`allowBuilds`).

## License

MIT
